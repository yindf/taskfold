/**
 * Compact Region tools — preset plugin (stage-2 solidified form).
 *
 * Ships inside the preset directory and is referenced by a relative row
 * (`./plugins/compact-region.mjs`) inside the `compaction` isolate group,
 * so `ctx.compaction` resolves to this realm's engine directly.
 *
 * Registers five model tools plus task-lifecycle prompt guidance:
 *   compact / compact_inspect            — manual, position-based compaction
 *   task_begin / task_end / task_commit  — task-lifecycle compaction (LIFO stack)
 *
 * Zero module dependencies: every capability arrives through `inject`.
 *
 * Mark-stack persistence: the `taskMarks` session projection DERIVES the
 * open-mark stack from harness-native events only — `assistant/message`
 * (tool-call blocks named task_begin/task_end register a pending intent
 * keyed by callId) and `tool/result` (the rendered text decides success;
 * success pushes/pops). No custom event types are ever appended: the
 * harness read side refuses unknown event types that are not marked
 * `ignorable`, and the write side has no API to set that flag, so a custom
 * `task/mark` event (the v1 design) made sessions unloadable after the
 * 0.1.2-alpha.3 upgrade. Marks survive host restarts and session resume
 * because the event log is append-only and folds do not remove events.
 * Unlike the stock `todos` projection, marks deliberately do NOT reset on
 * `turn/start` — tasks span user turns.
 *
 * Derivation contract with our own renderers (double-owned, stable):
 *   task_begin success text starts with 'Task mark set (depth '
 *   task_end   success text starts with 'Task ended' (state transition only;
 *              the reducer pops the mark AND records lastEnded {begin,end})
 *   failures start with 'task_begin failed' / 'task_end failed'
 * A failed or transient-failed task_end therefore KEEPS the mark, exactly
 * like the in-memory era.
 *
 * task_commit is the explicit, INLINE consumer of lastEnded: it folds the
 * ended task's full span (begin pair + body + end pair) from its own execute
 * context — the session loop is naturally paused there, so no listener,
 * timer, agent stash, or maintenance call is involved. The task_end result
 * being inside the folded range means the summarizer sees the COMPLETED task
 * (no stale "call task_end" pending, no temporal blind spot).
 *
 * Todo bridge: reads the stock `todos` projection (registered by the
 * `dsh-tool-todo` row) and nudges the model through runtime context — call
 * task_begin when a todo item is in progress without a mark, call task_end
 * when marks outlive the in-progress list, and task_commit when an ended
 * task awaits its fold. The todo tool itself is never wrapped or replaced.
 */

// TEMP DIAGNOSTIC removed during two-tool refactor.

/** Session-projection key under which the open-mark stack is published. */
export const TASK_MARKS_KEY = 'taskMarks'

/**
 * Structural stand-in for a zod schema: the projection registry only ever
 * calls `.parse(value)` on persisted rows, so a hand validator satisfies the
 * contract without importing zod (whose module resolution from a preset
 * directory is not guaranteed). Throws on malformed state, returns it as-is
 * otherwise. v2 state: null, or { pending: { [callId]: {kind, anchorSeq} },
 * marks: [seq...] }.
 */
export const taskMarksStateSchema = {
  parse(value) {
    if (value === null) return null
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('taskMarks state must be null or { pending, marks }')
    }
    const pending = value.pending
    const marks = value.marks
    if (pending === undefined || pending === null || typeof pending !== 'object' || Array.isArray(pending)) {
      throw new Error('taskMarks state .pending must be an object keyed by callId')
    }
    if (!Array.isArray(marks)) throw new Error('taskMarks state .marks must be an array')
    for (const key of Object.keys(pending)) {
      const entry = pending[key]
      if (entry === null || typeof entry !== 'object') throw new Error('taskMarks pending entries must be objects')
      if (entry.kind !== 'begin' && entry.kind !== 'end') throw new Error('taskMarks pending kind must be begin|end')
      if (!Number.isInteger(entry.anchorSeq) || entry.anchorSeq <= 0) {
        throw new Error('taskMarks pending anchorSeq must be a positive integer')
      }
    }
    for (const seq of marks) {
      if (!Number.isInteger(seq) || seq <= 0) {
        throw new Error('taskMarks state .marks must contain positive integer seqs (got ' + String(seq) + ')')
      }
    }
    if (value.lastEnded !== undefined) {
      const le = value.lastEnded
      if (le === null || typeof le !== 'object' || !Number.isInteger(le.beginSeq) || le.beginSeq <= 0
        || !Number.isInteger(le.endSeq) || le.endSeq <= 0) {
        throw new Error('taskMarks state .lastEnded must be { beginSeq, endSeq } positive integers')
      }
    }
    return value
  }
}

function emptyTaskMarksState() {
  return { pending: Object.create(null), marks: [] }
}

function isTaskResultText(block) {
  return block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string'
}

/**
 * Reducer for the `taskMarks` projection (v2, derived state):
 *  - `assistant/message`: every tool-call block named task_begin/task_end
 *    registers a pending intent { kind, anchorSeq: this message's seq }
 *    keyed by the block's callId.
 *  - `tool/result`: when a tool-result block's toolCallId matches a pending
 *    intent, its rendered text decides: success prefixes push (begin) or pop
 *    (end); anything else (failures, transient errors) changes nothing.
 *  - legacy `task/mark` events (v1 whole-value snapshots) are AUTHORITATIVE
 *    RESET points: they replace the whole stack AND clear pending. This
 *    baselines away pre-v2 ghosts — e.g. the v0-era task_abort mutated only
 *    plugin memory and left no log trace, so pure derivation would carry a
 *    phantom mark forever. v1 wrote a full snapshot between every call and
 *    its result, so the reset also consumes the interleaved pending intent.
 *  - `turn/start` does NOT reset the stack — tasks span user turns.
 */
export function applyTaskMarks(state, event) {
  if (event === null || typeof event !== 'object') return state
  if (event.type === 'task/mark') {
    const marks = event.data !== null && typeof event.data === 'object' && Array.isArray(event.data.marks)
      ? event.data.marks
      : null
    if (marks === null) return state
    return normalizeTaskMarks({ pending: Object.create(null), marks: marks.slice() })
  }
  if (event.type === 'compaction/summary') {
    // A fold whose shadowed range covers lastEnded.endSeq has folded the ended
    // task (the end result sits inside the range): the pending fold request
    // is satisfied — drop it. Other folds leave it alone.
    if (state === null || state.lastEnded === undefined) return state
    const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
    const endSeq = state.lastEnded.endSeq
    const inSeqs = Array.isArray(data.shadowedSeqs) && data.shadowedSeqs.indexOf(endSeq) !== -1
    const range = data.shadowedRange !== null && typeof data.shadowedRange === 'object' ? data.shadowedRange : null
    const inRange = range !== null && Number.isInteger(range.start) && Number.isInteger(range.end)
      && range.start <= endSeq && endSeq <= range.end
    if (!inSeqs && !inRange) return state
    const next = cloneTaskMarks(state)
    delete next.lastEnded
    return normalizeTaskMarks(next)
  }
  if (event.type === 'assistant/message') {
    const message = event.data !== null && typeof event.data === 'object' && event.data.message !== null
      && typeof event.data.message === 'object' ? event.data.message : null
    const content = message !== null && Array.isArray(message.content) ? message.content : []
    const seq = Number.isInteger(event.seq) ? event.seq : 0
    let next = null
    for (const block of content) {
      if (block === null || typeof block !== 'object' || block.type !== 'tool-call') continue
      if (block.name !== 'task_begin' && block.name !== 'task_end') continue
      if (next === null) next = cloneTaskMarks(state)
      next.pending[String(block.id)] = { kind: block.name === 'task_begin' ? 'begin' : 'end', anchorSeq: seq }
    }
    return next === null ? state : next
  }
  if (event.type === 'tool/result') {
    // Real persisted shape (probed from a live log): data.message has NO
    // callId field — linkage lives in tool-result blocks:
    //   message.content[] = { type: 'tool-result', toolCallId, content: [{type:'text',text}], isError }
    const message = event.data !== null && typeof event.data === 'object' && event.data.message !== null
      && typeof event.data.message === 'object' ? event.data.message : null
    const blocks = message !== null && Array.isArray(message.content) ? message.content : []
    let next = null
    for (const block of blocks) {
      if (block === null || typeof block !== 'object' || block.type !== 'tool-result') continue
      if (typeof block.toolCallId !== 'string') continue
      const base = next === null ? state : next
      const pending = base === null || base.pending === undefined ? undefined : base.pending
      const intent = pending === undefined ? undefined : pending[block.toolCallId]
      if (intent === undefined) continue
      if (next === null) next = cloneTaskMarks(base)
      delete next.pending[block.toolCallId]
      const text = Array.isArray(block.content)
        ? block.content.filter(isTaskResultText).map((b) => b.text).join('\n')
        : ''
      if (intent.kind === 'begin' && text.indexOf('Task mark set (depth ') === 0) {
        next.marks.push(intent.anchorSeq)
      } else if (intent.kind === 'end' && text.indexOf('Task ended') === 0 && next.marks.length > 0) {
        const beginSeq = next.marks.pop()
        // Record the ended task's span for the follow-up fold listener: the
        // begin pair (anchor assistant message) through this very result
        // event. The fold itself is NOT part of task_end's execute — the
        // result must land in the log first so the summarizer can see the
        // task's complete lifecycle (no temporal blind spot).
        next.lastEnded = { beginSeq, endSeq: Number.isInteger(event.seq) ? event.seq : 0 }
      }
    }
    return next === null ? state : normalizeTaskMarks(next)
  }
  return state
}

/**
 * Empty stacks with no pending fold normalize back to the null init state.
 * `lastEnded` (a task that ended and awaits its follow-up fold) keeps the
 * state alive even with an empty stack.
 */
function normalizeTaskMarks(state) {
  const noPending = Object.keys(state.pending).length === 0
  if (noPending && state.marks.length === 0 && state.lastEnded === undefined) return null
  return state
}

function cloneTaskMarks(state) {
  const base = state === null ? emptyTaskMarksState() : state
  const pending = Object.create(null)
  const source = base.pending !== undefined ? base.pending : Object.create(null)
  for (const key of Object.keys(source)) pending[key] = source[key]
  const next = { pending, marks: base.marks !== undefined ? base.marks.slice() : [] }
  if (base.lastEnded !== undefined) next.lastEnded = { beginSeq: base.lastEnded.beginSeq, endSeq: base.lastEnded.endSeq }
  return next
}

/**
 * Human-facing depth tail for task_end success texts. Depth 0 must read as
 * unambiguous closure ("all marks closed"), never "0 mark(s) still open" —
 * that phrasing made readers think the mark survived the call.
 */
function depthPhrase(depth) {
  const d = Number.isInteger(depth) ? depth : 0
  return d <= 0 ? ' — all marks closed' : ' — ' + d + ' outer mark(s) still open'
}

export default {
  name: 'compact-region',
  inject: ['compaction', 'tools', 'systemPrompt', 'sessionProjections'],
  apply(ctx) {
    const PREVIEW_LIMIT = 60
    const TAIL_WINDOW = 50

    // Native-event derivation folds into this projection; the registration's
    // disposer rides the plugin fiber, so it unloads with us. stateVersion 4
    // discards persisted rows from earlier reducer generations (v1
    // whole-value era; buggy v2 result matching; v3 pre-lastEnded shape) and
    // folds fresh from the log.
    ctx.sessionProjections.register({
      key: TASK_MARKS_KEY,
      stateSchema: taskMarksStateSchema,
      init: () => null,
      apply: applyTaskMarks,
      stateVersion: 4
    })

    // ── ended-task state (consumed by the explicit task_commit tool) ──────
    // task_end's execute only transitions state; the projection records the
    // ended task's full span in `lastEnded` (persisted, restart-safe). The
    // explicit `task_commit` tool — NOT a listener, timer, or maintenance
    // call — later folds that span inline from its own execute, where the
    // session loop is naturally paused. `lastEnded` is pure data here, never
    // a trigger.

    function lastEndedOf(session) {
      try {
        const state = ctx.sessionProjections.stateOf(session, TASK_MARKS_KEY)
        if (state === undefined || state === null || state.lastEnded === undefined) return undefined
        const le = state.lastEnded
        return Number.isInteger(le.beginSeq) && Number.isInteger(le.endSeq) ? { beginSeq: le.beginSeq, endSeq: le.endSeq } : undefined
      } catch (err) {
        return undefined
      }
    }

    // Current open-mark stack for one session, as an array (empty when none).
    function marksOf(session) {
      try {
        const state = ctx.sessionProjections.stateOf(session, TASK_MARKS_KEY)
        if (state === undefined || state === null) return []
        return Array.isArray(state.marks) ? state.marks : []
      } catch (err) {
        return []
      }
    }

    function textPreview(content) {
      if (!Array.isArray(content)) return ''
      for (const block of content) {
        if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
          return block.text.replace(/\s+/g, ' ').slice(0, PREVIEW_LIMIT)
        }
      }
      return ''
    }

    function indexEvents(events) {
      const map = new Map()
      for (const ev of events) {
        if (ev !== null && typeof ev === 'object' && Number.isInteger(ev.seq)) map.set(ev.seq, ev)
      }
      return map
    }

    function classify(event) {
      if (event.type === 'user/message') return { role: 'user', kind: 'message', delta: 0 }
      if (event.type === 'assistant/message') {
        const message = event.data && event.data.message ? event.data.message : null
        const content = message !== null && Array.isArray(message.content) ? message.content : []
        const toolCalls = content.filter((b) => b !== null && typeof b === 'object' && b.type === 'tool-call')
        const toolNames = toolCalls.map((t) => (t !== null && typeof t === 'object' && typeof t.name === 'string') ? t.name : '').filter((n) => n.length > 0)
        return { role: 'assistant', kind: toolCalls.length > 0 ? 'tool_call' : 'assistant', delta: toolCalls.length, toolNames }
      }
      if (event.type === 'tool/result') return { role: 'user', kind: 'tool_result', delta: -1 }
      return { role: 'unknown', kind: 'other', delta: 0 }
    }

    function readSurface(session) {
      const nodes = session.surface.nodes
      const bySeq = indexEvents(session.events)
      const positions = []
      let open = 0
      let corrupt = false
      for (let i = 0; i < nodes.length; i += 1) {
        const seq = nodes[i]
        const event = bySeq.get(seq)
        // A user turn boundary re-baselines the pairing accounting: a valid
        // history always closes every tool pair before the next user message.
        // This keeps `corrupt` local instead of permanent — one missing event
        // disables edges only until the next user turn, not for the rest of
        // the session.
        if (event !== undefined && event.type === 'user/message') {
          open = 0
          corrupt = false
        }
        const canStartEdge = !corrupt && open === 0
        let view
        let preview = ''
        if (event === undefined) {
          view = { role: 'unknown', kind: 'missing', delta: 0 }
          corrupt = true
        } else {
          view = classify(event)
          try {
            const message = event.data && event.data.message ? event.data.message : null
            if (message !== null && Array.isArray(message.content)) preview = textPreview(message.content)
          } catch (err) {
            preview = ''
          }
        }
        open += view.delta
        if (open < 0) {
          corrupt = true
          open = 0
        }
        const position = {
          pos: i + 1,
          role: view.role,
          kind: view.kind,
          preview,
          canStartEdge,
          canEndEdge: !corrupt && open === 0
        }
        if (view.toolNames !== undefined && view.toolNames.length > 0) position.toolNames = view.toolNames.slice(0, 6)
        positions.push(position)
      }
      return { length: nodes.length, positions, corrupt }
    }

    function errText(err) {
      return err !== null && typeof err === 'object' && err.message ? String(err.message) : String(err)
    }

    function classifyCategory(err) {
      const message = errText(err)
      const code = err !== null && typeof err === 'object' && typeof err.code === 'string' ? err.code : null
      const known = ['busy', 'cancelled', 'changed', 'summary', 'commit', 'persistence']
      if (known.indexOf(code) !== -1) return { category: code, message }
      if (/not smaller/i.test(message)) return { category: 'summary', message }
      return { category: 'other', message }
    }

    function engineFor() {
      return ctx.compaction !== undefined && typeof ctx.compaction.compactRegion === 'function' ? ctx.compaction : undefined
    }

    function summaryTextOf(result) {
      let summary = ''
      if (result !== null && typeof result === 'object' && Array.isArray(result.summary)) {
        summary = result.summary
          .filter((b) => b !== null && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text)
          .join('\n')
      }
      return summary
    }

    const inspectTool = {
      name: 'compact_inspect',
      description: 'List the current conversation surface: 1-based positions, role, kind, preview, and whether each position can be a compaction start/end edge. Read-only. Call this before compact(start, end). By default shows the tail window when the surface is long; use from/to to inspect an older window.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'integer', description: 'Optional first position of the window to show, inclusive (1-based).' },
          to: { type: 'integer', description: 'Optional last position of the window to show, inclusive (1-based).' }
        }
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(args, value) {
          if (value.ok !== true) {
            return [{ type: 'text', text: 'compact_inspect failed: ' + String(value.error === undefined ? 'unknown error' : value.error) }]
          }
          const lines = []
          const first = value.omittedBefore + 1
          const last = value.omittedBefore + value.positions.length
          lines.push('Surface length: ' + value.length + ' (showing positions ' + first + '..' + last + ')')
          if (value.corrupt === true) lines.push('WARNING: part of the surface fold is corrupt (tool result without a preceding call, or missing event); edge flags are unreliable from the break until the next user-message boundary.')
          for (const p of value.positions) {
            const flags = (p.canStartEdge ? 'S' : '-') + (p.canEndEdge ? 'E' : '-')
            const tools = p.toolNames !== undefined && p.toolNames.length > 0 ? ' calls:' + p.toolNames.join(',') : ''
            lines.push('#' + p.pos + ' [' + flags + '] ' + p.role + '/' + p.kind + tools + ' ' + p.preview)
          }
          lines.push(String(value.hint === undefined ? '' : value.hint))
          return [{ type: 'text', text: lines.join('\n') }]
        }
      },
      async execute(args, exec) {
        const agent = exec.agent
        if (agent === undefined) return { ok: false, category: 'invalid', error: 'compact_inspect requires an agent context' }
        let snapshot
        try {
          snapshot = readSurface(agent.session)
        } catch (err) {
          return { ok: false, category: 'invalid', error: 'failed to read the session surface: ' + errText(err) }
        }
        const length = snapshot.length
        let from = 1
        let to = length
        const hasFrom = args !== null && typeof args === 'object' && Number.isInteger(args.from)
        const hasTo = args !== null && typeof args === 'object' && Number.isInteger(args.to)
        if (hasFrom || hasTo) {
          if (!hasFrom || !hasTo || args.from < 1 || args.to < args.from) {
            return { ok: false, category: 'invalid', error: 'invalid window: from=' + args.from + ', to=' + args.to + ' (need integers with 1 <= from <= to <= length ' + length + ')' }
          }
          if (args.from > length) {
            return { ok: false, category: 'invalid', error: 'window from=' + args.from + ' is beyond surface length ' + length }
          }
          from = args.from
          to = Math.min(args.to, length)
        } else if (length > TAIL_WINDOW) {
          from = length - TAIL_WINDOW + 1
        }
        const positions = snapshot.positions.slice(from - 1, to)
        return {
          ok: true,
          length,
          omittedBefore: from - 1,
          omittedAfter: length - to,
          corrupt: snapshot.corrupt,
          positions,
          hint: 'Valid compact(start,end) requires start<=end, canStartEdge[start]=true, canEndEdge[end]=true; positions shift after any successful compact, so run compact_inspect again before each compact.'
        }
      }
    }

    const compactTool = {
      name: 'compact',
      description: 'Ad-hoc compaction escape hatch: compress an explicit range [start, end] of the conversation surface (1-based positions over the message list; system prompt and tool descriptions are NOT part of it) into one summary node. Prefer the task lifecycle (task_begin/task_end) for routine compaction; use compact only for ranges that do not align with task marks (unmarked history, a precise mid-task partial range, merging old summary nodes). Call compact_inspect first to read positions and valid boundaries; both edges must be tool-pairing balanced.',
      parameters: {
        type: 'object',
        properties: {
          start: { type: 'integer', description: 'First surface position to compact, inclusive (1-based).' },
          end: { type: 'integer', description: 'Last surface position to compact, inclusive (1-based).' }
        },
        required: ['start', 'end']
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(args, value) {
          if (value.ok !== true) {
            const category = value.category === undefined ? 'invalid' : String(value.category)
            const error = value.error === undefined ? 'unknown error' : String(value.error)
            const hint = value.hint === undefined ? '' : '\n' + String(value.hint)
            return [{ type: 'text', text: 'compact failed (' + category + '): ' + error + hint }]
          }
          return [{ type: 'text', text: 'Compacted surface positions ' + value.compacted.start + '..' + value.compacted.end + ' into one summary node (' + value.shadowedTokenCount + ' shadowed tokens estimated). Original entries stay archived in the event log — compact_recall reads them back by seq.\n\nSummary:\n' + String(value.summary) }]
        }
      },
      async execute(args, exec) {
        const agent = exec.agent
        if (agent === undefined) return { ok: false, category: 'invalid', error: 'compact requires an agent context' }
        const engine = engineFor()
        if (engine === undefined) return { ok: false, category: 'invalid', error: 'compaction service is unavailable in this composition' }
        const start = args.start
        const end = args.end
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
          return { ok: false, category: 'invalid', error: 'invalid range: start and end must be integers with 1 <= start <= end (got start=' + start + ', end=' + end + ')' }
        }
        const session = agent.session
        const nodes = session.surface.nodes
        if (end > nodes.length) {
          return { ok: false, category: 'invalid', error: 'position ' + end + ' is beyond the surface (current length ' + nodes.length + '); run compact_inspect first' }
        }
        let snapshot
        try {
          snapshot = readSurface(session)
        } catch (err) {
          return { ok: false, category: 'invalid', error: 'failed to read the session surface: ' + errText(err) }
        }
        const startView = snapshot.positions[start - 1]
        const endView = snapshot.positions[end - 1]
        if (startView === undefined || endView === undefined) {
          return { ok: false, category: 'invalid', error: 'positions not available; run compact_inspect first' }
        }
        if (!startView.canStartEdge) {
          return { ok: false, category: 'invalid', error: 'start position ' + start + ' is not a balanced boundary (it would split a tool call/result pair); run compact_inspect and pick a position with canStartEdge=true' }
        }
        if (!endView.canEndEdge) {
          return { ok: false, category: 'invalid', error: 'end position ' + end + ' is not a balanced boundary (it would split a step, or the step is still open — the current step\u0027s own assistant message cannot be compacted); run compact_inspect and pick a position with canEndEdge=true' }
        }
        try {
          const result = await engine.compactRegion(nodes[start - 1], nodes[end - 1], agent, exec.signal)
          return { ok: true, compacted: { start, end }, summary: summaryTextOf(result), shadowedTokenCount: result.shadowedTokenCount }
        } catch (err) {
          const classified = classifyCategory(err)
          const hints = {
            busy: 'a compaction lock is already active in this session; retrying is ineffective until the session starts a new lifecycle',
            changed: 'the surface changed during compaction; run compact_inspect and retry',
            summary: 'the summarizer could not produce a smaller summary; try a smaller range',
            cancelled: 'the compaction was cancelled',
            commit: 'the compaction did not commit cleanly',
            persistence: 'the durability checkpoint failed'
          }
          const hint = hints[classified.category]
          const base = { ok: false, category: classified.category, error: classified.message }
          return hint === undefined ? base : { ok: false, category: classified.category, error: classified.message, hint }
        }
      }
    }

    const taskBegin = {
      name: 'task_begin',
      description: 'Mark the start of a task on the current conversation surface. Call it alone in a step when a task begins. When the task is done — whether it produced a lot of work or almost none — call task_end: the innermost unfinished task is closed, and everything from just after this mark to just before task_end is summarized into one node automatically (positions are tracked for you; no numbers to remember). Tasks nest: each task_begin pushes a mark onto this session\u0027s stack, and task_end always ends the most recent unfinished task (innermost first).',
      parameters: { type: 'object', properties: {} },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(args, value) {
          if (value.ok !== true) return [{ type: 'text', text: 'task_begin failed: ' + String(value.error === undefined ? 'unknown error' : value.error) }]
          return [{ type: 'text', text: 'Task mark set (depth ' + value.depth + '). Call task_end alone in a step when this task completes.' }]
        }
      },
      async execute(args, exec) {
        const agent = exec.agent
        if (agent === undefined) return { ok: false, category: 'invalid', error: 'task_begin requires an agent context' }
        const session = agent.session
        let snapshot
        try {
          snapshot = readSurface(session)
        } catch (err) {
          return { ok: false, category: 'invalid', error: 'failed to read the session surface: ' + errText(err) }
        }
        const nodes = session.surface.nodes
        let markSeq = null
        // CONTRACT: the mark lands on the LAST assistant message on the
        // surface, which — because task_begin is called alone in a step — is
        // the assistant message of this very step. task_end then compacts
        // from the first balanced cut AFTER that seq, which sits just past
        // this step's tool results: the task_begin step itself is never part
        // of the range. If the executor ever appends another assistant
        // message within the same step, this anchoring must be revisited.
        for (let i = snapshot.positions.length - 1; i >= 0; i -= 1) {
          const kind = snapshot.positions[i].kind
          if (kind === 'assistant' || kind === 'tool_call') { markSeq = nodes[i]; break }
        }
        if (markSeq === null) return { ok: false, category: 'invalid', error: 'no assistant message found on the surface' }
        // No event is appended here: the projection derives the push from
        // this step's own assistant/message + the success text this tool is
        // about to return. marksOf() does not include the push yet (the
        // result event has not landed), so depth is stack + 1.
        const depth = marksOf(session).length + 1
        return { ok: true, depth }
      }
    }

    const taskEnd = {
      name: 'task_end',
      description: 'End the current (innermost unfinished) task. The mark is ALWAYS popped: the task is over. This call only transitions state and returns immediately; it does NOT fold anything. To compress the ended task into one summary node, call task_commit right after (its range covers the begin pair, body, and this task_end pair, so the summary reflects the completed task). If you skip task_commit now, the span stays on the surface and can be committed later. Outer marks stay active.',
      parameters: { type: 'object', properties: {} },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(args, value) {
          if (value.ok !== true) {
            const category = value.category === undefined ? 'invalid' : String(value.category)
            const error = value.error === undefined ? 'unknown error' : String(value.error)
            const hint = value.hint === undefined ? '' : '\n' + String(value.hint)
            const depth = value.depth === undefined ? '' : ' [open marks: ' + value.depth + ']'
            return [{ type: 'text', text: 'task_end failed (' + category + '): ' + error + hint + depth }]
          }
          // The 'Task ended' prefix is a MACHINE CONTRACT: the taskMarks
          // reducer pops on it (and records lastEnded from the anchor + this
          // result's seq).
          return [{ type: 'text', text: 'Task ended' + depthPhrase(value.depth) + '. Recorded for folding — call task_commit (alone in a step) to compress the complete task into one summary node now, or later; until committed the span stays on the surface.' }]
        }
      },
      async execute(args, exec) {
        const agent = exec.agent
        if (agent === undefined) return { ok: false, category: 'invalid', error: 'task_end requires an agent context' }
        const session = agent.session
        // Derived state does not yet reflect THIS call's pop — the result
        // event lands after execute returns, and only success texts ('Task
        // ended…') pop (and record lastEnded). marksOf() therefore still
        // holds the closing task.
        const stack = marksOf(session)
        if (stack.length === 0) return { ok: false, category: 'invalid', error: 'no active task mark; call task_begin first' }
        return { ok: true, depth: stack.length - 1 }
      }
    }

    const taskCommit = {
      name: 'task_commit',
      description: 'Fold the most recently ended task into one summary node. Fold INLINE, from its own execution context, the span recorded by task_end (the innermost `lastEnded` record): the task_begin pair, the body, AND the task_end pair. Because the task_end result is inside the range, the summary reflects the COMPLETED task with no stale "call task_end" pending. Call it alone in a step, right after task_end (or later — the record persists across restarts until committed). If the span was too small to summarize, it is left as-is. Pass `title` (a short imperative name) to label the fold in compact_stats/compact_recall listings.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Optional short task name (recommended ≤80 chars); labels the resulting fold.' }
        }
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(args, value) {
          if (value.ok !== true) {
            const category = value.category === undefined ? 'invalid' : String(value.category)
            const error = value.error === undefined ? 'unknown error' : String(value.error)
            const hint = value.hint === undefined ? '' : '\n' + String(value.hint)
            return [{ type: 'text', text: 'task_commit failed (' + category + '): ' + error + hint }]
          }
          const titleLine = value.title === undefined ? '' : '\nTitle: ' + String(value.title)
          return [{ type: 'text', text: 'Task committed into one summary node (' + value.shadowedTokenCount + ' shadowed tokens estimated).' + titleLine + '\n\nSummary:\n' + String(value.summary) }]
        }
      },
      async execute(args, exec) {
        const agent = exec.agent
        if (agent === undefined) return { ok: false, category: 'invalid', error: 'task_commit requires an agent context' }
        const engine = engineFor()
        if (engine === undefined) return { ok: false, category: 'invalid', error: 'compaction service is unavailable in this composition' }
        const session = agent.session
        const record = lastEndedOf(session)
        if (record === undefined) return { ok: false, category: 'invalid', error: 'no ended task awaiting a fold; call task_end first' }
        try {
          const result = await engine.compactRegion(record.beginSeq, record.endSeq, agent, exec.signal)
          const out = { ok: true, summary: summaryTextOf(result), shadowedTokenCount: result.shadowedTokenCount }
          if (args !== null && typeof args === 'object' && typeof args.title === 'string' && args.title.trim().length > 0) {
            const clean = args.title.replace(/\s+/g, ' ').trim().slice(0, 80)
            if (clean.length > 0) out.title = clean
          }
          return out
        } catch (err) {
          const classified = classifyCategory(err)
          if (classified.category === 'summary') {
            return { ok: false, category: 'summary', error: 'the ended task was too small to summarize ("' + classified.message + '"); its history stays on the surface as-is' }
          }
          const hint = classified.category === 'changed'
            ? 'the surface changed during the fold; retry task_commit (the record is recomputed from the log)'
            : classified.category === 'busy'
              ? 'a compaction lock is active; retry task_commit once it clears'
              : undefined
          return hint === undefined
            ? { ok: false, category: classified.category, error: classified.message }
            : { ok: false, category: classified.category, error: classified.message, hint }
        }
      }
    }

    ctx.tools.register(inspectTool)
    ctx.tools.register(compactTool)
    ctx.tools.register(taskBegin)
    ctx.tools.register(taskEnd)
    ctx.tools.register(taskCommit)

    ctx.systemPrompt.section({
      name: 'task-marker-compaction',
      order: 650,
      text: '## Task lifecycle compaction\n\nWhen you start a discrete task, call task_begin (alone in a step). When that task completes, call task_end (alone in a step): the task is closed (state transition only) and its full span — begin pair, body, end pair — is recorded for folding. Then call task_commit (alone in a step) to compress that span into one summary node; the summary sees the completed task, so it carries no stale "call task_end" pending. If the span is too small, task_commit reports it and the history stays as-is. Tasks nest as a stack: task_end always ends the innermost task, task_commit commits the innermost ended task. Never track message positions yourself; use compact(start, end) only for ranges that do not align with task marks.\n\nThe runtime context carries a todo bridge: when a todo item is in progress without a matching task mark it asks for task_begin, when the in-progress list shrank while marks remain open it asks for task_end, and when an ended task awaits its fold it asks for task_commit. Follow those nudges so task spans stay compactable.'
    })

    ctx.systemPrompt.context({
      name: 'todo-bridge',
      order: 130,
      text: (context) => {
        // Per-session state: the context callback receives { agent, scope,
        // signal }, so marks and todos are keyed to THIS session.
        const agent = context !== null && typeof context === 'object' ? context.agent : undefined
        if (agent === undefined) return ''
        let session
        try { session = agent.session } catch (err) { session = undefined }
        if (session === null || session === undefined) return ''
        const lines = []
        const ownDepth = marksOf(session).length
        // An ended task awaiting its fold is cross-tool state the model
        // cannot read from any single message — surface it as a nudge.
        if (lastEndedOf(session) !== undefined) {
          lines.push('Todo bridge: an ended task awaits its fold — call task_commit (alone in a step) to compress it into one summary node.')
        }
        // Deliberately NO standing "Open task marks: N" line: depth and the
        // closing reminder already ride in every task_begin/task_end result
        // text (and those texts ARE the state changes the reducer derives
        // from), so echoing them in a snapshot would re-inject after every
        // lifecycle call for no new information. This context exists ONLY
        // for the todo bridge — cross-state pairing the model cannot read
        // from any single message.
        // Read the stock `todos` projection when the todo tool is mounted.
        // The bridge engages only once the model has written a list this
        // turn (the projection is null between turn/start and the first
        // todo_write); undefined means the todo capability is absent, in
        // which case this context renders nothing at all.
        let todos
        try { todos = ctx.sessionProjections.stateOf(session, 'todos') } catch (err) { todos = undefined }
        if (Array.isArray(todos)) {
          const inProgress = todos.filter((t) => t !== null && typeof t === 'object' && t.status === 'in_progress')
          if (inProgress.length > ownDepth) {
            const names = inProgress.slice(0, 3).map((t) => '"' + String(t.content).slice(0, 60) + '"').join(', ')
            lines.push('Todo bridge: ' + (inProgress.length - ownDepth) + ' todo item(s) in progress (' + names + ') without a matching task mark. Call task_begin (alone in a step) so that task\u0027s span can be compacted when it finishes.')
          } else if (inProgress.length < ownDepth) {
            lines.push('Todo bridge: fewer todo items are in progress than there are open task marks. Call task_end (alone in a step) for each finished task to close and compact it.')
          }
        }
        return lines.join('\n')
      }
    })
  }
}
