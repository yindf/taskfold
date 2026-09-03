/**
 * Compact Region tools — plugin-bundle form (installed via `dsh plugin add`
 * at the profile level; cordis.patch.yml mounts this file at the host plane,
 * so the tools land in the global registry for every session of every
 * preset). No realm/isolate-group assumptions are made.
 *
 * Registers the task-lifecycle tools plus prompt guidance:
 *   task_begin / task_fold — named tasks; end closes AND folds in one call
 *
 * Zero module dependencies: every capability arrives through `inject`; the
 * compaction engine is self-hosted (see engineFor below).
 *
 * Close semantics (v3): LIFO — only the INNERMOST open task can be closed;
 * closing a blocked or unknown name fails atomically. Degraded closes: a
 * shadowed anchor or an unavailable engine still CLOSES the task, unfolded.
 * The foldDecision() export carries this whole decision as a pure function;
 * execute is an I/O shell.
 *
 * Mark-stack persistence: the `taskMarks` session projection DERIVES the
 * open-mark stack from harness-native events only — `assistant/message`
 * (tool-call blocks named task_begin/task_fold register a pending intent
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
 *   task_begin success text starts with 'Task begun: '
 *   task_fold  success text starts with 'Task folded: ' (pops the mark)
 *   failures start with 'task_begin failed' / 'task_fold failed'
 * A failed task_fold KEEPS the mark (atomic end-and-fold: nothing happened,
 * retry). Task names never contain ' —' (validTaskName): the delimiter that
 * taskNameFromText splits on, keeping the name render→parse round trip
 * lossless.
 *
 * task_fold folds [begin assistant message .. last surface node before its
 * own step] INLINE from its execute context — the session loop is naturally
 * paused there. The span cannot contain its own ending, so the scoped
 * summarizer instruction DECLARES completion ("this fold CLOSES the task
 * <name>") instead of showing it — owning the instruction removed the
 * constraint that once forced the two-phase end→commit split. The closing
 * name travels through a per-session Map (closingTasks), never through the
 * shared engine instance, so concurrent folds in different sessions of one
 * process cannot cross-contaminate.
 *
 * Todo bridge: detects todo_write calls in the event log (stateless) and
 * renders ONE transient runtime-context line on the round right after the
 * model updated its todo list — it reports the change plus the open task
 * roster and asks the model to keep task marks in sync (task_begin for new
 * work, task_fold for finished work). No conditional nagging: the decision
 * stays with the model. The todo tool itself is never wrapped or replaced.
 */

// Node builtins for the self-hosted engine's module resolution fallback.
import nodePath from 'node:path'
import nodeFs from 'node:fs'
import nodeUrl from 'node:url'
import nodeOs from 'node:os'

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
    if (typeof value !== 'object' || Array.isArray(value)) {
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
    for (const mark of marks) {
      if (mark === null || typeof mark !== 'object' || !Number.isInteger(mark.seq) || mark.seq <= 0 || typeof mark.name !== 'string') {
        throw new Error('taskMarks state .marks must contain { seq, name } objects (got ' + JSON.stringify(mark) + ')')
      }
    }
    const named = marks.filter((m) => normalizeName(m.name) !== '')
    if (named.length !== marks.length) return { pending: value.pending, marks: named }
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
 * Task-name validity: non-empty, and free of ' —' — the delimiter that
 * separates the name from the status tail in every lifecycle result text
 * ('Task begun: NAME — …'). A name containing it would be truncated by
 * taskNameFromText and could never be closed by its full form.
 */
export function validTaskName(name) {
  return typeof name === 'string' && name.length > 0 && name.indexOf(' —') === -1
}

/**
 * LIFO close resolution over the open-mark stack (marks are in stack order:
 * oldest first, newest last). Matches the MOST RECENT occurrence of `name`
 * (legacy snapshots may repeat names; the tool layer rejects duplicates, so
 * this rule only serves old logs). Returns:
 *   { status:'ok', mark }                    name is the stack top
 *   { status:'unknown', open:[names] }       no open mark carries this name
 *   { status:'lifo', mark, blocking:[names] } name exists but is not the top;
 *                                             blocking = names of the newer
 *                                             marks inside it, in order,
 *                                             deduplicated
 *   { status:'empty' }                       no open marks at all
 */
export function closeTarget(marks, name) {
  const list = Array.isArray(marks) ? marks : []
  if (list.length === 0) return { status: 'empty' }
  const top = list[list.length - 1]
  if (top.name === name) return { status: 'ok', mark: top }
  let idx = -1
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i].name === name) { idx = i; break }
  }
  if (idx === -1) return { status: 'unknown', open: list.map((m) => m.name) }
  const blocking = []
  for (let i = idx + 1; i < list.length; i += 1) {
    if (blocking.indexOf(list[i].name) === -1) blocking.push(list[i].name)
  }
  return { status: 'lifo', mark: list[idx], blocking }
}

/**
 * Full close/fold decision as a pure function (offline-testable; execute is
 * only an I/O shell around it). Order matters: tooSmall precedes the engine
 * check (a too-small span needs no engine), the anchor check precedes both
 * (a shadowed anchor cannot fold regardless). Returns one of:
 *   { action:'invalid', error }                      bad name / empty stack
 *   { action:'unknown', open:[names] }               no such open task
 *   { action:'lifo', blocking:[names] }              blocked by newer tasks
 *   { action:'unfolded', reason:'anchor'|'engine', mark }  close without folding
 *   { action:'tooSmall', mark }                      close, span left as-is
 *   { action:'fold', mark, startSeq, endSeq }        compactRegion inputs
 *
 * Region end: the LAST surface node — task_fold is an explicit close, so the
 * span runs up to the live edge and the task's final body message folds into
 * its own fold (not the parent's). Auto-compaction keeps its own last-node
 * margin; this boundary is task-fold-only. Defense: when `events` is passed
 * and the last node is the assistant message carrying this very task_fold
 * call (a host that commits the in-flight step before tool execution), the
 * end steps back to the previous node so the fold never shadows itself.
 */
export function foldDecision(marks, name, surfaceNodes, engineAvailable, events) {
  const list = Array.isArray(marks) ? marks : []
  const nodes = Array.isArray(surfaceNodes) ? surfaceNodes : []
  if (!validTaskName(name)) {
    // Legacy escape hatch: a mark whose stored name is EXACTLY this invalid
    // string (only possible from a legacy task/mark snapshot) may still be
    // closed — closing it removes it, self-healing the stack.
    const exact = list.some((m) => m !== null && typeof m === 'object' && m.name === name)
    if (!exact) {
      return { action: 'invalid', error: 'task names must be non-empty and must not contain " —" (the result-text delimiter)' }
    }
  }
  const target = closeTarget(list, name)
  if (target.status === 'empty') {
    return { action: 'invalid', error: 'no open tasks; call task_begin first' }
  }
  if (target.status === 'unknown') {
    return { action: 'unknown', open: target.open }
  }
  if (target.status === 'lifo') {
    return { action: 'lifo', blocking: target.blocking }
  }
  const mark = target.mark
  if (nodes.indexOf(mark.seq) === -1) {
    return { action: 'unfolded', reason: 'anchor', mark }
  }
  let endIdx = nodes.length - 1
  if (Array.isArray(events)) {
    const ev = events.find((e) => e !== null && typeof e === 'object' && e.seq === nodes[endIdx])
    if (ev !== undefined && ev.type === 'assistant/message' && Array.isArray(ev.content)
      && ev.content.some((b) => b !== null && typeof b === 'object' && b.type === 'tool-call' && b.name === 'task_fold')) {
      endIdx -= 1 // never fold the message carrying this fold call itself
    }
  }
  if (endIdx < 0 || nodes[endIdx] < mark.seq) {
    return { action: 'tooSmall', mark }
  }
  if (engineAvailable !== true) {
    return { action: 'unfolded', reason: 'engine', mark }
  }
  return { action: 'fold', mark, startSeq: mark.seq, endSeq: nodes[endIdx] }
}

/**
 * The transient todo-bridge line, rendered ONLY on the round right after
 * the model called todo_write (stateless call detection in the context
 * callback). Reports the change plus the open task roster; whether to
 * task_begin or task_fold stays the model's call — no conditional nagging.
 */
export function todoBridgeLine(openNames) {
  const names = Array.isArray(openNames) ? openNames.filter((n) => typeof n === 'string' && n !== '') : []
  const roster = names.length > 0 ? names.map((n) => '"' + n.replace(/"/g, "'") + '"').join(', ') : 'none'
  return 'Todo bridge: todos changed; open tasks: ' + roster + ' — keep task marks in sync: task_begin for new work, task_fold for finished work.'
}

/**
 * SPAN-SCOPED summarization instruction for task folds. The stock
 * COMPACTION_INSTRUCTION is a continuity checkpoint ("let another model
 * resume the work"): it asks for the WHOLE conversation's Primary Request /
 * Pending Jobs / Next Step, so a folded task span comes back as a
 * project-wide summary stuffed with background the surrounding context
 * already has — and its Pending/Next-Step sections would contradict the
 * fold's "this task is CLOSED" contract. Our folds want exactly the
 * opposite: what happened IN THE SPAN, with the span's user inputs and
 * pitfalls preserved as first-class sections (v2). Exported pure so tests
 * can pin the structure contract offline.
 */
export const FOLD_SUMMARY_INSTRUCTION = [
  'You are summarizing ONE FOLDED SPAN of a longer session. The messages above are exactly that span; your summary replaces them for the model that continues this session.',
  'Summarize ONLY what the span contains — what was done, tried, decided, and produced. Do NOT restate project background, architecture, goals, or context the messages merely assume: the continuing model already has all of that from outside the span.',
  'Output EXACTLY this structure, terse bullets, "(none)" for empty sections:',
  '## What happened',
  '- [the work performed in this span, in order]',
  '## User inputs & decisions',
  '- [the user\'s requests, corrections, rejections, answers, and approvals from THIS span, with the decision each produced; quote verbatim where the exact wording matters]',
  '## Changes',
  '- [exact file paths written or edited, commands run, key values]',
  '## Pitfalls & gotchas',
  '- [failed attempts and WHY they failed, workarounds adopted, environment traps (sandbox denials, platform quirks), and "do not do X again" lessons from this span]',
  '## Outcomes',
  '- [results, verdicts, failures and their meaning; anything a later step must know]',
  'Rules:',
  '- Preserve exact file paths, commands, error strings, identifiers, and numbers.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Pitfalls and their causes are the span\'s most reusable knowledge: never drop why something failed.',
  '- This summary is relayed to the user as the task\'s closing report: keep every section accurate and human-readable.',
  '- Do NOT mention summarization or compaction.',
  '- Output only the summary text: do not call any tool or take any other action.'
].join('\n')

/**
 * Extract the task name from a canonical lifecycle result text:
 *   'Task begun: NAME — …' / 'Task folded: NAME — …'
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
 * Reducer for the `taskMarks` projection (v6, named derived state):
 *  - `assistant/message`: every tool-call block named task_begin/task_fold
 *    registers a pending intent { kind, anchorSeq: this message's seq }
 *    keyed by the block's callId.
 *  - `tool/result`: when a tool-result block's toolCallId matches a pending
 *    intent, its rendered text decides: 'Task begun: NAME' pushes a named
 *    mark { seq, name }; 'Task folded: NAME' pops the MOST RECENT mark whose
 *    normalized name matches. The reducer stays name-keyed so logs recorded
 *    before the LIFO rule (or by future variants) replay unchanged; the
 *    TOOL layer (foldDecision) enforces LIFO on new calls — closing anything
 *    other than the innermost open task fails before any event is written.
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
  if (event.type === 'assistant/message') {
    const message = event.data !== null && typeof event.data === 'object' && event.data.message !== null
      && typeof event.data.message === 'object' ? event.data.message : null
    const content = message !== null && Array.isArray(message.content) ? message.content : []
    const seq = Number.isInteger(event.seq) ? event.seq : 0
    let next = null
    for (const block of content) {
      if (block === null || typeof block !== 'object' || block.type !== 'tool-call') continue
      if (block.name !== 'task_begin' && block.name !== 'task_fold') continue
      if (next === null) next = cloneTaskMarks(state)
      next.pending[String(block.id)] = {
        kind: block.name === 'task_begin' ? 'begin' : 'end',
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
      } else if (intent.kind === 'end' && text.indexOf('Task folded: ') === 0) {
        const name = taskNameFromText(text, 'Task folded: ')
        // Pop the most recent mark whose normalized name matches. Name-keyed
        // on purpose (old-log replay); the tool layer enforces LIFO before
        // any of these events can be written. The end-and-fold is ONE call;
        // there is no pending-fold record to keep.
        for (let i = next.marks.length - 1; i >= 0; i -= 1) {
          if (next.marks[i].name === name) { next.marks.splice(i, 1); break }
        }
      }
    }
    return next === null ? state : normalizeTaskMarks(next)
  }
  return state
}

/**
 * Empty stacks with no pending intents normalize back to the null init state.
 */
function normalizeTaskMarks(state) {
  const noPending = Object.keys(state.pending).length === 0
  if (noPending && state.marks.length === 0) return null
  return state
}

function cloneTaskMarks(state) {
  const base = state === null ? emptyTaskMarksState() : state
  const pending = Object.create(null)
  const source = base.pending !== undefined ? base.pending : Object.create(null)
  for (const key of Object.keys(source)) pending[key] = source[key]
  const marks = (base.marks !== undefined ? base.marks : []).map((m) => ({ seq: m.seq, name: m.name }))
  return { pending, marks }
}

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

export default {
  name: 'compact-region',
  // NOTE: 'compaction' is deliberately NOT injected. The engine is ALWAYS
  // the plugin's own ScopedEngine instance (built by engineFor below on
  // first use) — never a realm-registered ctx.compaction, which belongs to
  // AUTO compaction and runs the stock checkpoint instruction. Direct
  // property access on an undeclared service throws in cordis ("cannot get
  // property without inject"), so nothing here touches ctx.compaction.
  // All dependencies (tools, systemPrompt, sessionProjections, and — via the
  // engine's own ctx use — tokenMeter/llm) are host-plane services.
  inject: ['tools', 'systemPrompt', 'sessionProjections', 'tokenMeter', 'llm'],
  apply(ctx) {
    // Native-event derivation folds into this projection; the registration's
    // disposer rides the plugin fiber, so it unloads with us. stateVersion 8
    // discards persisted rows from earlier reducer generations (v7 carried
    // lastEnded records for the two-phase end→commit split; the merged
    // end-and-fold design has no such state).
    ctx.sessionProjections.register({
      key: TASK_MARKS_KEY,
      stateSchema: taskMarksStateSchema,
      init: () => null,
      apply: applyTaskMarks,
      stateVersion: 8
    })

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

    // Engine resolution: ALWAYS the self-hosted ScopedEngine (see
    // buildScopedEngine below) — instantiated once and cached on success.
    // auto:false keeps the constructor side-effect-free; the shim ctx never
    // registers the instance as a service, so a realm engine mounted for
    // AUTO compaction is left untouched (the durable event-log lock keeps
    // the two instances mutually exclusive).
    //
    // Module resolution: a bare-specifier import works when this plugin sits
    // inside a node_modules tree (profile npm install) but NOT from a bare
    // preset directory (the package lives in the host's npx cache). Fallback:
    // walk up from host anchors (process.argv[1], cwd) to a node_modules dir
    // containing the engine package, and import its lib entry by file URL.
    // If even that fails, the cache stores null (no retry — the resolution
    // environment does not change within a process lifetime) and task_fold
    // degrades to closing tasks unfolded.
    // Per-session closing declaration: task_fold stashes the task name it is
    // closing, keyed by sessionId, so concurrent folds in OTHER sessions of
    // the same process (the engine is a singleton) never cross-contaminate
    // each other's summary titles. Summarize() reads it via closure capture.
    const closingTasks = new Map()

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

    // SPAN-SCOPED summarization instruction: the module-level exported
    // FOLD_SUMMARY_INSTRUCTION (see its doc comment there for why the stock
    // continuity-checkpoint instruction is wrong for folds).

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
          // The fold caller (task_fold) stashed the task name it is closing
          // in the per-session closingTasks map: the span's own tail cannot
          // contain its ending (the executor's result event does not exist
          // yet), so the instruction DECLARES the completion instead. It also
          // sets the TITLE (the task name) and excludes lifecycle
          // bookkeeping from the summary: task_begin / task_fold calls and
          // results are the span's frame, not its content.
          const closingName = closingTasks.get(agent.session.id)
          const closing = typeof closingName === 'string' && closingName.length > 0
            ? '\nThe task this span belongs to is named "' + closingName + '". Rules for this fold:\n'
              + '- Begin the summary with the heading line "# ' + closingName + '" — nothing before it.\n'
              + '- This fold CLOSES the task: the work in this span is COMPLETE. Do not report anything as unfinished or pending because of how the span ends — this very fold is the task\u0027s ending.\n'
              + '- Do NOT summarize task_begin / task_fold calls, their results, or any narration that merely announces starting or finishing the task — that is lifecycle bookkeeping, not content. Summarize the WORK itself.'
            : ''
          const messages = [...input.messages, {
            role: 'user',
            content: [{ type: 'text', text: FOLD_SUMMARY_INSTRUCTION + closing }]
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
      // Always the SCOPED instance, built once and cached. A realm engine
      // (preset row) is deliberately NOT used by our folds: it runs the stock
      // continuity-checkpoint instruction. The realm instance keeps serving
      // AUTO compaction (pressure/overflow), where checkpoint semantics are
      // exactly right; task_fold's explicit folds get span summaries. The
      // durable lock is shared through the event log, so the two instances
      // stay mutually exclusive. A failed build caches null for the process
      // lifetime (resolution environment never changes mid-process).
      if (selfEngine !== undefined) return selfEngine === null ? undefined : selfEngine
      try {
        selfEngine = await buildScopedEngine()
        return selfEngine
      } catch (err) {
        selfEngine = null
        return undefined
      }
    }

    // ── span artifact: the EXACT original context, as a file ──────────────
    // deriveEventMessage/eventAt are the harness's own request-derivation
    // pair (the compaction engine replays them for summarization input), so
    // the artifact is byte-identical to what the model was sent for the span
    // — same blocks, same order, no digest, no line numbers. Written to the
    // OS temp dir at fold time; fold_recall({ fold: N }) regenerates it
    // from the append-only log when the temp file has been cleaned.
    function spanMessages(session, seqs) {
      if (typeof session.deriveEventMessage !== 'function' || typeof session.eventAt !== 'function') return undefined
      try {
        const messages = []
        for (const seq of seqs) {
          const message = session.deriveEventMessage(session.eventAt(seq))
          if (message !== null && message !== undefined) messages.push(message)
        }
        return messages
      } catch (err) {
        return undefined
      }
    }

    function writeArtifactFile(session, seqs, nameKey) {
      const messages = spanMessages(session, seqs)
      if (messages === undefined) return undefined
      try {
        const dir = nodePath.join(nodeOs.tmpdir(), 'taskfold-artifacts')
        nodeFs.mkdirSync(dir, { recursive: true })
        const slug = String(nameKey).replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60)
        const file = nodePath.join(dir, (slug.length > 0 ? slug : 'artifact') + '-' + Date.now().toString(36) + '.json')
        nodeFs.writeFileSync(file, JSON.stringify(messages, null, 2) + '\n', 'utf8')
        return file
      } catch (err) {
        return undefined
      }
    }


    const taskBegin = {
      name: 'task_begin',
      description: 'Begin a NAMED task. The name is the identity; when the work is done, one task_fold({ name }) call closes it AND folds its full span into a summary node titled by the name. A name already open is rejected; names must not contain " —". Tasks can nest: task_begin while a task is open opens a subtask (innermost closes first). Call alone in a step.',
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
        if (name.length === 0) return { ok: false, category: 'invalid', error: 'task_begin requires a non-empty `name` (the identity key task_fold will close by)' }
        if (!validTaskName(name)) return { ok: false, category: 'invalid', error: 'task names must not contain " —" (the result-text delimiter); pick a name without it' }
        const session = agent.session
        const open = marksOf(session)
        if (open.some((m) => m.name === name)) {
          return { ok: false, category: 'invalid', error: 'a task named "' + name + '" is already open; names are identity keys — close it first or pick another name' }
        }
        const nodes = session.surface.nodes
        // CONTRACT: the mark lands on the LAST assistant message on the
        // surface, which — because task_begin is called alone in a step — is
        // the assistant message of this very step. The projection derives
        // the push from that event + the success text; this scan only
        // verifies an assistant message exists to anchor on.
        const bySeq = new Map()
        for (const ev of sessionEvents(session)) {
          if (ev !== null && typeof ev === 'object' && Number.isInteger(ev.seq)) bySeq.set(ev.seq, ev)
        }
        let markSeq = null
        for (let i = nodes.length - 1; i >= 0; i -= 1) {
          const ev = bySeq.get(nodes[i])
          if (ev !== undefined && ev.type === 'assistant/message') { markSeq = nodes[i]; break }
        }
        if (markSeq === null) return { ok: false, category: 'invalid', error: 'no assistant message found on the surface' }
        void markSeq
        // No event appended: the projection derives the named push from this
        // step's assistant/message + the success text about to be returned.
        const openNames = open.map((m) => m.name).concat([name])
        const depth = openNames.length
        return { ok: true, name, depth, openNames }
      }
    }

    const taskEnd = {
      name: 'task_fold',
      description: 'End the INNERMOST open task by name AND fold its full span (begin pair + body) into one summary node titled by the name — one call does both. LIFO: newer open tasks block older ones; closing a blocked or unknown name fails and changes nothing (close the newer task first). A fold that loses a race reports the reason and keeps the mark (retry). If the compaction engine is unavailable, or the mark was already shadowed by another fold, the task still closes — unfolded. The output carries what remains open, the fold number, and the path of a temp JSON file holding the span\u0027s EXACT original request context — read/grep it with any file tool; fold_recall({ fold: N }) regenerates it. Too-small spans end the task but stay unfolded. Call alone in a step.',
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
            return [{ type: 'text', text: 'task_fold failed (' + category + '): ' + error + hint }]
          }
          const open = value.remainingNames.length > 0 ? value.remainingNames.length + ' open: ' + value.remainingNames.join(', ') : 'all closed'
          if (value.unfolded !== undefined) {
            const why = value.unfolded === 'engine'
              ? 'Engine unavailable; task closed without folding.'
              : 'Mark no longer on the surface; task closed without folding.'
            return [{ type: 'text', text: 'Task folded: ' + value.name + ' — ' + open + '. ' + why }]
          }
          if (value.tooSmall === true) {
            return [{ type: 'text', text: 'Task folded: ' + value.name + ' — ' + open + '. Span too small to fold; left as-is.' }]
          }
          const foldPart = value.fold === undefined ? '' : ' Folded #' + value.fold + ' (' + value.tokens + ' tokens).'
          const filePart = value.file === undefined ? '' : ' Original context saved: ' + value.file
          const reportPart = value.fold === undefined ? '' : ' The fold summary node is now in context — write the task\'s closing report to the user from it (adapt the wording, no second summary layer).'
          return [{ type: 'text', text: 'Task folded: ' + value.name + ' — ' + open + '.' + foldPart + filePart + reportPart }]
        }
      },
      async execute(args, exec) {
        const agent = exec.agent
        if (agent === undefined) return { ok: false, category: 'invalid', error: 'task_fold requires an agent context' }
        const name = args !== null && typeof args === 'object' ? normalizeName(args.name) : ''
        if (name.length === 0) return { ok: false, category: 'invalid', error: 'task_fold requires a non-empty `name`' }
        const session = agent.session
        const marks = marksOf(session)
        const engine = await engineFor()
        const decision = foldDecision(marks, name, session.surface.nodes, engine !== undefined, sessionEvents(session))
        if (decision.action === 'invalid') {
          return { ok: false, category: 'invalid', error: decision.error }
        }
        if (decision.action === 'unknown') {
          return { ok: false, category: 'invalid', error: 'no open task named "' + name + '". Open tasks: ' + (decision.open.length > 0 ? decision.open.join(', ') : '(none)') }
        }
        if (decision.action === 'lifo') {
          return { ok: false, category: 'invalid', error: 'task "' + name + '" is not the innermost open task; close the newer task(s) first: ' + decision.blocking.join(', ') }
        }
        // remaining = the stack minus the matched mark (most recent
        // occurrence of this name) — mirrors what the reducer will pop.
        const remainingNames = []
        let skipped = false
        for (let i = marks.length - 1; i >= 0; i -= 1) {
          if (!skipped && marks[i].name === name) { skipped = true; continue }
          remainingNames.unshift(marks[i].name)
        }
        if (decision.action === 'unfolded') {
          // Degraded close: the mark stays closable but the span cannot fold
          // (anchor shadowed by another fold, or no engine). The success text
          // pops the mark — the task ends either way.
          return { ok: true, name, remainingNames, unfolded: decision.reason }
        }
        if (decision.action === 'tooSmall') {
          return { ok: true, name, remainingNames, tooSmall: true }
        }
        try {
          closingTasks.set(session.id, name)
          // The decision's endSeq is the newest surface node, but the engine
          // only accepts BALANCED boundaries (step ends). If the newest node
          // sits inside an open/unbalanced step, walk back node by node and
          // retry — a rejected compactRegion commits nothing, so retries are
          // side-effect free. Exhausting all candidates means nothing foldable
          // sits in the span → tooSmall semantics.
          let result = null
          for (let endSeq = decision.endSeq; endSeq >= decision.startSeq; ) {
            try {
              result = await engine.compactRegion(decision.startSeq, endSeq, agent, exec.signal)
              break
            } catch (err) {
              if (err !== null && typeof err === 'object' && typeof err.message === 'string'
                && err.message.includes('balanced boundary')) {
                // Step back to the previous surface node below this seq.
                let prev = -1
                for (const s of session.surface.nodes) {
                  if (typeof s === 'number' && s < endSeq && s >= decision.startSeq && s > prev) prev = s
                }
                if (prev === -1) break
                endSeq = prev
                continue
              }
              throw err
            }
          }
          if (result === null) {
            // No balanced boundary at or after the anchor — nothing foldable.
            return { ok: true, name, remainingNames, tooSmall: true }
          }
          const file = writeArtifactFile(session, result.shadowedSeqs, name)
          // Fold number for recall: chronological index of compaction/summary
          // events. compactRegion commits synchronously before returning, so
          // the snapshot already contains the event just committed.
          let foldNo = 0
          for (const e of sessionEvents(session)) {
            if (e !== null && typeof e === 'object' && e.type === 'compaction/summary') foldNo += 1
          }
          return { ok: true, name, remainingNames, tokens: result.shadowedTokenCount, fold: foldNo, file }
        } catch (err) {
          const classified = classifyCategory(err)
          if (classified.category === 'summary') {
            // Terminal: too small to summarize. The task still ends; the span
            // stays on the surface. (Success text pops the mark.)
            return { ok: true, name, remainingNames, tooSmall: true }
          }
          // Non-terminal: nothing happened — the mark stays (the failure text
          // pops nothing), so the model retries task_fold.
          const short = classified.category === 'busy'
            ? 'compaction lock active — retry task_fold'
            : classified.category === 'changed'
              ? 'surface changed during fold — retry task_fold'
              : classified.category === 'commit'
                ? 'fold failed to commit — retry task_fold'
                : classified.message
          return { ok: false, category: classified.category, error: short }
        } finally {
          closingTasks.delete(session.id)
        }
      }
    }

    ctx.tools.register(taskBegin)
    ctx.tools.register(taskEnd)

    ctx.systemPrompt.section({
      name: 'task-marker-compaction',
      order: 650,
      text: 'MANDATORY task lifecycle discipline: every discrete task MUST be wrapped in task marks. Before starting any discrete task, call task_begin({ name: "…" }) — alone in a step; a name already open is rejected. The moment its work is done, call task_fold({ name }) — alone in a step: it closes the task AND folds the full span into one summary node titled by the name. task_fold is the FIRST closing action — call it BEFORE writing the task\'s closing report to the user; the fold summary IS the summary. After task_fold succeeds, write the closing report from the fold summary node now in context (adapt the wording for the user; never add a second summary layer, never restate the span from memory — recall details from the temp artifact instead). Do NOT deliver the report first and fold afterwards: the report belongs after the fold, outside it. Doing tool work on a discrete task with no mark open, or leaving a task open after its work is finished, is a protocol violation — do not do either.\n\nClosing is LIFO: only the innermost open task can be closed; a blocked or unknown name fails and changes nothing (close newer tasks first). A fold that loses a race reports the reason and keeps the task open (retry). If the engine is unavailable, or the mark was shadowed by another fold, the task still closes unfolded. Too-small spans end the task but stay unfolded. Tasks NEST: while a task is open, another task_begin opens a subtask — for multi-module or multi-part work you MUST split it into nested subtasks so each part becomes its own titled fold (innermost folds first, then its parent), and every fold keeps its own recallable original context. Never track message positions yourself.\n\ntask_fold\u0027s output carries the fold number and the path of a temp file holding the span\u0027s EXACT original request context (the same messages the model was sent). Read or grep it with any file tool when the summary lacks the detail you need; if the temp file has been cleaned, call fold_recall({ fold: N }) to regenerate it (list_folds gives fold numbers).\n\nRuntime context enforces this discipline with a todo bridge and lifecycle nudges: when the todo list changes, a line reports it with the open task roster — keep task marks in sync (task_begin for new work, task_fold for finished work); call task_begin when working with no task open, call task_fold for a task 20+ rounds old. Treat these directives as binding, not advisory.'
    })

    const TASK_TOOL_RE = /^(task_begin|task_fold|list_folds|fold_recall|todo_write)$/

    function recentWorkCallCount(session) {
      // Count non-task tool calls in the last 10 assistant messages.
      // Event shape: assistant/message events carry the payload at
      // data.message.content, and call blocks are 'tool-call'
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

    // True when the MOST RECENT assistant message contains a todo_write
    // tool-call block — the model just updated its todo list, so the next
    // request carries the todo-bridge report line. Stateless: derived from
    // the event log alone, no cross-render memory.
    function lastAssistantHasTodoWrite(session) {
      const events = sessionEvents(session)
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i]
        if (e === null || typeof e !== 'object' || e.type !== 'assistant/message') continue
        const message = e.data !== null && typeof e.data === 'object' && e.data.message !== null && typeof e.data.message === 'object' ? e.data.message : null
        const blocks = message !== null && Array.isArray(message.content) ? message.content : []
        return blocks.some((b) => b !== null && typeof b === 'object' && b.type === 'tool-call' && String(b.name) === 'todo_write')
      }
      return false
    }

    // Model rounds since the most recent 'Task folded: ' result. Used to
    // grace-suppress the begin-nudge right after a task closes. Bounded
    // backward scan; returns a large number when no outcome exists.
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
          if (text.indexOf('Task folded: ') === 0) {
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
        // Deliberately NO standing "Open task marks: N" line: depth rides in
        // every task_begin/task_fold result text, so echoing it in a snapshot
        // would re-inject after every lifecycle call for no new information.
        // This context exists ONLY for cross-state signals the model cannot
        // read from any single message.

        // ── Nudge 1: no task open but work is happening ─────────────────
        // Renders for as long as the model keeps making non-task tool calls
        // with no open task; retracts the moment a task begins (or the work
        // stops). ≥3 work calls in the last 10 assistant messages, with a
        // 3-round grace after a task_fold so a fresh close is not immediately
        // answered with "begin another".
        if (ownDepth === 0 && recentWorkCallCount(session) >= 3 && roundsSinceFoldOutcome(session) >= 3) {
          lines.push('Task lifecycle: no open task during tool work — call task_begin({ name: "…" }) if this is a discrete task.')
        }

        // ── Nudge 2: a task left open for a long time ──────────────────
        // Scans ALL open marks and holds on the OLDEST one aged 20+ rounds
        // (one task per line, byte-stable). Tie-break: first hit wins —
        // equal (cap-saturated) ages mean both are ≥20 rounds old and seqs
        // ascend with push order, so the earlier mark is the older task.
        // This only holds while cap ≥ threshold; revisit if either changes.
        if (ownDepth > 0) {
          let oldest = null
          let oldestAge = -1
          for (const m of marks) {
            const age = countAssistantSince(session, m.seq, 21)
            if (age > oldestAge) { oldestAge = age; oldest = m }
          }
          if (oldestAge >= 20) {
            lines.push('Task lifecycle: task "' + oldest.name + '" is 20+ rounds old — if done, call task_fold({ name: "' + oldest.name + '" }); if a newer task blocks it, close that one first.')
          }
        }

        // ── Todo bridge: transient change report ──────────────────────
        // Renders ONLY on the request right after the model called
        // todo_write (detected statelessly in the most recent assistant
        // message); the diff-driven snapshot engine retracts the line on
        // the next unchanged render — one appearance per todo_write. The
        // line reports the change plus the open task roster; whether to
        // task_begin or task_fold is the MODEL's call — a status report,
        // not a conditional nag.
        if (lastAssistantHasTodoWrite(session)) {
          lines.push(todoBridgeLine(marks.map((m) => m.name)))
        }
        return lines.join('\n')
      }
    })
  }
}