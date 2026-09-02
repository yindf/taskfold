/**
 * Compact Region tools — preset plugin (stage-2 solidified form).
 *
 * Ships inside the preset directory and is referenced by a relative row
 * (`./plugins/compact-region.mjs`) inside the `compaction` isolate group,
 * so `ctx.compaction` resolves to this realm's engine directly.
 *
 * Registers the task-lifecycle tools plus prompt guidance:
 *   task_begin / task_fold — named tasks; end closes AND folds in one call
 *
 * Zero module dependencies: every capability arrives through `inject`.
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
 * retry).
 *
 * task_fold folds [begin assistant message .. last surface node before its
 * own step] INLINE from its execute context — the session loop is naturally
 * paused there. The span cannot contain its own ending, so the scoped
 * summarizer instruction DECLARES completion ("this fold CLOSES the task
 * <name>") instead of showing it — owning the instruction removed the
 * constraint that once forced the two-phase end→commit split.
 *
 * Todo bridge: reads the stock `todos` projection (registered by the
 * `dsh-tool-todo` row) and nudges the model through runtime context — call
 * task_begin when a todo item is in progress without a mark, call task_fold
 * when marks outlive the in-progress list. The todo tool itself is never
 * wrapped or replaced.
 */

// TEMP DIAGNOSTIC removed during two-tool refactor.

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
 * Reducer for the `taskMarks` projection (v5, named derived state):
 *  - `assistant/message`: every tool-call block named task_begin/task_fold
 *    registers a pending intent { kind, anchorSeq: this message's seq }
 *    keyed by the block's callId.
 *  - `tool/result`: when a tool-result block's toolCallId matches a pending
 *    intent, its rendered text decides: 'Task begun: NAME' pushes a named
 *    mark { seq, name }; 'Task folded: NAME' pops the MOST RECENT mark whose
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
        // Pop the most recent mark whose normalized name matches — name-keyed
        // closing, LIFO only within the same name. The end-and-fold is ONE
        // call now; there is no pending-fold record to keep.
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
 * Human-facing depth tail for task_fold success texts. Depth 0 must read as
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
    // task_begin/task_fold and the observability tools keep working.
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
          // The fold caller (task_fold) stashes the task name it is closing:
          // the span's own tail cannot contain its ending (the executor's
          // result event does not exist yet), so the instruction DECLARES the
          // completion instead. It also sets the TITLE (the task name) and
          // excludes lifecycle bookkeeping from the summary: task_begin /
          // task_fold calls and results are the span's frame, not its content.
          const closing = typeof this.__closingTask === 'string' && this.__closingTask.length > 0
            ? '\nThe task this span belongs to is named "' + this.__closingTask + '". Rules for this fold:\n'
              + '- Begin the summary with the heading line "# ' + this.__closingTask + '" — nothing before it.\n'
              + '- This fold CLOSES the task: the work in this span is COMPLETE. Do not report anything as unfinished or pending because of how the span ends — this very fold is the task\u0027s ending.\n'
              + '- Do NOT summarize task_begin / task_fold calls, their results, or any narration that merely announces starting or finishing the task — that is lifecycle bookkeeping, not content. Summarize the WORK itself.'
            : ''
          const messages = [...input.messages, {
            role: 'user',
            content: [{ type: 'text', text: SCOPED_SPAN_INSTRUCTION + closing }]
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
      // exactly right; task_fold's explicit folds get span summaries. The
      // durable lock is shared through the event log, so the two instances
      // stay mutually exclusive.
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

    // ── span artifact: the EXACT original context, as a file ──────────────
    // deriveEventMessage/eventAt are the harness's own request-derivation
    // pair (the compaction engine replays them for summarization input), so
    // the artifact is byte-identical to what the model was sent for the span
    // — same blocks, same order, no digest, no line numbers. Written to the
    // OS temp dir at fold time; compact_recall({ fold: N }) regenerates it
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
      description: 'Begin a NAMED task. The name is the identity; when the work is done, one task_fold({ name }) call closes it AND folds its full span into a summary node titled by the name. Call alone in a step.',
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
        // through the task_fold result. If the executor ever appends another
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
      name: 'task_fold',
      description: 'End a NAMED task by name AND fold its full span (begin pair + body) into one summary node titled by the name — one call does both. A name mismatch fails and changes nothing (retry); a fold that loses a race reports the reason and keeps the mark (retry). The output carries what remains open, the fold number, and the path of a temp JSON file holding the span\u0027s EXACT original request context — read/grep it with any file tool; compact_recall({ fold: N }) regenerates it. Too-small spans end the task but stay unfolded. Call alone in a step.',
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
          if (value.tooSmall === true) {
            return [{ type: 'text', text: 'Task folded: ' + value.name + ' — ' + open + '. Span too small to fold; left as-is.' }]
          }
          const foldPart = value.fold === undefined ? '' : ' Folded #' + value.fold + ' (' + value.tokens + ' tokens).'
          const filePart = value.file === undefined ? '' : ' Original context saved: ' + value.file
          return [{ type: 'text', text: 'Task folded: ' + value.name + ' — ' + open + '.' + foldPart + filePart }]
        }
      },
      async execute(args, exec) {
        const agent = exec.agent
        if (agent === undefined) return { ok: false, category: 'invalid', error: 'task_fold requires an agent context' }
        const name = args !== null && typeof args === 'object' ? normalizeName(args.name) : ''
        if (name.length === 0) return { ok: false, category: 'invalid', error: 'task_fold requires a non-empty `name`' }
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
        const mark = marks[idx]
        const remainingNames = marks.filter((m, i) => i !== idx).map((m) => m.name)
        // Fold [begin assistant message .. last surface node BEFORE this very
        // step's assistant message] — the executor's own message is always the
        // last node (task_fold is called alone in a step), so length-2 is the
        // final balanced edge of the task body.
        const nodes = session.surface.nodes
        const endIdx = nodes.length - 2
        if (endIdx < 0 || nodes[endIdx] < mark.seq) {
          // Nothing between the begin pair and this step — a fold would be
          // empty. The task still ends; the span stays as-is.
          return { ok: true, name, remainingNames, tooSmall: true }
        }
        const engine = await engineFor()
        if (engine === undefined) return { ok: false, category: 'invalid', error: 'compaction service is unavailable in this composition' }
        try {
          engine.__closingTask = name
          const result = await engine.compactRegion(mark.seq, nodes[endIdx], agent, exec.signal)
          const file = writeArtifactFile(session, result.shadowedSeqs, name)
          // Fold number for recall: chronological index of compaction/summary
          // events — the one just committed is the latest.
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
          try { delete engine.__closingTask } catch (err) { /* ignore */ }
        }
      }
    }

    ctx.tools.register(taskBegin)
    ctx.tools.register(taskEnd)

    ctx.systemPrompt.section({
      name: 'task-marker-compaction',
      order: 650,
      text: '## Task lifecycle compaction\n\nTasks are NAMED. Call task_begin({ name: "…" }) to open one (alone in a step). When the work is done, call task_fold({ name }) (alone in a step): it closes the task by name AND folds the full span into one summary node titled by the name — one call does both; a fold that loses a race reports the reason and keeps the task open (retry). Too-small spans end the task but stay unfolded. Never track message positions yourself.\n\ntask_fold\u0027s output carries the fold number and the path of a temp file holding the span\u0027s EXACT original request context (the same messages the model was sent). Read or grep it with any file tool when the summary lacks the detail you need; if the temp file has been cleaned, call compact_recall({ fold: N }) to regenerate it (list_folds gives fold numbers).\n\nRuntime context may carry a todo bridge and lifecycle nudges: call task_begin when working with no task open, call task_fold for a task 20+ rounds old. Follow them so task spans stay compactable.'
    })

    const TASK_TOOL_RE = /^(task_begin|task_fold|list_folds|compact_recall|todo_write)$/

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

        // ── Nudge 2: task open for a long time ─────────────────────────
        // Holds until the named task is closed — the wording is static
        // ("20+ rounds") so the held line is byte-stable and produces no
        // further snapshots while it waits.
        if (ownDepth > 0) {
          const newest = marks[marks.length - 1]
          const age = countAssistantSince(session, newest.seq, 21)
          if (age >= 20) {
            lines.push('Task lifecycle: task "' + newest.name + '" is 20+ rounds old — if done, call task_fold({ name: "' + newest.name + '" }).')
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
            lines.push('Todo bridge: open tasks exceed in-progress todos — call task_fold for the finished ones.')
          }
        }
        return lines.join('\n')
      }
    })
  }
}