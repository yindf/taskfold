// Offline tests for plugins/lifecycle-nudges.mjs — the pure predicates behind
// the runtime-context lifecycle lines. Pins the nested-task targeting contract
// that a live session broke: the 20+-round close pressure must name the
// INNERMOST open mark (an outer mark with an open child cannot be closed and
// is not idle), and a nested begin/end must restart the outer mark's round
// clock, so a parent that just gained a child is not nagged in the very
// snapshot that announces the child.
// Run in-process (the sandbox blocks node --test child processes):
//   node test/lifecycle-nudges.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  innermostMark, latestNestedOutcomeSeq, taskAgeRounds, closePressureLine,
  decomposeHintLine, shouldSuggestDecomposition, taskStackLine,
  DECOMPOSE_NUDGE_MIN_ROUNDS, DECOMPOSE_NUDGE_MAX_ROUNDS
} from '../plugins/lifecycle-nudges.mjs'

const result = (seq, text) => ({ seq, type: 'tool/result', data: { message: { content: [{ type: 'tool-result', content: [{ type: 'text', text }] }] } } })
const assistant = (seq) => ({ seq, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'step' }] } } })
const mark = (seq, name) => ({ seq, name })

test('innermostMark: the highest-seq open mark wins, malformed rows are skipped', () => {
  assert.equal(innermostMark([mark(5, 'outer'), mark(30, 'inner')]).name, 'inner')
  assert.equal(innermostMark([mark(30, 'inner'), mark(5, 'outer')]).name, 'inner', 'order-independent')
  assert.equal(innermostMark([mark(5, 'outer'), null, { name: 'no seq' }, mark(9, 'later')]).name, 'later')
  assert.equal(innermostMark([]), null)
  assert.equal(innermostMark(undefined), null)
  assert.equal(innermostMark('nope'), null)
})

test('latestNestedOutcomeSeq: a nested begin/end advances the anchor, other results do not', () => {
  const events = [
    result(11, 'Task begun: outer'),
    assistant(20),
    result(21, 'read file'),
    assistant(22),
    result(23, 'Task begun: inner'),
    assistant(24),
    result(25, 'Task folded: inner')
  ]
  assert.equal(latestNestedOutcomeSeq(events, 5), 25, 'most recent lifecycle outcome wins')
  assert.equal(latestNestedOutcomeSeq(events, 24), 25, 'only lifecycle results after the mark are considered')
  assert.equal(latestNestedOutcomeSeq(events, 30), 30, 'nothing after the mark -> the mark itself')
  assert.equal(latestNestedOutcomeSeq([result(11, 'Task begun: outer'), result(12, 'grep output')], 20), 20, 'a result before the mark never advances the anchor')
  assert.equal(latestNestedOutcomeSeq([result(11, 'Task begun: outer'), result(12, 'grep output')], 5), 11)
  assert.equal(latestNestedOutcomeSeq([result(12, 'grep output')], 5), 5, 'no lifecycle result -> own seq')
  assert.equal(latestNestedOutcomeSeq([], 7), 7)
  assert.equal(latestNestedOutcomeSeq(null, 7), 7)
})

test('taskAgeRounds: counts rounds after the anchor, capped at 101', () => {
  const events = [result(11, 'Task begun: outer')]
  for (let i = 0; i < 120; i++) events.push(assistant(20 + i))
  assert.equal(taskAgeRounds(events, mark(10, 'outer')), 101, 'cap keeps the wording byte-stable at "100+"')
  assert.equal(taskAgeRounds(events, null), 0)
  assert.equal(taskAgeRounds(events, { name: 'no seq' }), 0)
})

test('taskAgeRounds: the live bug — a fresh nested begin resets the parent clock', () => {
  // Parent opened at seq 10; 25 rounds pass with no nested activity.
  const events = [result(11, 'Task begun: add cache-hit verification')]
  for (let i = 0; i < 25; i++) events.push(assistant(20 + i))
  const parent = mark(10, 'add cache-hit verification')
  assert.equal(taskAgeRounds(events, parent), 25)

  // The child begins (seq 60) and three rounds follow: the parent is no
  // longer "20+ rounds of idle" — the child IS the progress.
  events.push(assistant(60), result(61, 'Task begun: wire verify:cache'), assistant(62), assistant(63), assistant(64))
  assert.equal(taskAgeRounds(events, parent), 3)
  assert.equal(taskAgeRounds(events, mark(60, 'wire verify:cache')), 3)
  const innermost = innermostMark([parent, mark(60, 'wire verify:cache')])
  assert.equal(innermost.name, 'wire verify:cache', 'the nudge targets the child, never the blocked parent')
  assert.equal(taskAgeRounds(events, innermost) < 20, true, 'so no close pressure fires')
})

test('closePressureLine: escalating 20+/50+/100+ buckets, byte-stable inside each', () => {
  // The injection latch publishes on TEXT CHANGE: byte-stability inside a
  // bucket makes one event per bucket; the boundary crossings re-arm it.
  const line = closePressureLine('big task')
  assert.equal(line.includes('20+ rounds'), true, 'age omitted -> lowest bucket')
  assert.equal(closePressureLine('big task', 20), closePressureLine('big task', 49), '20..49 same bytes')
  assert.equal(closePressureLine('big task', 50), closePressureLine('big task', 99), '50..99 same bytes')
  assert.equal(closePressureLine('big task', 100), closePressureLine('big task', 250), '100+ same bytes')
  assert.notEqual(closePressureLine('big task', 49), closePressureLine('big task', 50), 'bucket crossing changes text -> latch re-fires')
  assert.notEqual(closePressureLine('big task', 99), closePressureLine('big task', 100))
  assert.equal(closePressureLine('big task', 50).includes('50+ rounds'), true)
  assert.equal(closePressureLine('big task', 100).includes('100+ rounds'), true)
  assert.equal(closePressureLine('big task', 30).includes('23'), false, 'no drifting numbers inside a bucket')
  assert.equal(line.includes('nested subtasks'), true, 'exit 1: decompose')
  assert.equal(line.includes('task_end({ name: "big task" })'), true, 'exit 2: close')
  assert.equal(line.includes('waiting on a job or reply'), true, 'exit 3: legitimately blocked')
  assert.equal(closePressureLine('a "quoted" name', 60).includes('"a \'quoted\' name"'), true, 'quotes neutralized')
  assert.equal(closePressureLine(undefined, 60).includes('task ""'), true, 'total on garbage')
})

test('decomposeHintLine: byte-stable and quote-safe', () => {
  assert.equal(decomposeHintLine('part work'), decomposeHintLine('part work'))
  assert.equal(decomposeHintLine('a "b"').includes('"a \'b\'"'), true)
})

test('shouldSuggestDecomposition: the 8–19 window hands off to close pressure at 20', () => {
  assert.equal(DECOMPOSE_NUDGE_MIN_ROUNDS, 8)
  assert.equal(DECOMPOSE_NUDGE_MAX_ROUNDS, 19)
  assert.equal(shouldSuggestDecomposition(1, 7, 3), false)
  assert.equal(shouldSuggestDecomposition(1, 8, 3), true)
  assert.equal(shouldSuggestDecomposition(1, 19, 3), true)
  assert.equal(shouldSuggestDecomposition(1, 20, 3), false, '20+ belongs to closePressureLine')
  assert.equal(shouldSuggestDecomposition(1, 8, 2), false, 'needs active work')
  assert.equal(shouldSuggestDecomposition(0, 8, 3), false, 'needs an open mark')
})

test('taskStackLine: the whole stack, shape only — byte-stable while the stack stands still', () => {
  const marks = [mark(5, 'polish: one row per folding task'), mark(30, 'dock layout redesign'), mark(44, 'nudge prints full task stack')]
  assert.equal(
    taskStackLine(marks, [], []),
    'Task lifecycle: task stack — 3 open, outermost first: "polish: one row per folding task" > "dock layout redesign" > "nudge prints full task stack"; nothing folding or pending.'
  )
  // The latch compares published text VERBATIM, so the same stack must render
  // identical bytes however many rounds have passed (seqs are not in the line).
  assert.equal(taskStackLine([mark(105, 'a'), mark(130, 'b')], [], []), taskStackLine([mark(5, 'a'), mark(30, 'b')], [], []))
  // Order is the STACK order it is handed: outermost first, innermost last.
  assert.equal(taskStackLine([mark(30, 'inner'), mark(5, 'outer')], [], []).includes('"inner" > "outer"'), true, 'renderer keeps the given order; the host passes marks stack-ordered')
  // Queued archives and in-flight intents ride in the same line.
  const withTail = taskStackLine(marks, [{ seq: 50, name: 'part 1', foldResultSeq: 55 }], [{ kind: 'begin' }, { kind: 'end' }])
  assert.equal(withTail.includes('1 folding, 1 begin pending, 1 end pending'), true)
  assert.equal(taskStackLine(marks, [{ name: 'x' }], [{ kind: 'begin' }]).includes('1 folding, 1 begin pending.'), true)
  // An empty stack is REPORTED, never hidden: that is the state the
  // begin-nudge needs to be read against.
  assert.equal(taskStackLine([], [], []), 'Task lifecycle: task stack — empty; nothing folding or pending.')
  // Nameless legacy phantoms and garbage never leak into the line.
  assert.equal(taskStackLine([mark(5, ''), null, 'x'], [], []), 'Task lifecycle: task stack — empty; nothing folding or pending.')
  // Names are model-authored text: quotes are neutralized.
  assert.equal(taskStackLine([mark(5, 'a "b"')], [], []).includes('"a \'b\'"'), true)
})
