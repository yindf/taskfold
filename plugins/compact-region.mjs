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

// Node builtins for the self-hosted engine's module resolution fallback.
import nodePath from 'node:path'
import nodeFs from 'node:fs'
import nodeUrl from 'node:url'

/** Session-projection key under which the open-mark stack is published. */
export const TASK_MARKS_KEY = 'taskMarks'

/**
 * Structural stand-in for a zod schema: the projection registry only ever
 * calls `.parse(value)` on persisted rows, so a hand validator satisfies the
 * contract without importing zod (whose module resolution from a preset
 * directory is not guaranteed). Throws on malformed state, returns it as-is
 * otherwise. v6 state: null, or { pending: { [callId]: {kind, anchorSeq} },
 * marks: [{seq, name}...] } with only non-empty names retained.
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
      if (entry.kind !== 'begin' && entry.kind !== 'end' && entry.kind !== 'commit') throw new Error('taskMarks pending kind must be begin|end|commit')
      if (!Number.isInteger(entry.anchorSeq) || entry.anchorSeq <= 0) {
        throw new Error('taskMarks pending anchorSeq must be a positive integer')
      }
    }
    for (const mark of marks) {
      if (mark === null || typeof mark !== 'object' || !Number.isInteger(mark.seq) || mark.seq <= 0 || typeof mark.name !== 'string') {
        throw new Error('taskMarks state .marks must contain { seq, name } objects (got ' + JSON.stringify(mark) + ')')
      }
    }
    if (value.lastEnded !== undefined) {
      const le = value.lastEnded
      if (le === null || typeof le !== 'object' || !Number.isInteger(le.beginSeq) || le.beginSeq <= 0
        || !Number.isInteger(le.endSeq) || le.endSeq <= 0 || typeof le.name !== 'string') {
        throw new Error('taskMarks state .lastEnded must be { beginSeq, endSeq, name }')
      }
    }
    // Nameless marks are unclosable legacy phantoms (v1 numeric coercions /
    // v4-era begins) — a named task_end can never match them, so they would
    // pin the depth above zero forever and suppress the no-task nudge. Drop
    // them here too (the reducer already drops them at fold time), so even a
    // persisted row carrying one self-heals on load.
    const named = marks.filter((m) => normalizeName(m.name) !== '')
    if (named.length !== marks.length || (value.lastEnded !== undefined && normalizeName(value.lastEnded.name) === '')) {
      const healed = { pending: value.pending, marks: named }
      if (value.lastEnded !== undefined && normalizeName(value.lastEnded.name) !== '') healed.lastEnded = value.lastEnded
      return healed
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
 * Normalize a task name: collapse whitespace, single line, trim. Names are
 * model-chosen keys — matching is on this normalized form so copy/paste from
 * the context listing never drifts.
 */
function normalizeName(raw) {
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : ''
}

/**
 * Extract the task name from a canonical lifecycle result text:
 *   'Task begun: NAME — …' / 'Task ended: NAME — …'
 * The em dash separates the name from the status tail. Returns '' when the
 * text does not start with `prefix` or carries no name.
 */
function taskNameFromText(text, prefix) {
  if (typeof text !== 'string' || text.indexOf(prefix) !== 0) return ''
  const rest = text.slice(prefix.length)
  const cut = rest.indexOf(' —')
  return normalizeName(cut === -1 ? rest : rest.slice(0, cut))
}

/**
 * Reducer for the `taskMarks` projection (v5, named derived state):
 *  - `assistant/message`: every tool-call block named task_begin/task_end
 *    registers a pending intent { kind, anchorSeq: this message's seq }
 *    keyed by the block's callId.
 *  - `tool/result`: when a tool-result block's toolCallId matches a pending
 *    intent, its rendered text decides: 'Task begun: NAME' pushes a named
 *    mark { seq, name }; 'Task ended: NAME' pops the MOST RECENT mark whose
 *    normalized name matches (name-keyed, self-documenting, no implicit-stack
 *    corruption — ending by name can't mis-close the wrong nesting level).
 *    Anything else changes nothing.
 *  - legacy `task/mark` events (v1 whole-value snapshots) are AUTHORITATIVE
 *    RESET points: replace the whole stack AND clear pending. v1 numeric seqs
 *    are DROPPED (not coerced to nameless marks): they predate the named-task
 *    era, can never be closed by name, and their spans are long folded. This
 *    baselines away pre-v2 ghosts.
 *  - `turn/start` does NOT reset the stack — tasks span user turns.
 */
export function applyTaskMarks(state, event) {
  if (event === null || typeof event !== 'object') return state
  if (event.type === 'task/mark') {
    const marks = event.data !== null && typeof event.data === 'object' && Array.isArray(event.data.marks)
      ? event.data.marks
      : null
    if (marks === null) return state
    // v5 objects with a non-empty name pass through; v1 numeric seqs and any
    // nameless mark are dropped — nameless marks are unclosable phantoms.
    const coerced = marks.map((m) => (typeof m === 'object' && m !== null && Number.isInteger(m.seq))
      ? { seq: m.seq, name: typeof m.name === 'string' ? normalizeName(m.name) : '' }
      : null).filter((m) => m !== null && m.name !== '')
    return normalizeTaskMarks({ pending: Object.create(null), marks: coerced })
  }
  if (event.type === 'compaction/summary') {
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
      if (block.name !== 'task_begin' && block.name !== 'task_end' && block.name !== 'task_commit') continue
      if (next === null) next = cloneTaskMarks(state)
      next.pending[String(block.id)] = {
        kind: block.name === 'task_begin' ? 'begin' : block.name === 'task_end' ? 'end' : 'commit',
        anchorSeq: seq
      }
    }
    return next === null ? state : next
  }
  if (event.type === 'tool/result') {
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
      if (intent.kind === 'begin' && text.indexOf('Task begun: ') === 0) {
        const name = taskNameFromText(text, 'Task begun: ')
        next.marks.push({ seq: intent.anchorSeq, name })
      } else if (intent.kind === 'end' && text.indexOf('Task ended: ') === 0) {
        const name = taskNameFromText(text, 'Task ended: ')
        // Pop the most recent mark whose normalized name matches — name-keyed
        // closing, LIFO only within the same name.
        let idx = -1
        for (let i = next.marks.length - 1; i >= 0; i -= 1) {
          if (next.marks[i].name === name) { idx = i; break }
        }
        if (idx !== -1) {
          const removed = next.marks.splice(idx, 1)[0]
          next.lastEnded = { beginSeq: removed.seq, endSeq: Number.isInteger(event.seq) ? event.seq : 0, name }
        }
      } else if (intent.kind === 'commit' && text.indexOf('task_commit failed (summary)') === 0) {
        // A too-small-to-fold verdict is TERMINAL: the span never grows after
        // end, so the record can never be committed. Treat the failure as a
        // durable abandonment — clear lastEnded so the uncommitted-backstop
        // nudge does not hold forever over an unfoldable span. Success
        // ('Task committed…') needs no rule here: the compaction/summary
        // event covering endSeq already clears the record.
        delete next.lastEnded
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
  const marks = (base.marks !== undefined ? base.marks : []).map((m) => ({ seq: m.seq, name: m.name }))
  const next = { pending, marks }
  if (base.lastEnded !== undefined) {
    next.lastEnded = { beginSeq: base.lastEnded.beginSeq, endSeq: base.lastEnded.endSeq, name: base.lastEnded.name }
  }
  return next
}

/**
 * Human-facing depth tail for task_end success texts. Depth 0 must read as
 * unambiguous closure ("all marks closed"), never "0 mark(s) still open" —
 * that phrasing made readers think the mark survived the call.
 */
/**
 * Cross-version event-log accessor: dsh ≤0.1.2-alpha.3 exposed the whole log
 * as session.events (array); alpha.4 replaced it with on-demand APIs —
 * session.snapshotEvents() returns a full array snapshot. Support both.
 */
export function sessionEvents(session) {
  if (session === undefined || session === null) return []
  if (Array.isArray(session.events)) return session.events
  if (typeof session.snapshotEvents === 'function') {
    try { return session.snapshotEvents() } catch (err) { return [] }
  }
  return []
}

function depthPhrase(depth) {
  const d = Number.isInteger(depth) ? depth : 0
  return d <= 0 ? ' — all marks closed' : ' — ' + d + ' outer mark(s) still open'
}

export default {
  name: 'compact-region',
  // NOTE: 'compaction' is deliberately NOT injected. The engine used to be a
  // hard requirement, which pinned this plugin to compositions carrying a
  // `dsh-compaction-basic` row in a realm this plugin shares (every agent
  // preset does, but the host/profile plane does not). engineFor() below now
  // resolves the engine lazily: it prefers an already-registered
  // ctx.compaction (preset realm), and when none exists (profile-level
  // install) it instantiates BasicCompactionEngine itself with auto:false —
  // the constructor registers no listeners in that mode, and cordis Service
  // registration makes it ctx.compaction for every later call. All other
  // dependencies (tools, systemPrompt, sessionProjections, and — via the
  // engine's own ctx use — tokenMeter/llm) are host-plane services.
  // 'compaction' is deliberately NOT injected (see engineFor below): direct
  // property access on an undeclared service THROWS in cordis ("cannot get
  // property without inject"), which is exactly what the live cmpct-lite test
  // exposed. The engine is resolved through ctx.get('compaction') instead
  // (the optional-accessor channel the engine itself uses for
  // toolResultPruner). tokenMeter/llm ARE injected because the self-hosted
  // engine instance reaches them through OUR ctx.
  inject: ['tools', 'systemPrompt', 'sessionProjections', 'tokenMeter', 'llm'],
  apply(ctx) {
    const PREVIEW_LIMIT = 60
    const TAIL_WINDOW = 50

    // Native-event derivation folds into this projection; the registration's
    // disposer rides the plugin fiber, so it unloads with us. stateVersion 7
    // discards persisted rows from earlier reducer generations — REQUIRED
    // whenever reducer BEHAVIOR changes, not just shape: the v6 abandonment
    // rule landed while the version stayed 6, so stale lastEnded rows kept
    // loading from disk instead of re-folding through the new rule.
    ctx.sessionProjections.register({
      key: TASK_MARKS_KEY,
      stateSchema: taskMarksStateSchema,
      init: () => null,
      apply: applyTaskMarks,
      stateVersion: 7
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
        return Number.isInteger(le.beginSeq) && Number.isInteger(le.endSeq) && typeof le.name === 'string'
          ? { beginSeq: le.beginSeq, endSeq: le.endSeq, name: le.name }
          : undefined
      } catch (err) {
        return undefined
      }
    }

    // Current open marks for one session: [{ seq, name }], empty when none.
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
      const bySeq = indexEvents(sessionEvents(session))
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

    // Engine resolution, self-hosting tier: prefer a realm-provided
    // ctx.compaction (preset compositions); when absent (profile/host plane,
    // or a preset with no compaction group), instantiate BasicCompactionEngine
    // ourselves. auto:false keeps the constructor side-effect-free; super(ctx)
    // then registers the instance as ctx.compaction, so construction happens
    // at most once and later calls reuse it.
    //
    // Module resolution: a bare-specifier import works when this plugin sits
    // inside a node_modules tree (profile npm install) but NOT from a bare
    // preset directory (the package lives in the host's npx cache). Fallback:
    // walk up from host anchors (process.argv[1], cwd) to a node_modules dir
    // containing the engine package, and import its lib entry by file URL.
    // If even that fails, fold-capable tools degrade to an honest error;
    // task_begin/task_end and the observability tools keep working.
    let selfEngine = undefined

    function engineCandidatePaths() {
      const anchors = []
      try {
        if (typeof process === 'object' && process !== null && Array.isArray(process.argv) && typeof process.argv[1] === 'string' && process.argv[1].length > 0) {
          anchors.push(nodePath.dirname(nodePath.resolve(process.argv[1])))
        }
      } catch (err) { /* ignore */ }
      try { anchors.push(nodePath.resolve(process.cwd())) } catch (err) { /* ignore */ }
      const dirs = []
      for (const anchor of anchors) {
        let dir = anchor
        for (let i = 0; i < 10; i++) {
          dirs.push(nodePath.join(dir, 'node_modules'))
          const parent = nodePath.dirname(dir)
          if (parent === dir) break
          dir = parent
        }
      }
      return dirs
    }

    async function importHostPackage(pkgName) {
      try { return await import(pkgName) } catch (err) { /* fall through */ }
      for (const dir of engineCandidatePaths()) {
        const pkgDir = nodePath.join(dir, '@deepseek-ai', pkgName.replace(/^@deepseek-ai\//, ''))
        let ok = false
        try { ok = nodeFs.statSync(pkgDir).isDirectory() } catch (err) { ok = false }
        if (!ok) continue
        return await import(nodeUrl.pathToFileURL(nodePath.join(pkgDir, 'lib', 'index.js')).href)
      }
      throw new Error(pkgName + ' is not resolvable from this install')
    }

    // SPAN-SCOPED summarization instruction. The stock COMPACTION_INSTRUCTION
    // is a continuity checkpoint ("let another model resume the work"): it
    // asks for the WHOLE conversation's Primary Request / Key Concepts /
    // Pending Jobs, so a folded task span comes back as a project-wide
    // summary stuffed with background the surrounding context already has.
    // Our folds want exactly the opposite: what happened IN THE SPAN.
    const SCOPED_SPAN_INSTRUCTION = [
      'You are summarizing ONE FOLDED SPAN of a longer session. The messages above are exactly that span; your summary replaces them for the model that continues this session.',
      'Summarize ONLY what the span contains — what was done, tried, decided, and produced. Do NOT restate project background, architecture, goals, or context the messages merely assume: the continuing model already has all of that from outside the span.',
      'Output EXACTLY this structure, terse bullets, "(none)" for empty sections:',
      '## What happened',
      '- [the work performed in this span, in order]',
      '## Changes',
      '- [exact file paths written or edited, commands run, key values]',
      '## Outcomes',
      '- [results, verdicts, failures and their meaning; anything a later step must know]',
      'Rules:',
      '- Preserve exact file paths, commands, error strings, identifiers, and numbers.',
      '- Do NOT mention summarization or compaction.',
      '- Output only the summary text: do not call any tool or take any other action.'
    ].join('\n')

    // Scoped summarizer engine: subclasses BasicCompactionEngine so that
    // regionDependencies()' dynamic dispatch reaches OUR summarize(), while
    // compactRegion's locking, validation, stability checks, and commit path
    // stay stock. The LLM call replicates summarizeWithLlm's envelope (same
    // replayed prefix → provider prefix-cache reuse; only the appended final
    // instruction differs).
    async function buildScopedEngine() {
      const engineMod = await importHostPackage('@deepseek-ai/dsh-compaction-basic')
      const Base = engineMod.default !== undefined ? engineMod.default : engineMod.BasicCompactionEngine
      if (typeof Base !== 'function') throw new Error('engine export missing')
      let Assembler = class { push() {} blocks() { return [] } }
      Assembler.prototype.finish = { kind: 'stop' }
      try {
        const llmMod = await importHostPackage('@deepseek-ai/dsh-llm')
        if (typeof llmMod.BlockAssembler === 'function') Assembler = llmMod.BlockAssembler
      } catch (err) { /* without the real assembler the summary will fail loudly */ }

      class ScopedEngine extends Base {
        async summarize(input, agent, signal) {
          const header = agent.session.requestHeader()
          const latest = header !== null && typeof header === 'object' && header.config !== undefined ? header.config : undefined
          const cfg = this.config
          const configured = typeof cfg.summarizationProvider === 'string' && cfg.summarizationProvider.length > 0
            ? { provider: cfg.summarizationProvider, model: cfg.summarizationModel }
            : undefined
          const agentTarget = agent.options !== undefined && typeof agent.options.provider === 'string' && agent.options.provider.length > 0
            && typeof agent.options.model === 'string' && agent.options.model.length > 0
            ? { provider: agent.options.provider, model: agent.options.model }
            : undefined
          const target = configured ?? latest ?? agentTarget
          if (target === undefined) throw new Error('no provider/model available for scoped summarization')
          const messages = [...input.messages, {
            role: 'user',
            content: [{ type: 'text', text: SCOPED_SPAN_INSTRUCTION }]
          }]
          const options = {
            provider: target.provider,
            model: target.model,
            messages,
            ...(input.system === undefined ? {} : { system: input.system }),
            ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
            maxTokens: cfg.maxTokens,
            sessionId: agent.session.id,
            purpose: 'compaction',
            ...(signal === undefined ? {} : { signal })
          }
          const assembler = new Assembler()
          for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
          const finish = assembler.finish
          if (finish !== undefined && (finish.kind === 'error' || finish.kind === 'aborted')) {
            throw new Error(finish.failure !== undefined && finish.failure.message !== undefined ? String(finish.failure.message) : String(finish.kind))
          }
          const rawOutput = assembler.blocks()
          const summary = rawOutput.filter((b) => b !== null && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
          if (!summary.some((b) => b.text.trim().length > 0)) throw new Error('summarization produced no text summary content')
          return {
            summary,
            rawOutput,
            llmStreamCall: true,
            provider: options.provider,
            model: options.model,
            maxTokens: cfg.maxTokens,
            ...(assembler.usage === undefined ? {} : { usage: assembler.usage })
          }
        }
      }

      // Shim ctx: the cordis Service base registers itself via
      // ctx.reflect.provide in the constructor — on a plain shim that is a
      // no-op, so our instance never collides with (or replaces) the realm
      // engine a preset row may have registered for AUTO compaction. The
      // engine's current-turn path touches only these fields.
      const shimCtx = {
        tokenMeter: ctx.tokenMeter,
        llm: ctx.llm,
        get: (name) => (typeof ctx.get === 'function' ? ctx.get(name) : undefined),
        reflect: { provide: () => {} }
      }
      return new ScopedEngine(shimCtx, { auto: false })
    }

    async function engineFor() {
      // Always the SCOPED instance — both tiers. A realm engine (preset row)
      // is deliberately NOT used by our folds: it runs the stock
      // continuity-checkpoint instruction. The realm instance keeps serving
      // AUTO compaction (pressure/overflow), where checkpoint semantics are
      // exactly right; our explicit folds (task_commit, compact) get span
      // summaries. The durable compaction lock is shared through the event
      // log, so the two instances stay mutually exclusive.
      if (selfEngine !== undefined) return selfEngine === null ? undefined : selfEngine
      try {
        selfEngine = await buildScopedEngine()
        return selfEngine
      } catch (err) {
        selfEngine = null
        return undefined
      }
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
          const range = value.range === undefined ? '' : ' Archived seqs ' + value.range.start + '..' + value.range.end + ' — call compact_recall({ from: ' + value.range.start + ', to: ' + value.range.end + ' }).'
          return [{ type: 'text', text: 'Compacted surface positions ' + value.compacted.start + '..' + value.compacted.end + ' into one summary node (' + value.shadowedTokenCount + ' shadowed tokens estimated).' + range + '\n\nSummary:\n' + String(value.summary) }]
        }
      },
      async execute(args, exec) {
        const agent = exec.agent
        if (agent === undefined) return { ok: false, category: 'invalid', error: 'compact requires an agent context' }
        const engine = await engineFor()
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
          return { ok: true, compacted: { start, end }, summary: summaryTextOf(result), shadowedTokenCount: result.shadowedTokenCount, range: { start: nodes[start - 1], end: nodes[end - 1] } }
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
      description: 'Begin a NAMED task. The name is the identity: call task_end({ name }) to close exactly that task, call task_commit to fold its full span. Call alone in a step.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short task name (identity key; recommended ≤80 chars).' }
        },
        required: ['name']
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(args, value) {
          if (value.ok !== true) return [{ type: 'text', text: 'task_begin failed: ' + String(value.error === undefined ? 'unknown error' : value.error) }]
          const openList = value.openNames.length <= 1 ? '' : ': ' + value.openNames.join(', ')
          return [{ type: 'text', text: 'Task begun: ' + value.name + ' — ' + value.openNames.length + ' open' + openList + '.' }]
        }
      },
      async execute(args, exec) {
        const agent = exec.agent
        if (agent === undefined) return { ok: false, category: 'invalid', error: 'task_begin requires an agent context' }
        const name = args !== null && typeof args === 'object' ? normalizeName(args.name) : ''
        if (name.length === 0) return { ok: false, category: 'invalid', error: 'task_begin requires a non-empty `name` (the identity key task_end will close by)' }
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
        // the assistant message of this very step. commit folds from that seq
        // through the task_end result. If the executor ever appends another
        // assistant message within the same step, this anchoring is revisited.
        for (let i = snapshot.positions.length - 1; i >= 0; i -= 1) {
          const kind = snapshot.positions[i].kind
          if (kind === 'assistant' || kind === 'tool_call') { markSeq = nodes[i]; break }
        }
        if (markSeq === null) return { ok: false, category: 'invalid', error: 'no assistant message found on the surface' }
        // No event appended: the projection derives the named push from this
        // step's assistant/message + the success text about to be returned.
        const existing = marksOf(session).map((m) => m.name)
        const openNames = existing.concat([name])
        const depth = openNames.length
        void markSeq
        return { ok: true, name, depth, openNames }
      }
    }

    const taskEnd = {
      name: 'task_end',
      description: 'End a NAMED task by name (always terminal; state transition only — the output carries the full state). Then call task_commit to fold the ended span; its fold range includes this end pair, so the summary sees the completed task. Call alone in a step.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name of the open task to close (same string given to its task_begin).' }
        },
        required: ['name']
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(args, value) {
          if (value.ok !== true) {
            const category = value.category === undefined ? 'invalid' : String(value.category)
            const error = value.error === undefined ? 'unknown error' : String(value.error)
            const hint = value.hint === undefined ? '' : '\n' + String(value.hint)
            return [{ type: 'text', text: 'task_end failed (' + category + '): ' + error + hint }]
          }
          return [{ type: 'text', text: 'Task ended: ' + value.name + ' — ' + (value.remainingNames.length > 0 ? value.remainingNames.length + ' open: ' + value.remainingNames.join(', ') : 'all closed') + '. Awaiting fold: call task_commit.' }]
        }
      },
      async execute(args, exec) {
        const agent = exec.agent
        if (agent === undefined) return { ok: false, category: 'invalid', error: 'task_end requires an agent context' }
        const name = args !== null && typeof args === 'object' ? normalizeName(args.name) : ''
        if (name.length === 0) return { ok: false, category: 'invalid', error: 'task_end requires a non-empty `name`' }
        const session = agent.session
        const marks = marksOf(session)
        // Match by name (most recent first); the reducer pops the same mark
        // when this success result lands (its text carries the name).
        let idx = -1
        for (let i = marks.length - 1; i >= 0; i -= 1) {
          if (marks[i].name === name) { idx = i; break }
        }
        if (idx === -1) {
          const open = marks.map((m) => m.name)
          return { ok: false, category: 'invalid', error: 'no open task named "' + name + '". Open tasks: ' + (open.length > 0 ? open.join(', ') : '(none)') }
        }
        const remainingNames = marks.filter((m, i) => i !== idx).map((m) => m.name)
        return { ok: true, name, remainingNames }
      }
    }

    const taskCommit = {
      name: 'task_commit',
      description: 'Fold the most recently ended task\u0027s full span (begin pair, body, end pair) into one summary node titled by the task name — the summary sees the completed task. Call alone in a step, right after task_end (the record persists until committed). Too-small spans are reported and left as-is.',
      parameters: { type: 'object', properties: {} },      output: {
        schema: { type: 'object', additionalProperties: true },
        render(args, value) {
          if (value.ok !== true) {
            const category = value.category === undefined ? 'invalid' : String(value.category)
            const error = value.error === undefined ? 'unknown error' : String(value.error)
            const hint = value.hint === undefined ? '' : '\n' + String(value.hint)
            return [{ type: 'text', text: 'task_commit failed (' + category + '): ' + error + hint }]
          }
          const range = value.range === undefined ? '' : ' Archived seqs ' + value.range.start + '..' + value.range.end + ' — call compact_recall({ from: ' + value.range.start + ', to: ' + value.range.end + ' }).'
          return [{ type: 'text', text: 'Task committed: ' + String(value.title) + ' (' + value.shadowedTokenCount + ' tokens shadowed).' + range }]
        }
      },
      async execute(args, exec) {
        const agent = exec.agent
        if (agent === undefined) return { ok: false, category: 'invalid', error: 'task_commit requires an agent context' }
        const engine = await engineFor()
        if (engine === undefined) return { ok: false, category: 'invalid', error: 'compaction service is unavailable in this composition' }
        const session = agent.session
        const record = lastEndedOf(session)
        if (record === undefined) return { ok: false, category: 'invalid', error: 'no ended task awaiting a fold; call task_end first' }
        try {
          const result = await engine.compactRegion(record.beginSeq, record.endSeq, agent, exec.signal)
          return { ok: true, summary: summaryTextOf(result), shadowedTokenCount: result.shadowedTokenCount, title: record.name, range: { start: record.beginSeq, end: record.endSeq } }
        } catch (err) {
          const classified = classifyCategory(err)
          if (classified.category === 'summary') {
            return { ok: false, category: 'summary', error: 'span too small to fold — record abandoned, history stays as-is' }
          }
          const short = classified.category === 'busy'
            ? 'compaction lock active — retry'
            : classified.category === 'changed'
              ? 'surface changed during fold — retry'
              : classified.category === 'commit'
                ? 'fold failed to commit — retry'
                : classified.message
          return { ok: false, category: classified.category, error: short }
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
      text: '## Task lifecycle compaction\n\nTasks are NAMED. Call task_begin({ name: "…" }) to open one (alone in a step); call task_end({ name }) to close it by name — a mismatch cannot corrupt other tasks; call task_commit to fold the full span (begin pair, body, end pair) into one summary node titled by the name, so the summary sees the completed task. Too-small spans are reported and left as-is. Use compact(start, end) only for ranges that do not align with task marks; never track message positions yourself.\n\nFold summaries are terse by design. When one lacks the detail you need — an exact change, a command output, an error string — call compact_recall to read the archived originals (the seq range rides every fold output; with no args it lists all folds). The log is append-only: nothing is ever lost.\n\nRuntime context may carry a todo bridge and lifecycle nudges: call task_begin when working with no task open, call task_end for a task 20+ rounds old, call task_commit for an ended-but-unfolded task. Follow them so task spans stay compactable.'
    })

    const TASK_TOOL_RE = /^(task_begin|task_end|task_commit|compact|compact_inspect|compact_stats|compact_recall|todo_write)$/

    function recentWorkCallCount(session) {
      // Count non-task tool calls in the last 10 assistant messages.
      // Event shape mirrors classify(): assistant/message events carry the
      // payload at data.message.content, and call blocks are 'tool-call'
      // (hyphen — NOT 'tool_call').
      const events = sessionEvents(session)
      let assistantSeen = 0
      let workCalls = 0
      for (let i = events.length - 1; i >= 0 && assistantSeen < 10; i--) {
        const e = events[i]
        if (e === null || typeof e !== 'object' || e.type !== 'assistant/message') continue
        assistantSeen++
        const message = e.data !== null && typeof e.data === 'object' && e.data.message !== null && typeof e.data.message === 'object' ? e.data.message : null
        const blocks = message !== null && Array.isArray(message.content) ? message.content : []
        for (const b of blocks) {
          if (b !== null && typeof b === 'object' && b.type === 'tool-call' && !TASK_TOOL_RE.test(String(b.name))) workCalls++
        }
      }
      return workCalls
    }

    // Model rounds since the most recent fold OUTCOME (a 'Task ended: '
    // result, a 'Task committed' result, or any 'task_commit failed'
    // verdict). Used to grace-suppress the begin-nudge right after a task
    // closes: the pending obligation there is task_commit, not task_begin.
    // Bounded backward scan; returns a large number when no outcome exists.
    function roundsSinceFoldOutcome(session) {
      const events = sessionEvents(session)
      const floor = Math.max(0, events.length - 300)
      for (let i = events.length - 1; i >= floor; i--) {
        const e = events[i]
        if (e === null || typeof e !== 'object' || e.type !== 'tool/result') continue
        if (!Number.isInteger(e.seq)) continue
        const message = e.data !== null && typeof e.data === 'object' && e.data.message !== null && typeof e.data.message === 'object' ? e.data.message : null
        const blocks = message !== null && Array.isArray(message.content) ? message.content : []
        for (const b of blocks) {
          if (b === null || typeof b !== 'object' || b.type !== 'tool-result') continue
          const text = Array.isArray(b.content)
            ? b.content.filter(isTaskResultText).map((x) => x.text).join('\n')
            : ''
          if (text.indexOf('Task ended: ') === 0 || text.indexOf('Task committed') === 0 || text.indexOf('task_commit failed') === 0) {
            return countAssistantSince(session, e.seq, 4)
          }
        }
      }
      return Number.MAX_SAFE_INTEGER
    }

    // Ages are measured in MODEL ROUNDS (assistant messages), not raw seq
    // distance: one tool call can append anywhere from a handful to thousands
    // of events, so seq deltas are meaningless as "time". The scan is bounded
    // (stops at `seq` or after `cap` hits), so cost per request is negligible.
    function countAssistantSince(session, seq, cap) {
      const events = sessionEvents(session)
      let count = 0
      for (let i = events.length - 1; i >= 0 && count < cap; i--) {
        const e = events[i]
        if (e === null || typeof e !== 'object') continue
        if (Number.isInteger(e.seq) && e.seq <= seq) break
        if (e.type === 'assistant/message') count++
      }
      return count
    }

    // HOLD semantics for lifecycle nudges: each nudge line renders for as    // long as its condition holds — no fire/cooldown cycle, so a nudge never
    // "fires then stops nagging". The snapshot engine is diff-driven: an
    // unchanged context render produces NO new snapshot, and a condition
    // clearing produces exactly one retraction snapshot. This only works
    // while the line text is BYTE-STABLE, so nudge wording past its
    // threshold is deliberately number-free ("20+ rounds", never "~23").

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
        // Only NAMED marks count: nameless entries are unclosable legacy
        // phantoms (self-healed at projection load, but guard here too).
        const marks = marksOf(session).filter((m) => m.name !== '')
        const ownDepth = marks.length
        // Deliberately NO standing "Open task marks: N" line: depth and the
        // closing reminder already ride in every task_begin/task_end result
        // text, so echoing them in a snapshot would re-inject after every
        // lifecycle call for no new information. The immediate "call
        // task_commit" reminder likewise rides in the task_end output; only
        // when the ended record has AGED past several rounds without a
        // commit does nudge 3 below speak up. This context exists ONLY for
        // cross-state signals the model cannot read from any single message.

        // ── Nudge 1: no task open but work is happening ─────────────────
        // Renders for as long as the model keeps making non-task tool calls
        // with no open task; retracts the moment a task begins (or the work
        // stops). ≥3 work calls in the last 10 assistant messages.
        // SUPPRESSED while a fold question is open: right after task_end
        // (or a commit verdict) the pending obligation is task_commit —
        // suggesting task_begin there is noise. Two guards: a lastEnded
        // record still awaiting its fold, and a 3-round grace after any
        // end/commit outcome (covers abandonment, where a too-small verdict
        // just cleared the record).
        if (ownDepth === 0 && lastEndedOf(session) === undefined
          && recentWorkCallCount(session) >= 3 && roundsSinceFoldOutcome(session) >= 3) {
          lines.push('Task lifecycle: no open task during tool work — call task_begin({ name: "…" }) if this is a discrete task.')
        }

        // ── Nudge 2: task open for a long time ─────────────────────────
        // Holds until the named task is closed — the wording is static
        // ("20+ rounds") so the held line is byte-stable and produces no
        // further snapshots while it waits.
        if (ownDepth > 0) {
          const newest = marks[marks.length - 1]
          const age = countAssistantSince(session, newest.seq, 21)
          if (age >= 20) {
            lines.push('Task lifecycle: task "' + newest.name + '" is 20+ rounds old — if done, call task_end({ name: "' + newest.name + '" }), then call task_commit.')
          }
        }

        // ── Nudge 3: ended but never committed ──────────────────────────
        // task_end's output carries the immediate reminder; if the model's
        // very next step is NOT task_commit, this backstop appears at once
        // (age >= 1 round) and HOLDS until the fold clears the record.
        // Byte-stable wording so the held line emits no further snapshots.
        const ended = lastEndedOf(session)
        if (ended !== undefined && ended.name !== '') {
          const sinceEnd = countAssistantSince(session, ended.endSeq, 2)
          if (sinceEnd >= 1) {
            lines.push('Task lifecycle: task "' + ended.name + '" ended but not folded — call task_commit.')
          }
        }

        // ── Todo bridge (existing) ─────────────────────────────────────
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
            lines.push('Todo bridge: in-progress todos (' + names + ') lack task marks — call task_begin for them.')
          } else if (inProgress.length < ownDepth) {
            lines.push('Todo bridge: open tasks exceed in-progress todos — call task_end for the finished ones.')
          }
        }
        return lines.join('\n')
      }
    })
  }
}
