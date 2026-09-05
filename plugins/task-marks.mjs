/**
 * taskMarks — the named-task projection and its pure decision helpers.
 *
 * Mark-stack persistence: the `taskMarks` session projection DERIVES the
 * open-mark stack from harness-native events only — `assistant/message`
 * (tool-call blocks named task_begin/task_end/task_fold register a pending
 * intent keyed by callId) and `tool/result` (the rendered text decides
 * success; success pushes/pops). No custom event types are ever appended:
 * the harness read side refuses unknown event types that are not marked
 * `ignorable`, and the write side has no API to set that flag, so a custom
 * `task/mark` event (the v1 design) made sessions unloadable after the
 * 0.1.2-alpha.3 upgrade. Marks survive host restarts and session resume
 * because the event log is append-only and folds do not remove events.
 * Unlike the stock `todos` projection, marks deliberately do NOT reset on
 * `turn/start` — tasks span user turns.
 *
 * Derivation contract with our own renderers (double-owned, stable):
 *   task_begin success text starts with 'Task begun: '
 *   task_end   success text starts with 'Task ended: ' (pops the mark);
 *   legacy 'Task folded: ' results replay identically. Failures start with
 *   'task_begin failed' / 'task_end failed'. A failed close KEEPS the mark
 *   (atomic end-and-fold: nothing happened, retry). Task names never
 *   contain ' —' (validTaskName): the delimiter that taskNameFromText
 *   splits on, keeping the name render→parse round trip lossless.
 *
 * Everything in this module is pure (or a thin ctx-keyed state accessor),
 * so tests exercise it offline without a host.
 */
import { sessionEvents, messageOf, blocksOf, toolResultText, taskResultEventText } from './events.mjs'

/** Session-projection key under which the open-mark stack is published. */
export const TASK_MARKS_KEY = 'taskMarks'

/**
 * Structural stand-in for a zod schema: the projection registry only ever
 * calls `.parse(value)` on persisted rows, so a hand validator satisfies the
 * contract without importing zod (whose module resolution from a preset
 * directory is not guaranteed). Throws on malformed state, returns it as-is
 * otherwise. v9 state: null, or { pending: { [callId]: {kind, anchorSeq} },
 * marks: [{seq, name}...], pendingArchives: [{seq, name, foldResultSeq}...] }
 * with only non-empty names retained. pendingArchives (v9, full-deferred
 * folds) is optional/loose — rows persisted by v8 or earlier lack it and
 * replay fine (their task_fold closed-and-folded inline).
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
    if (value.pendingArchives !== undefined) {
      if (!Array.isArray(value.pendingArchives)) throw new Error('taskMarks state .pendingArchives must be an array')
      for (const entry of value.pendingArchives) {
        // foldResultSeq is validated FOR REAL (positive integer, like every
        // other seq): a row without it used to pass load and then wedge the
        // deferred drain in a permanent 'wait' (its default 0 always sorts
        // before the entry's own anchor). Failing load makes the corruption
        // visible instead — and the state versioning replays the log.
        if (entry === null || typeof entry !== 'object' || !Number.isInteger(entry.seq) || entry.seq <= 0 || typeof entry.name !== 'string'
          || !Number.isInteger(entry.foldResultSeq) || entry.foldResultSeq <= 0) {
          throw new Error('taskMarks pendingArchives must contain { seq, name, foldResultSeq } objects (got ' + JSON.stringify(entry) + ')')
        }
      }
    }
    const named = marks.filter((m) => normalizeName(m.name) !== '')
    if (named.length !== marks.length) return { pending: value.pending, marks: named, ...(value.pendingArchives === undefined ? {} : { pendingArchives: value.pendingArchives }) }
    return value
  }
}

function emptyTaskMarksState() {
  return { pending: Object.create(null), marks: [], pendingArchives: [] }
}

/**
 * Normalize a task name: collapse whitespace, single line, trim. Names are
 * model-chosen keys — matching is on this normalized form so copy/paste from
 * the context listing never drifts.
 */
export function normalizeName(raw) {
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
 * Deliverable detection: does an assistant/message event at seq > fromSeq
 * contain a non-empty TEXT block? Reasoning blocks and tool-call blocks
 * deliberately do NOT count — reasoning trails every step, so counting it
 * would make the gate always-true and defeat deliverable-gating.
 */
function hasDeliverableText(event) {
  if (event === null || typeof event !== 'object' || event.type !== 'assistant/message') return false
  return blocksOf(messageOf(event)).some((b) => b !== null && typeof b === 'object' && b.type === 'text'
    && typeof b.text === 'string' && b.text.trim().length > 0)
}

/**
 * Deferred-archive plan for ONE pendingArchive entry (v9 full-deferred
 * folds; pure and offline-testable). The deliverable gate (product owner's
 * G2 ruling) folds a task only after its closing task_end has been followed
 * by a deliverable text, AND only while that deliverable precedes any
 * successor task anchor that is still open or pending. Returns:
 *   { action:'wait' }                no deliverable text yet — never fold
 *   { action:'defer' }               deliverable sits AFTER the successor
 *                                     anchor (out-of-order close): postpone;
 *                                     once the successor closes and folds,
 *                                     the trim point moves up and the
 *                                     deliverable lands inside the span
 *   { action:'drop' }                nothing foldable remains — either the
 *                                     begin anchor or the close result is no
 *                                     longer on the surface (AUTO compaction
 *                                     shadowed it), or the persisted row is
 *                                     inconsistent (close seq not locatable
 *                                     after the anchor); the task is already
 *                                     closed — discard
 *   { action:'fold', startSeq, endSeq, name }  gate open; region is
 *                                     start..end INCLUSIVE, bracketed by
 *                                     the two lifecycle RESULTS: startSeq =
 *                                     the "Task begun" result's seq
 *                                     (fallback: the begin call itself),
 *                                     endSeq = the close result's own seq —
 *                                     the begin call (with its opening
 *                                     reasoning) stays on the surface as
 *                                     the live bookmark; everything after
 *                                     the end stays on the surface too
 *
 * successorAnchors = seqs of begin anchors opened AFTER this entry's
 * foldResultSeq that are STILL open or pending (caller derives from
 * live marks + pendingArchives).
 */
export function deferredArchivePlan(entry, surfaceNodes, events, successorAnchors) {
  const nodes = Array.isArray(surfaceNodes) ? surfaceNodes : []
  const list = Array.isArray(events) ? events : []
  const foldResultSeq = Number.isInteger(entry.foldResultSeq) ? entry.foldResultSeq : 0
  // Consistency guard: the close result must be a real event AFTER the begin
  // anchor. A row that fails this (corruption the schema somehow let through,
  // or an in-memory synthetic) can never satisfy the "after the close"
  // deliverable scan — waiting would be permanent. Drop: the close already
  // popped the mark, so settle and move on.
  if (foldResultSeq < entry.seq) return { action: 'drop' }
  // ① deliverable: first assistant text after the close result.
  let deliverableSeq = null
  for (const e of list) {
    if (e === null || typeof e !== 'object' || !Number.isInteger(e.seq)) continue
    if (e.seq <= foldResultSeq) continue
    if (hasDeliverableText(e)) { deliverableSeq = e.seq; break }
  }
  // ② successor anchor: first still-open/pending begin anchor after the close.
  let successor = null
  for (const s of Array.isArray(successorAnchors) ? successorAnchors : []) {
    if (Number.isInteger(s) && s > foldResultSeq && (successor === null || s < successor)) successor = s
  }
  if (deliverableSeq === null) return { action: 'wait' }
  if (successor !== null && deliverableSeq > successor) return { action: 'defer' }
  if (nodes.indexOf(entry.seq) === -1) return { action: 'drop' }
  // END: the close result itself (the cut AFTER a completed call/result
  // pair is balanced). START: the first surface node AFTER the "Task begun"
  // result. The engine's validateSurfaceRegion requires a tool-pairing-
  // balanced leading cut, and the cut BEFORE the begin result always has
  // its own unanswered call — a region opening AT the result is structur-
  // ally uncompactable (0.19.0's anchor did exactly that: every queued
  // fold was rejected in microseconds and silently settled). The cut
  // immediately AFTER the completed begin pair is balanced, so the archive
  // opens with the first node following the result: the begin call, its
  // opening reasoning, AND the "Task begun" result all stay live on the
  // surface. Everything written AFTER the end — the deliverable, probes,
  // later turns — stays on the surface untouched; a LATER task's fold
  // swallows those leftovers when its own span covers them. If the close
  // result is no longer on the surface, the span is gone (AUTO compaction
  // shadowed it): drop, exactly like a shadowed anchor. Fallbacks (begin
  // result missing or shadowed, or no node between it and the close): fold
  // from the begin call itself — the v0.18 region, whose leading cut is
  // balanced by construction.
  if (nodes.indexOf(foldResultSeq) === -1) return { action: 'drop' }
  let beginResultSeq = null
  for (const e of list) {
    if (e === null || typeof e !== 'object' || !Number.isInteger(e.seq)) continue
    if (e.seq <= entry.seq || e.seq >= foldResultSeq) continue
    if (taskResultEventText(e).indexOf('Task begun: ') !== 0) continue
    if (nodes.indexOf(e.seq) !== -1) beginResultSeq = e.seq
    break
  }
  let startSeq = entry.seq
  if (beginResultSeq !== null) {
    let next = null
    for (const s of nodes) {
      // Strictly between the begun result and the close result: the close
      // result itself can never open a region (same unbalanced-cut shape),
      // so the upper bound is exclusive.
      if (typeof s !== 'number' || s <= beginResultSeq || s >= foldResultSeq) continue
      if (next === null || s < next) next = s
    }
    if (next !== null) startSeq = next
  }
  return { action: 'fold', startSeq, endSeq: foldResultSeq, name: entry.name }
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
 * Reducer for the `taskMarks` projection (v6, named derived state):
 *  - `assistant/message`: every tool-call block named task_begin/task_fold
 *    registers a pending intent { kind, anchorSeq: this message's seq }
 *    keyed by the block's callId.
 *  - `tool/result`: when a tool-result block's toolCallId matches a pending
 *    intent, its rendered text decides: 'Task begun: NAME' pushes a named
 *    mark { seq, name }; 'Task folded: NAME' pops the MOST RECENT mark whose
 *    normalized name matches. The reducer stays name-keyed so logs recorded
 *    before the LIFO rule (or by future variants) replay unchanged; the
 *    TOOL layer (closeTarget) enforces LIFO on new calls — closing anything
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
    return normalizeTaskMarks({ pending: Object.create(null), marks: coerced, pendingArchives: [] })
  }
  if (event.type === 'assistant/message') {
    const seq = Number.isInteger(event.seq) ? event.seq : 0
    let next = null
    for (const block of blocksOf(messageOf(event))) {
      if (block === null || typeof block !== 'object' || block.type !== 'tool-call') continue
      if (block.name !== 'task_begin' && block.name !== 'task_fold' && block.name !== 'task_end') continue
      if (next === null) next = cloneTaskMarks(state)
      next.pending[String(block.id)] = {
        kind: block.name === 'task_begin' ? 'begin' : 'end',
        anchorSeq: seq
      }
    }
    return next === null ? state : next
  }
  if (event.type === 'tool/result') {
    const seq = Number.isInteger(event.seq) ? event.seq : 0
    let next = null
    for (const block of blocksOf(messageOf(event))) {
      if (block === null || typeof block !== 'object' || block.type !== 'tool-result') continue
      if (typeof block.toolCallId !== 'string') continue
      const base = next === null ? state : next
      const pending = base === null || base.pending === undefined ? undefined : base.pending
      const intent = pending === undefined ? undefined : pending[block.toolCallId]
      if (intent === undefined) continue
      if (next === null) next = cloneTaskMarks(base)
      delete next.pending[block.toolCallId]
      const text = toolResultText(block)
      if (intent.kind === 'begin' && text.indexOf('Task begun: ') === 0) {
        const name = taskNameFromText(text, 'Task begun: ')
        next.marks.push({ seq: intent.anchorSeq, name })
      } else if (intent.kind === 'end' && (text.indexOf('Task folded: ') === 0 || text.indexOf('Task ended: ') === 0)) {
        const name = taskNameFromText(text, text.indexOf('Task ended: ') === 0 ? 'Task ended: ' : 'Task folded: ')
        // Pop the most recent mark whose normalized name matches. Name-keyed
        // on purpose (old-log replay); the tool layer enforces LIFO before
        // any of these events can be written. v9 full-deferred: a successful
        // close ALSO queues the archive {seq, name, foldResultSeq} — the
        // pre-step handler folds it after the deliverable lands. Old-log
        // replays (inline folds) queue too, but their spans' compaction/
        // summary events immediately drop the entries again (shadowedSeqs).
        for (let i = next.marks.length - 1; i >= 0; i -= 1) {
          if (next.marks[i].name === name) {
            const popped = next.marks[i]
            next.marks.splice(i, 1)
            if (next.pendingArchives === undefined) next.pendingArchives = []
            next.pendingArchives.push({ seq: popped.seq, name: popped.name, foldResultSeq: seq })
            break
          }
        }
      }
    }
    return next === null ? state : normalizeTaskMarks(next)
  }
  if (event.type === 'compaction/summary') {
    // Archive-completion closure: a committed fold shadows a seq range; any
    // pendingArchive whose BEGIN anchor lies inside that range is done —
    // drop it. Precise for AUTO folds too (a shadowed anchor can never fold
    // again). Pure and replay-safe.
    const base = state
    if (base === null || !Array.isArray(base.pendingArchives) || base.pendingArchives.length === 0) return state
    const shadowed = event.data !== null && typeof event.data === 'object' && Array.isArray(event.data.shadowedSeqs)
      ? event.data.shadowedSeqs
      : null
    if (shadowed === null) return state
    const kept = base.pendingArchives.filter((p) => shadowed.indexOf(p.seq) === -1)
    if (kept.length === base.pendingArchives.length) return state
    return normalizeTaskMarks({ pending: base.pending, marks: base.marks, pendingArchives: kept })
  }
  return state
}

/**
 * Empty stacks with no pending intents normalize back to the null init state.
 */
function normalizeTaskMarks(state) {
  const noPending = Object.keys(state.pending).length === 0
  const archives = state.pendingArchives === undefined ? [] : state.pendingArchives
  if (noPending && state.marks.length === 0 && archives.length === 0) return null
  return state
}

function cloneTaskMarks(state) {
  const base = state === null ? emptyTaskMarksState() : state
  const pending = Object.create(null)
  const source = base.pending !== undefined ? base.pending : Object.create(null)
  for (const key of Object.keys(source)) pending[key] = source[key]
  const marks = (base.marks !== undefined ? base.marks : []).map((m) => ({ seq: m.seq, name: m.name }))
  const pendingArchives = (base.pendingArchives !== undefined ? base.pendingArchives : []).map((p) => ({ seq: p.seq, name: p.name, foldResultSeq: p.foldResultSeq }))
  return { pending, marks, pendingArchives }
}

// ── ctx-keyed state accessors (shared by the tools, the drain, nudges) ─────

/** Current open marks for one session: [{ seq, name }], empty when none. */
export function marksOf(ctx, session) {
  try {
    const state = ctx.sessionProjections.stateOf(session, TASK_MARKS_KEY)
    if (state === undefined || state === null) return []
    return Array.isArray(state.marks) ? state.marks : []
  } catch (err) {
    return []
  }
}

/**
 * Queued deferred archives for one session: [{ seq, name, foldResultSeq }],
 * empty when none. Populated by successful task_end closes (reducer),
 * drained by the agent/pre-step auto-folder (fold-drain.mjs).
 */
export function archivesOf(ctx, session) {
  try {
    const state = ctx.sessionProjections.stateOf(session, TASK_MARKS_KEY)
    if (state === undefined || state === null) return []
    return Array.isArray(state.pendingArchives) ? state.pendingArchives : []
  } catch (err) {
    return []
  }
}

/**
 * Seq of the LAST assistant message on the surface, or null when none is.
 * task_begin's existence check (the mark anchors on this very message); kept
 * O(surface) by walking the surface nodes from the end via eventAt, with a
 * snapshot fallback for sessions that predate eventAt. The value is only a
 * verification — the projection derives the real anchor itself — so callers
 * use it null-checked, never as stored state.
 */
export function lastSurfaceAssistantSeq(session) {
  const nodes = session !== null && typeof session === 'object' && session.surface !== null && typeof session.surface === 'object'
    && Array.isArray(session.surface.nodes) ? session.surface.nodes : []
  if (typeof session.eventAt === 'function') {
    for (let i = nodes.length - 1; i >= 0; i -= 1) {
      let ev = null
      try { ev = session.eventAt(nodes[i]) } catch (err) { ev = null }
      if (ev !== null && typeof ev === 'object' && ev.type === 'assistant/message') return nodes[i]
    }
    return null
  }
  // Legacy sessions without eventAt: match the snapshot against a surface
  // set (smaller than the event log), scanning backwards, first hit wins.
  const onSurface = new Set(nodes)
  const events = sessionEvents(session)
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i]
    if (e !== null && typeof e === 'object' && e.type === 'assistant/message' && Number.isInteger(e.seq) && onSurface.has(e.seq)) return e.seq
  }
  return null
}
