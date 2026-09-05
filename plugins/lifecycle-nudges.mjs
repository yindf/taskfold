/**
 * Pure lifecycle-nudge predicates for compact-region's todo-bridge context
 * callback. Every function here takes an EVENTS SNAPSHOT (array), never a
 * session: the callback takes ONE sessionEvents() snapshot per render and
 * feeds it to all of them — snapshotting the whole log is O(n), and this
 * callback runs on every request of exactly the long sessions taskfold
 * targets, so it must not happen four times per render.
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
