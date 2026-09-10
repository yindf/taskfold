/**
 * Pure lifecycle-nudge predicates for compact-region's lifecycle notices.
 * Every function here takes an EVENTS SNAPSHOT (array), never a session: the
 * renderer takes ONE sessionEvents() snapshot per render and feeds it to all
 * of them — snapshotting the whole log is O(n), and this runs on every
 * request of exactly the long sessions taskfold targets, so it must not
 * happen four times per render.
 */
import { messageOf, blocksOf, taskResultEventText } from './events.mjs'

const TASK_TOOL_RE = /^(task_begin|task_end|task_fold|list_folds|fold_recall|todo_write)$/

/**
 * The transient todo-bridge line, rendered ONLY on the round right after
 * the model called todo_write (stateless call detection in the context
 * callback). Reports the change plus the open task roster; whether to
 * task_begin or task_end stays the model's call — no conditional nagging.
 */
export function todoBridgeLine(openNames) {
  const names = Array.isArray(openNames) ? openNames.filter((n) => typeof n === 'string' && n !== '') : []
  const roster = names.length > 0 ? names.map((n) => '"' + n.replace(/"/g, "'") + '"').join(', ') : 'none'
  return 'Todo bridge: todo_write was called; open tasks: ' + roster + ' — mirror the plan in marks: as you start a todo item with a verifiable outcome, task_begin a nested mark for it; task_end it when that item is done.'
}

/**
 * The FULL task stack, as one line appended to any live hint (never emitted
 * on its own — see compact-region.mjs: a standing state line would re-inject
 * after every lifecycle call, and depth already rides in every
 * task_begin/task_end result).
 *
 * BYTE-STABLE BY CONSTRUCTION: it carries the stack SHAPE only — names in
 * stack order (outermost first, innermost last), the open count, and the
 * counts of queued archives and in-flight intents. No round ages and no seqs:
 * the hint channel compares published text verbatim (planLifecycleInjection),
 * so a number that drifts per round would re-arm the latch every round.
 * Names are model-authored text and are quoted with double quotes escaped.
 */
export function taskStackLine(marks, archives, pending) {
  const names = (Array.isArray(marks) ? marks : [])
    .filter((m) => m !== null && typeof m === 'object' && typeof m.name === 'string' && m.name !== '')
    .map((m) => '"' + m.name.replace(/"/g, "'") + '"')
  const folding = (Array.isArray(archives) ? archives : [])
    .filter((a) => a !== null && typeof a === 'object' && typeof a.name === 'string' && a.name !== '').length
  let begin = 0
  let end = 0
  for (const p of (Array.isArray(pending) ? pending : [])) {
    if (p === null || typeof p !== 'object') continue
    if (p.kind === 'begin') begin += 1
    else if (p.kind === 'end') end += 1
  }
  const counts = []
  if (folding > 0) counts.push(folding + ' folding')
  if (begin > 0) counts.push(begin + ' begin pending')
  if (end > 0) counts.push(end + ' end pending')
  const tail = counts.length > 0 ? counts.join(', ') : 'nothing folding or pending'
  if (names.length === 0) return 'Task lifecycle: task stack — empty; ' + tail + '.'
  return 'Task lifecycle: task stack — ' + names.length + ' open, outermost first: ' + names.join(' > ') + '; ' + tail + '.'
}

/**
 * Decomposition nudge (Nudge 3) window. Fires in the coverage GAP between
 * a task's opening (nothing to decompose yet) and Nudge 2's close
 * pressure (20+ rounds): while an open mark is 8–19 rounds old and real
 * work keeps happening, the model gets a HOLD hint to wrap the remaining
 * distinct parts as nested subtasks. Upper bound 19 hands off cleanly to
 * Nudge 2 at 20 — decompose and close-nag never render together.
 */
export const DECOMPOSE_NUDGE_MIN_ROUNDS = 8
export const DECOMPOSE_NUDGE_MAX_ROUNDS = 19

export function shouldSuggestDecomposition(depth, oldestAge, workCallCount) {
  return depth >= 1
    && oldestAge >= DECOMPOSE_NUDGE_MIN_ROUNDS
    && oldestAge <= DECOMPOSE_NUDGE_MAX_ROUNDS
    && workCallCount >= 3
}

export function decomposeHintLine(name) {
  const safe = typeof name === 'string' ? name.replace(/"/g, "'") : ''
  return 'Task lifecycle: task "' + safe + '" has been open 8+ rounds with active work — if the remaining work has distinct parts, wrap each part as a nested subtask: task_begin({ name: "part" }) when starting it, task_end when that part\u0027s outcome is verifiable; innermost closes first, each part folds at its own close.'
}

/**
 * The nudge TARGET: the INNERMOST open mark — the last pushed, i.e. the
 * highest seq. Close pressure and decomposition hints belong on the task the
 * model is actually working on: an outer mark with an open child cannot be
 * closed (LIFO) and is not idle, so nagging it is noise. Selecting the
 * innermost is also the reset the model expects — a fresh nested begin
 * silences the outer close-pressure line with no extra state.
 */
export function innermostMark(marks) {
  const list = Array.isArray(marks) ? marks : []
  let best = null
  for (const m of list) {
    if (m === null || typeof m !== 'object' || !Number.isInteger(m.seq)) continue
    if (best === null || m.seq > best.seq) best = m
  }
  return best
}

/**
 * Age anchor for one mark: its own begin seq, advanced past the most recent
 * nested lifecycle outcome ('Task begun: ' / 'Task ended: ' result) after it.
 * Opening or closing a subtask is progress ON the parent, so the parent's
 * round clock restarts — otherwise a parent that just gained a child is
 * immediately nagged to close (observed live: parent 'add cache-hit …' was
 * flagged 20+ rounds in the very snapshot right after its child began).
 */
export function latestNestedOutcomeSeq(events, seq) {
  const list = Array.isArray(events) ? events : []
  let anchor = seq
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i]
    if (e === null || typeof e !== 'object' || !Number.isInteger(e.seq)) continue
    if (e.seq <= seq) break
    if (e.type !== 'tool/result') continue
    const text = taskResultEventText(e)
    if (text.indexOf('Task begun: ') === 0 || text.indexOf('Task ended: ') === 0 || text.indexOf('Task folded: ') === 0) { anchor = e.seq; break }
  }
  return anchor
}

/**
 * Rounds (assistant messages) since the mark's activity anchor, capped.
 * Cap 101: the close-pressure wording tops out at "100+ rounds", so the
 * backward scan never needs an exact count past 100 — bounded cost, exact
 * enough text.
 */
export function taskAgeRounds(events, mark) {
  if (mark === null || typeof mark !== 'object' || !Number.isInteger(mark.seq)) return 0
  return countAssistantSince(events, latestNestedOutcomeSeq(events, mark.seq), 101)
}

export const CLOSE_PRESSURE_MIN_ROUNDS = 20

/**
 * Close-pressure line, escalating in byte-stable buckets (20+ / 50+ /
 * 100+ rounds). Within a bucket the wording never changes (no "~23"
 * drift), so the injection latch publishes it exactly once; crossing
 * into the next bucket changes the text, which re-arms the latch and
 * fires one fresh event per milestone — sustained pressure on a stuck
 * task without per-round spam (the pre-bucket single "20+" line fired
 * once and then went silent for 180+ observed rounds). The line states
 * BOTH exits — decompose into nested parts, or close — because a task
 * open this long is as often under-structured as it is finished. The
 * waiting escape stays last so a genuinely blocked task is never pushed
 * into a bogus close.
 */
export function closePressureLine(name, age) {
  const safe = typeof name === 'string' ? name.replace(/"/g, "'") : ''
  const rounds = Number.isInteger(age) ? age : CLOSE_PRESSURE_MIN_ROUNDS
  const label = rounds >= 100 ? '100+' : rounds >= 50 ? '50+' : '20+'
  return 'Task lifecycle: task "' + safe + '" has been open ' + label + ' rounds — either wrap the remaining distinct parts as nested subtasks (task_begin each part, task_end it when that part\u0027s outcome is verifiable), or, if the task is done, call task_end({ name: "' + safe + '" }). If it is genuinely waiting on a job or reply, leave it open.'
}

/** Count non-task tool calls in the last 10 assistant messages. */
export function recentWorkCallCount(events) {
  const list = Array.isArray(events) ? events : []
  let assistantSeen = 0
  let workCalls = 0
  for (let i = list.length - 1; i >= 0 && assistantSeen < 10; i--) {
    const e = list[i]
    if (e === null || typeof e !== 'object' || e.type !== 'assistant/message') continue
    assistantSeen++
    for (const b of blocksOf(messageOf(e))) {
      if (b !== null && typeof b === 'object' && b.type === 'tool-call' && !TASK_TOOL_RE.test(String(b.name))) workCalls++
    }
  }
  return workCalls
}

/**
 * True when the MOST RECENT assistant message contains a todo_write
 * tool-call block — the model just updated its todo list, so the next
 * request carries the todo-bridge report line. Stateless: derived from
 * the event log alone, no cross-render memory.
 */
export function lastAssistantHasTodoWrite(events) {
  const list = Array.isArray(events) ? events : []
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i]
    if (e === null || typeof e !== 'object' || e.type !== 'assistant/message') continue
    return blocksOf(messageOf(e)).some((b) => b !== null && typeof b === 'object' && b.type === 'tool-call' && String(b.name) === 'todo_write')
  }
  return false
}

/**
 * Model rounds since the most recent 'Task folded: '/'Task ended: '
 * result. Used to grace-suppress the begin-nudge right after a task
 * closes. Bounded backward scan; returns a large number when no outcome
 * exists.
 */
export function roundsSinceFoldOutcome(events) {
  const list = Array.isArray(events) ? events : []
  const floor = Math.max(0, list.length - 300)
  for (let i = list.length - 1; i >= floor; i--) {
    const e = list[i]
    if (e === null || typeof e !== 'object' || e.type !== 'tool/result') continue
    if (!Number.isInteger(e.seq)) continue
    const text = taskResultEventText(e)
    if (text.indexOf('Task folded: ') === 0 || text.indexOf('Task ended: ') === 0) {
      return countAssistantSince(list, e.seq, 4)
    }
  }
  return Number.MAX_SAFE_INTEGER
}

/**
 * Count assistant messages appended AFTER `seq`, capped at `cap` hits.
 *
 * Ages are measured in MODEL ROUNDS (assistant messages), not raw seq
 * distance: one tool call can append anywhere from a handful to thousands
 * of events, so seq deltas are meaningless as "time". The scan is bounded
 * (stops at `seq` or after `cap` hits), so cost per request is negligible.
 */
export function countAssistantSince(events, seq, cap) {
  const list = Array.isArray(events) ? events : []
  let count = 0
  for (let i = list.length - 1; i >= 0 && count < cap; i--) {
    const e = list[i]
    if (e === null || typeof e !== 'object') continue
    if (Number.isInteger(e.seq) && e.seq <= seq) break
    if (e.type === 'assistant/message') count++
  }
  return count
}
