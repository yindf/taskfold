/**
 * Compact Region tools — plugin-bundle form (installed via `dsh plugin add`
 * at the profile level; cordis.patch.yml mounts this file at the host plane,
 * so the tools land in the global registry for every session of every
 * preset). No realm/isolate-group assumptions are made.
 *
 * Registers the task-lifecycle tools plus prompt guidance:
 *   task_begin / task_end — named tasks; task_end pops the mark and QUEUES an
 *   archive (v9 full-deferred): the span folds AUTOMATICALLY at the next
 *   agent step boundary after the task's deliverable text lands.
 *
 * Zero module dependencies: every capability arrives through `inject`; the
 * compaction engine is self-hosted (see engineFor below).
 *
 * Close semantics (v3): LIFO — only the INNERMOST open task can be closed;
 * closing a blocked or unknown name fails atomically. Degraded closes: a
 * shadowed anchor still CLOSES the task, unfolded. The deferredArchivePlan()
 * export carries the deliverable gate as a pure function; the pre-step
 * auto-folder and the manual supplement path are I/O shells around it.
 *
 * Mark-stack persistence: the `taskMarks` session projection DERIVES the
 * open-mark stack from harness-native events only — `assistant/message`
 * (tool-call blocks named task_begin/task_end/task_fold register a pending intent
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
 *   task_end   success text starts with 'Task ended: ' (pops the mark);
 *   legacy 'Task folded: ' results replay identically. Failures start with
 *   'task_begin failed' / 'task_end failed'. A failed close KEEPS the mark (atomic end-and-fold: nothing happened,
 * retry). Task names never contain ' —' (validTaskName): the delimiter that
 * taskNameFromText splits on, keeping the name render→parse round trip
 * lossless.
 *
 * The SYSTEM folds [begin assistant message .. close result] INCLUSIVE —
 * begin..end exactly, nothing after the end. The deliverable (written after
 * the close, with full context) and anything else after the end stay on the
 * surface untouched; a later task's own [begin..end] swallows those
 * leftovers in turn. The span cannot contain its own ending, so the scoped
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

// Shared span-preview/JSONL helpers: preview line N and artifact line N are
// derived from the same message, so numbering maps both ways.
import { renderArchivePreview, writeSpanArtifact, sessionArtifactDir } from './span-preview.mjs'

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
        if (entry === null || typeof entry !== 'object' || !Number.isInteger(entry.seq) || entry.seq <= 0 || typeof entry.name !== 'string') {
          throw new Error('taskMarks pendingArchives must contain { seq, name, foldResultSeq } objects')
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
 * Deliverable detection: does an assistant/message event at seq >
 * fromSeq contain a non-empty TEXT block? Reasoning blocks and tool-call
 * blocks deliberately do NOT count — reasoning trails every step, so
 * counting it would make the gate always-true and defeat deliverable-gating.
 */
function hasDeliverableText(event) {
  if (event === null || typeof event !== 'object' || event.type !== 'assistant/message') return false
  const message = event.data !== null && typeof event.data === 'object' && event.data.message !== null
    && typeof event.data.message === 'object' ? event.data.message : null
  const blocks = message !== null && Array.isArray(message.content) ? message.content : []
  return blocks.some((b) => b !== null && typeof b === 'object' && b.type === 'text'
    && typeof b.text === 'string' && b.text.trim().length > 0)
}

/**
 * Deferred-archive plan for ONE pendingArchive entry (v9 full-deferred
 * folds; pure and offline-testable). The deliverable gate (product owner's
 * G2 ruling) folds a task only after its closing task_fold has been followed
 * by a deliverable text, AND only while that deliverable precedes any
 * successor task anchor that is still open or pending. Returns:
 *   { action:'wait' }                no deliverable text yet — never fold
 *   { action:'defer' }               deliverable sits AFTER the successor
 *                                     anchor (out-of-order close): postpone;
 *                                     once the successor closes and folds,
 *                                     the trim point moves up and the
 *                                     deliverable lands inside the span
 *   { action:'drop' }                begin anchor no longer on the surface
 *                                     (AUTO compaction shadowed it) — the
 *                                     task is already closed; discard
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
export function deferredArchivePlan(p, surfaceNodes, events, successorAnchors) {
  const nodes = Array.isArray(surfaceNodes) ? surfaceNodes : []
  const list = Array.isArray(events) ? events : []
  const foldResultSeq = Number.isInteger(p.foldResultSeq) ? p.foldResultSeq : 0
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
  if (nodes.indexOf(p.seq) === -1) return { action: 'drop' }
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
  if (!Number.isInteger(foldResultSeq) || foldResultSeq < p.seq) return { action: 'wait' }
  if (nodes.indexOf(foldResultSeq) === -1) return { action: 'drop' }
  let beginResultSeq = null
  for (const e of list) {
    if (e === null || typeof e !== 'object' || !Number.isInteger(e.seq)) continue
    if (e.seq <= p.seq || e.seq >= foldResultSeq) continue
    if (taskResultEventText(e).indexOf('Task begun: ') !== 0) continue
    if (nodes.indexOf(e.seq) !== -1) beginResultSeq = e.seq
    break
  }
  let startSeq = p.seq
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
  return { action: 'fold', startSeq, endSeq: foldResultSeq, name: p.name }
}

/**
 * Joined text of every tool-result block in a 'tool/result' event,
 * mirroring the reducer's extraction (prefix matches on 'Task begun: ' /
 * 'Task ended: ' rely on the same shape).
 */
function taskResultEventText(e) {
  if (e === null || typeof e !== 'object' || e.type !== 'tool/result') return ''
  const message = e.data !== null && typeof e.data === 'object' && e.data.message !== null
    && typeof e.data.message === 'object' ? e.data.message : null
  const blocks = message !== null && Array.isArray(message.content) ? message.content : []
  let out = ''
  for (const block of blocks) {
    if (block === null || typeof block !== 'object' || block.type !== 'tool-result' || !Array.isArray(block.content)) continue
    for (const b of block.content) {
      if (isTaskResultText(b)) out += (out.length > 0 ? '\n' : '') + b.text
    }
  }
  return out
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
  return 'Todo bridge: todo_write was called; open tasks: ' + roster + ' — keep marks in sync: task_begin for new tasks, task_end for finished tasks.'
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
  'You are summarizing ONE FOLDED SPAN of a longer session. The messages above are exactly that span; your summary replaces them for the model that continues this session. The span opens just after the \'Task begun\' result and closes with the \'Task ended\' result — the begin call, its opening reasoning, and the \'Task begun\' result itself stay outside the span by design; do not treat their absence as missing work.',
  'Summarize ONLY what the span contains — what was done, tried, decided, and produced. Do NOT restate project background, architecture, goals, or context the messages merely assume: the continuing model already has all of that from outside the span.',
  'Output EXACTLY this structure, terse bullets, "(none)" for empty sections:',
  '## What happened',
  '- [the work performed in this span, in order, one bullet per meaningful step]',
  '## User inputs & decisions',
  '- [the user\'s requests, corrections, rejections, answers, and approvals from THIS span, with the decision each produced; quote verbatim where the exact wording matters]',
  '## Changes',
  '- [exact file paths written or edited, key values, durable identifiers]',
  '## Pitfalls & gotchas',
  '- [failed attempts and WHY they failed, workarounds adopted, environment traps (sandbox denials, platform quirks), and "do not do X again" lessons from this span]',
  '## Outcomes',
  '- [results, verdicts, failures and their meaning; anything a later step must know]',
  'Rules:',
  '- Boundary: What happened = the span\'s actions and decisions in order, including the commands it ran; Changes = only durable artifacts that outlive the span and stay grep-able later (exact file paths written or edited, key values, durable identifiers). If it is not grep-able later, it belongs in What happened, not Changes.',
  '- Budget: the closing rules state THIS fold\u0027s concrete word budget (≈10% of the span\u0027s estimated tokens). Spend it on fidelity, never on padding; a section ends at "(none)" as soon as it is true. Sections get different treatment: What happened keeps every meaningful step as its own bullet (compress phrasing, not facts; merge only same-action repeats); Changes is exhaustive — every file path written or edited, every key value, no selection; Pitfalls & gotchas keeps every failure and its cause; Outcomes keeps every result and verdict; User inputs & decisions keeps every request, correction, and approval. When the budget forces triage, drop narrative connective tissue and restated context first — never anchors, decisions, or failure causes.',
  '- Preserve exact file paths, commands, error strings, identifiers, and numbers. When this summary names files, commands, or errors, keep them precise (paths verbatim) — the reader will only recall the original span if these anchors fail to answer its question, and precise anchors double as grep keywords for that recall.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Pitfalls and their causes are the span\'s most reusable knowledge: never drop why something failed.',
  '- If the deliverable was never sent, a later turn may relay this summary to the user as the task report\'s basis: keep every section accurate and human-readable. If the span already contains the delivered report, Outcomes should cite its conclusions, not restate them.',
  '- Do NOT mention summarization or compaction. Output only the summary text: no tool calls or other actions.'
].join('\n')

// Stock (non-fold) compaction normally runs the host's terse checkpoint
// instruction. Product ruling: checkpoints carry NO prompt-side caps and
// demand maximal detail — a long context must not lose its facts to terse
// bullets. The sanctioned customization hook (summarize()) is bound to the
// host's own AUTO engine instance, which a plugin cannot replace, so this
// instruction is swapped in at the one neutral seam every compaction call
// crosses: ctx.llm.stream (see apply()).
export const DETAILED_CHECKPOINT_INSTRUCTION = [
  'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of context.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use information-dense bullets. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  '- [the user\'s original and evolving goals, quoted verbatim where the exact wording matters; every request, correction, and approval]',
  '',
  '## Key Technical Concepts',
  '- [technologies, frameworks, patterns, and conventions in play, each with the detail a resuming model needs to act on it]',
  '',
  '## Files and Code',
  '- [every exact path touched: why it matters, key changes, key values, and critical snippets — exhaustive, no selection]',
  '',
  '## Errors and Fixes',
  '- [every error: its exact text, how it was resolved or worked around, plus any related user feedback; keep every failure cause]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet completed]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue — keep every distinct fact as its own bullet]',
  '',
  'Rules:',
  '- There is NO length cap and NO bullet-count cap: be as detailed as the source material supports; compress phrasing, never facts. Distinct facts never share a bullet; drop narrative connective tissue before dropping any fact.',
  '- Write precise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
  '- If the conversation already contains a prior checkpoint block, it is a PRIOR condensation. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.'
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
    const message = event.data !== null && typeof event.data === 'object' && event.data.message !== null
      && typeof event.data.message === 'object' ? event.data.message : null
    const content = message !== null && Array.isArray(message.content) ? message.content : []
    const seq = Number.isInteger(event.seq) ? event.seq : 0
    let next = null
    for (const block of content) {
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
    // Detailed stock checkpoints: swap the host's terse instruction for
    // DETAILED_CHECKPOINT_INSTRUCTION at the one seam every compaction call
    // crosses. Discriminator (from the host's summarizeWithLlm): purpose
    // 'compaction' + the final instruction message carries
    // source.plugin === 'dsh-compaction-basic'. Our own fold calls use the
    // same purpose but their instruction message has NO source, so folds are
    // untouched. Idempotent via marker; any failure leaves the call original.
    try {
      const llm = ctx.llm
      if (llm !== null && typeof llm === 'object' && typeof llm.stream === 'function' && llm.__taskfoldDetailedCheckpoints !== true) {
        const origStream = llm.stream.bind(llm)
        llm.__taskfoldDetailedCheckpoints = true
        llm.stream = (options) => {
          let rewritten = options
          try {
            if (options !== null && typeof options === 'object' && options.purpose === 'compaction' && Array.isArray(options.messages) && options.messages.length > 0) {
              const last = options.messages[options.messages.length - 1]
              const src = last !== null && typeof last === 'object' && last.source !== null && typeof last.source === 'object' ? last.source : undefined
              if (src !== undefined && src.kind === 'plugin' && src.plugin === 'dsh-compaction-basic') {
                rewritten = {
                  ...options,
                  messages: [...options.messages.slice(0, -1), {
                    ...last,
                    content: [{ type: 'text', text: DETAILED_CHECKPOINT_INSTRUCTION }]
                  }]
                }
              }
            }
          } catch (err) { /* stream the original call untouched */ }
          return origStream(rewritten)
        }
      }
    } catch (err) { /* llm service absent: nothing to detail */ }
    // Native-event derivation folds into this projection; the registration's
    // disposer rides the plugin fiber, so it unloads with us. stateVersion 9
    // discards persisted rows from earlier reducer generations (v8 predates
    // pendingArchives; the host treats a version mismatch as a full replay,
    // not a load failure — old logs replay byte-identically through v9).
    ctx.sessionProjections.register({
      key: TASK_MARKS_KEY,
      stateSchema: taskMarksStateSchema,
      init: () => null,
      apply: applyTaskMarks,
      stateVersion: 9
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

    // Queued deferred archives for one session: [{ seq, name, foldResultSeq }],
    // empty when none. Populated by successful task_fold closes (reducer),
    // drained by the agent/pre-step auto-folder below.
    function archivesOf(session) {
      try {
        const state = ctx.sessionProjections.stateOf(session, TASK_MARKS_KEY)
        if (state === undefined || state === null) return []
        return Array.isArray(state.pendingArchives) ? state.pendingArchives : []
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
              + '- Begin the summary with the heading line "# ' + closingName + '" — nothing before it. That heading prefixes the structure above: follow it with the five sections exactly as instructed.\n'
              + '- This fold CLOSES the task: no further work belongs to it, so do not report anything as unfinished or pending merely because of how the span ends — this very fold is the task\u0027s ending. Closed is not the same as succeeded: if the work ended in a genuine failure or dead end, report that honestly in Outcomes.\n'
              + '- Do NOT summarize task_begin / task_end calls, their results, or any narration that merely announces starting or finishing the task — that is lifecycle bookkeeping, not content. Summarize the WORK itself.'
            : ''
          // Concrete per-fold budget: ~10% of the span's estimated tokens
          // (chars/4 heuristic), floored so tiny spans still get a usable
          // summary, ceilinged to stay inside the summarizer's maxTokens.
          const estTokens = Math.max(1, Math.floor(JSON.stringify(input.messages).length / 4))
          const wordBudget = Math.min(4000, Math.max(150, Math.floor((estTokens * 0.1) / 1.35)))
          const budgetLine = '\nWord budget for THIS fold: at most ~' + wordBudget + ' words (≈10% of ~' + estTokens + ' estimated span tokens).'
          const messages = [...input.messages, {
            role: 'user',
            content: [{ type: 'text', text: FOLD_SUMMARY_INSTRUCTION + budgetLine + closing }]
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
          // FOLD ARCHIVE SECTION EMBEDDED IN THE SUMMARY NODE (product
          // ruling): this hook is the last stop before the engine commits,
          // and it owns the summary text — so the fold number (existing
          // summaries in THIS session + 1; per-session counters, the
          // event-log lock makes the fold serial) and the artifact
          // (input.messages IS the exact span) are computed HERE and
          // appended as a section formatted like the summary's own five:
          //   ## Fold archive
          //   - fold #N · originals (JSONL, one message per line — span
          //     "Task begun" result … "Task ended" result): <path>
          //   + the complete span preview (preview line N = artifact
          //     line N). The committed node then carries its own recall
          //     handles; no separate notice message is injected at all. If
          //     the engine later rejects the commit, the pre-written
          //     artifact becomes an orphan temp file — harmless.
          const withFooter = [...summary]
          if (withFooter.length > 0) {
            let foldNo = 0
            for (const e of sessionEvents(agent.session)) {
              if (e !== null && typeof e === 'object' && e.type === 'compaction/summary') foldNo += 1
            }
            foldNo += 1
            const name = typeof closingName === 'string' && closingName.length > 0 ? closingName : 'fold'
            const file = writeSpanArtifact(input.messages, name, { sessionDir: sessionArtifactDir(ctx, agent.session), sessionKey: agent.session.id })
            if (file !== undefined) {
              // Markdown-safe formatting: single newlines collapse into one
              // paragraph in every markdown renderer, which mashed the
              // preview into a blob. A fenced code block preserves the
              // per-line layout; a blank line separates the metadata bullet.
              const section = '\n\n## Fold archive\n\n- fold #' + foldNo + ' · originals (JSONL, one message per line — span: just after the "Task begun" result … "Task ended" result): ' + file + '\n\n```\n'
                + renderArchivePreview(input.messages).join('\n') + '\n```'
              const last = withFooter[withFooter.length - 1]
              withFooter[withFooter.length - 1] = { ...last, text: last.text.replace(/\s+$/, '') + section }
            }
          }
          return {
            summary: withFooter,
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

    // ── span artifact: the full original content, as a file ───────────────
    // The span artifact is written by the summarize override directly from
    // input.messages (the engine's own request derivation for the span — the
    // same messages the model was sent, same blocks and order), so the
    // artifact and the footer line inside the summary node are exact.
    // fold_recall({ fold: N }) regenerates it from the append-only log when
    // the temp file is cleaned.

    // ── Full-deferred archive machinery (v9) ─────────────────────────────
    // settledArchives: per-session Set of begin-anchor seqs whose archive is
    // DONE without a fold (too-small at fold time). Process-local bookkeeping
    // only — on replay the entries retry once, hit too-small again, settle
    // again; no persisted state involved.
    const settledArchives = new Map() // session.id → Set<seq>
    // autoFoldFailures: per-session Map(name → reason bucket) rendered as a
    // HOLD warning line while the condition stands (see context callback).
    const autoFoldFailures = new Map() // session.id → Map<name, bucket>

    function isSettledArchive(session, seq) {
      const set = settledArchives.get(session.id)
      return set !== undefined && set.has(seq)
    }

    function markArchiveSettled(session, seq) {
      let set = settledArchives.get(session.id)
      if (set === undefined) { set = new Set(); settledArchives.set(session.id, set) }
      set.add(seq)
    }

    function clearArchiveFailure(session, name) {
      const fails = autoFoldFailures.get(session.id)
      if (fails !== undefined) fails.delete(name)
    }

    function recordArchiveFailure(session, name, bucket) {
      let fails = autoFoldFailures.get(session.id)
      if (fails === undefined) { fails = new Map(); autoFoldFailures.set(session.id, fails) }
      fails.set(name, bucket)
    }

    function failureBucket(category) {
      if (category === 'busy') return 'compaction lock busy'
      if (category === 'engine') return 'engine unavailable'
      if (category === 'changed') return 'surface changed during fold'
      if (category === 'commit') return 'fold failed to commit'
      return 'fold failed'
    }

    function lastSurfaceNode(session) {
      const nodes = session.surface.nodes
      return Array.isArray(nodes) && nodes.length > 0 ? nodes[nodes.length - 1] : -1
    }

    // Turn-signal guard: bound the summarization call so a lost abort signal
    // can never wedge a pre-step. Degrades to the raw signal when the newer
    // AbortSignal combinators are unavailable.
    function guardedSignal(signal) {
      try {
        if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function' && typeof AbortSignal.timeout === 'function' && signal !== undefined) {
          return AbortSignal.any([signal, AbortSignal.timeout(120000)])
        }
      } catch (err) { /* fall through */ }
      return signal
    }

    // Shared fold core: run engine.compactRegion over [startSeq..endSeq] with
    // the balanced-boundary node-by-node fallback (a rejected compactRegion
    // commits nothing, so retries are side-effect free). Returns
    // { tokens, fold, file, preview } on commit, null when nothing foldable
    // sits in the span (tooSmall semantics). Throws classified errors.
    // The caller owns the closingTasks declaration.
    async function foldRegion(session, agent, engine, name, startSeq, endSeq, signal) {
      let result = null
      for (let end = endSeq; end >= startSeq; ) {
        try {
          result = await engine.compactRegion(startSeq, end, agent, signal)
          break
        } catch (err) {
          if (err !== null && typeof err === 'object' && typeof err.message === 'string'
            && err.message.includes('balanced boundary')) {
            // Shrinking the END can never fix an unbalanced START boundary —
            // retrying would walk the whole span pointlessly and end in the
            // silent null-settle path. Fail loud instead: the drain records
            // a failure bucket and the runtime context surfaces it.
            if (err.message.includes('start seq')) throw err
            let prev = -1
            for (const s of session.surface.nodes) {
              if (typeof s === 'number' && s < end && s >= startSeq && s > prev) prev = s
            }
            if (prev === -1) break
            end = prev
            continue
          }
          throw err
        }
      }
      if (result === null) return null
      // Fold number / artifact / preview now live INSIDE the committed
      // summary node (embedded by our summarize override before commit);
      // this core only reports the token count.
      return { tokens: result.shadowedTokenCount }
    }

    let preStepRunning = false

    // The deliverable-gated auto-folder: at every agent step boundary, drain
    // queue entries whose deliverable has landed (deferredArchivePlan gate),
    // innermost (highest seq) first. Serial by construction; the projection
    // state is re-read before EACH entry because a committed fold rewrites
    // the surface (the previous entry's summary may shadow the next entry's
    // anchor — the reducer then drops it and the re-read no longer lists it).
    async function processDeferredArchives(agent, signal) {
      if (preStepRunning) return
      preStepRunning = true
      try {
        const session = agent.session
        for (;;) {
          const entries = archivesOf(session).filter((p) => !isSettledArchive(session, p.seq))
          if (entries.length === 0) return
          entries.sort((a, b) => b.seq - a.seq)
          const p = entries[0]
          // Successor anchors: every begin anchor that is still OPEN or still
          // QUEUED and sits after this entry's close — the region must end
          // before the first of them.
          const anchors = marksOf(session).map((m) => m.seq)
            .concat(archivesOf(session).filter((q) => q.seq !== p.seq).map((q) => q.seq))
          const plan = deferredArchivePlan(p, session.surface.nodes, sessionEvents(session), anchors)
          if (plan.action === 'wait' || plan.action === 'defer') return
          if (plan.action === 'drop') {
            markArchiveSettled(session, p.seq)
            clearArchiveFailure(session, p.name)
            continue
          }
          const engine = await engineFor()
          if (engine === undefined) {
            recordArchiveFailure(session, p.name, 'engine unavailable')
            return
          }
          try {
            closingTasks.set(session.id, p.name)
            const result = await foldRegion(session, agent, engine, p.name, plan.startSeq, plan.endSeq, guardedSignal(signal))
            if (result === null) markArchiveSettled(session, p.seq)
            // No notice message is injected: the committed summary node
            // itself carries the fold number and artifact path (embedded by
            // the summarize override before commit).
            clearArchiveFailure(session, p.name)
            // A committed fold drops the entry via the reducer's
            // compaction/summary handler; loop re-reads state.
          } catch (err) {
            const classified = classifyCategory(err)
            if (classified.category === 'summary') {
              markArchiveSettled(session, p.seq)
              clearArchiveFailure(session, p.name)
              continue
            }
            recordArchiveFailure(session, p.name, failureBucket(classified.category))
            return
          } finally {
            closingTasks.delete(session.id)
          }
        }
      } finally {
        preStepRunning = false
      }
    }

    try {
      // WATERFALL contract: a pre-step listener receives ({ agent, signal },
      // next) and MUST return next() — returning undefined makes the host
      // crash reading decision.kind, and skipping next() wedges the step.
      // The engine's own AUTO compaction registers the same way and awaits
      // its work inside the hook; guardedSignal bounds our fold attempts.
      ctx.on('agent/pre-step', async (payload, next) => {
        const pass = typeof next === 'function' ? () => next() : () => undefined
        try {
          const agent = payload !== null && typeof payload === 'object' ? payload.agent : undefined
          if (agent !== undefined) {
            const signal = payload !== null && typeof payload === 'object' && payload.signal !== undefined ? payload.signal : undefined
            await processDeferredArchives(agent, signal)
          }
        } catch (err) {
          // retried at the next pre-step; never wedge the step
        }
        return pass()
      })
    } catch (err) {
      // Hook unavailable in this host build: queued archives stay unfolded
      // until a manual task_fold supplement; closes still work.
    }

    const taskBegin = {
      name: 'task_begin',
      description: 'Begin a NAMED task. The name is the identity; when the work is done, one task_end({ name }) call ends it and queues archival — the span folds automatically at the next step boundary after your deliverable. A name already open is rejected; names must not contain " —" (a space followed by an em dash). Tasks can nest: task_begin while a task is open opens a subtask (innermost closes first). The call message (with its opening reasoning) stays live in the transcript as the task\'s bookmark; the eventual fold\'s archive starts just after the \'Task begun\' result — the result itself stays live beside the call. Call alone in a step.',
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
        if (name.length === 0) return { ok: false, category: 'invalid', error: 'task_begin requires a non-empty `name` (the identity key task_end will end by)' }
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
      name: 'task_end',
      description: 'End the INNERMOST open task by name: it closes the task and QUEUES archival — the span folds AUTOMATICALLY at the next step boundary after the task\u0027s deliverable/report text lands (possibly mid-turn). So: finish the work, call task_end, then deliver the report in the same turn with full context — the report is text that lands AFTER the task_end result (text in the same assistant message as the call does not count as the deliverable); folding never precedes a deliverable. Folds are system-executed: the committed summary node ends with a Fold archive section (same format as the summary sections) carrying the fold number, the artifact path (JSONL, one message per line — the span runs from just after the \u0027Task begun\u0027 result through the \u0027Task ended\u0027 result, so the task_begin call, its opening reasoning, and the \u0027Task begun\u0027 result itself stay live in the transcript), and a complete span preview of the archived messages — one line per message, no elision (inline when the summary budget allows). LIFO: newer open tasks block older ones; a blocked or unknown name fails and changes nothing (close the newer task first). Too-small spans close without folding; failed auto-folds retry at every step boundary. Failure outcomes are explained in the result; follow it. Call alone in a step.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name of the open task to end (same string given to its task_begin).' }
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
          const open = value.remainingNames.length > 0 ? value.remainingNames.length + ' open: ' + value.remainingNames.join(', ') : 'all closed'
          if (value.unfolded !== undefined) {
            const why = value.unfolded === 'engine'
              ? 'Engine unavailable; task closed without folding.'
              : 'Mark no longer on the surface; task closed without folding.'
            return [{ type: 'text', text: 'Task ended: ' + value.name + ' — ' + open + '. ' + why }]
          }
          // The 'Task ended: ' prefix is LOAD-BEARING — the reducer keys the
          // mark pop AND the pendingArchive registration on it ('Task folded: '
          // from legacy logs still matches).
          return [{ type: 'text', text: 'Task ended: ' + value.name + ' — ' + open + '. Archival queued — the span folds automatically at your next step boundary; deliver your report now with full context.' }]
        }
      },
      async execute(args, exec) {
        const agent = exec.agent
        if (agent === undefined) return { ok: false, category: 'invalid', error: 'task_end requires an agent context' }
        const name = args !== null && typeof args === 'object' ? normalizeName(args.name) : ''
        if (name.length === 0) return { ok: false, category: 'invalid', error: 'task_end requires a non-empty `name`' }
        const session = agent.session
        const marks = marksOf(session)
        const openNamesNow = marks.map((m) => m.name)
        if (!openNamesNow.some((n) => n === name)) {
          const entries = archivesOf(session)
          const queuedNames = entries.filter((p) => !isSettledArchive(session, p.seq)).map((p) => p.name)
          const lists = 'open: ' + (openNamesNow.length > 0 ? openNamesNow.join(', ') : '(none)')
            + (queuedNames.length > 0 ? '; queued for archival (folds automatically): ' + queuedNames.join(', ') : '')
          return { ok: false, category: 'invalid', error: 'no open task named "' + name + '". ' + lists }
        }
        // ── Standard close: LIFO check, then queue the archive.
        const target = closeTarget(marks, name)
        if (target.status === 'lifo') {
          return { ok: false, category: 'invalid', error: 'task "' + name + '" is not the innermost open task; close the newer task(s) first: ' + target.blocking.join(', ') }
        }
        // remaining = the stack minus the matched mark — mirrors the pop.
        const remainingNames = []
        let skipped = false
        for (let i = marks.length - 1; i >= 0; i -= 1) {
          if (!skipped && marks[i].name === name) { skipped = true; continue }
          remainingNames.unshift(marks[i].name)
        }
        if (session.surface.nodes.indexOf(target.mark.seq) === -1) {
          // Degraded close: anchor shadowed (AUTO compaction took the span);
          // the task ends unfolded and NOTHING is queued (a queued archive
          // with a shadowed anchor would be dropped by the reducer anyway).
          return { ok: true, name, remainingNames, unfolded: 'anchor' }
        }
        // Success: the rendered 'Task folded: ' text is the ONLY event the
        // reducer needs — it pops the mark and registers the pendingArchive.
        return { ok: true, name, remainingNames, queued: true }
      }
    }

    ctx.tools.register(taskBegin)
    ctx.tools.register(taskEnd)

    ctx.systemPrompt.section({
      name: 'task-marker-compaction',
      order: 650,
      text: 'MANDATORY task lifecycle discipline: every discrete task MUST be wrapped in task marks. A task is work that produces a verifiable outcome (a fix, a module, an analysis, a delegated review); a single read/grep/probe is a step, not a task — never open a mark for a step, and when in doubt, treat the work as a task (a small fold costs one summary node; an unfolded task costs a degraded context). Before a task, call task_begin({ name }) alone in a step. The moment its work is done, call task_end({ name }) alone in a step: it ends the task and QUEUES archival — then deliver the task\u0027s report or deliverable (to the user, or a subagent\u0027s report to its parent) in the SAME turn, as text AFTER the task_end result and written with FULL context while every detail is still on the surface. The fold itself happens AUTOMATICALLY at the next step boundary after your deliverable lands — possibly mid-turn — so folding never precedes a deliverable and the details you deliver from are never compressed. The mark is a bookmark, not a deadline: while waiting on a background job or user reply, leave it open and do other work; fold when the wait resolves. Multi-part work MUST be split into nested subtasks (innermost closes first); a long detour or dead-end exploration inside a task is one such part — wrap it as a short subtask and close it. Folded details are never lost: list_folds → fold_recall({ fold }) → read/grep the artifact. Recall on demand — when a summary\u0027s anchors fail to answer a concrete question the work or the report needs, or when a new task genuinely depends on an earlier folded task\u0027s details (recall that fold, list_folds → fold_recall → read/grep, before starting it); never guess, never ask the user\u0027s permission to recall, never recall without such a need. Never restate a folded span from memory; never track message positions yourself. Each fold summary node ends with a Fold archive section (fold number, artifact path, and the complete span preview — one line per archived message; fold_recall\u0027s line overload returns any numbered line verbatim). A fold\u0027s archive spans just after the \u0027Task begun\u0027 result through the \u0027Task ended\u0027 result, so the task_begin call, its opening reasoning, and the \u0027Task begun\u0027 result itself stay live. Runtime context carries lifecycle nudges — treat them as directives and act on them.'
    })

    const TASK_TOOL_RE = /^(task_begin|task_end|task_fold|list_folds|fold_recall|todo_write)$/

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
          if (text.indexOf('Task folded: ') === 0 || text.indexOf('Task ended: ') === 0) {
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
            lines.push('Task lifecycle: task "' + oldest.name + '" is 20+ rounds old — if done, call task_end({ name: "' + oldest.name + '" }); if a newer task blocks it, close that first; if it is genuinely waiting on a job or reply, leave it open.')
          }
        }

        // ── Auto-fold failure warning (HOLD) ─────────────────────────────
        // Renders for as long as a queued archive's auto-fold keeps failing
        // (engine busy etc.); retracts when the fold finally commits or the
        // entry settles. Bucket wording is byte-stable per failure cause.
        const fails = autoFoldFailures.get(session.id)
        if (fails !== undefined) {
          for (const [failName, bucket] of fails) {
            lines.push('Task lifecycle: auto-fold for "' + failName.replace(/"/g, "'") + '" is failing (' + bucket + ') — it retries automatically at every step boundary; no action needed.')
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
