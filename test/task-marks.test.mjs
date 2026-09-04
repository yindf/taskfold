// Offline tests for the taskMarks projection pieces exported from
// compact-region.mjs: the duck-typed state schema, the reducer, and the pure
// close/fold decision helpers (closeTarget / validTaskName / foldDecision).
// Run in-process (the sandbox blocks node --test child processes):
//   node test/task-marks.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyTaskMarks, taskMarksStateSchema, closeTarget, validTaskName, foldDecision, todoBridgeLine, FOLD_SUMMARY_INSTRUCTION } from '../plugins/compact-region.mjs'

/** assistant/message carrying tool-call blocks (shape per dsh-agent-loop). */
function assistantCall(seq, calls) {
  return {
    seq,
    type: 'assistant/message',
    data: { message: { content: calls.map((c) => ({ type: 'tool-call', id: c.id, name: c.name })) } }
  }
}

/** tool/result in the REAL persisted shape (probed from a live log):
 *  linkage lives in tool-result blocks, not on the message itself. */
function toolResult(callId, text, seq) {
  const event = {
    type: 'tool/result',
    data: {
      message: {
        content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], isError: false }]
      }
    }
  }
  if (seq !== undefined) event.seq = seq
  return event
}

const BEGIN_OK = (n) => 'Task begun: ' + n + ' — 1 open.'
const END_OK = (n) => 'Task folded: ' + n + ' — all closed. Folded #9 (1200 tokens). Original context saved: C:\\tmp\\x.json'
// legacy v3/v4 success texts (still present in existing logs) — kept so the
// reducer's backward path is exercised. They carry no name, so named pop
// cannot match them unless a name equals ''.
const END_LEGACY_COMPACTED = 'Task ended and compacted into one summary node (2845 shadowed tokens estimated, 0 mark(s) still open).\n\nSummary:\n…'

test('schema accepts null and well-formed { pending, marks } states', () => {
  assert.equal(taskMarksStateSchema.parse(null), null)
  const ok = { pending: { c1: { kind: 'begin', anchorSeq: 5 } }, marks: [{ seq: 5, name: 'work' }] }
  assert.equal(taskMarksStateSchema.parse(ok), ok)
})

test('schema rejects malformed persisted state', () => {
  assert.throws(() => taskMarksStateSchema.parse('nope'))
  assert.throws(() => taskMarksStateSchema.parse([]), 'v1 whole-value rows must not pass v5 schema')
  assert.throws(() => taskMarksStateSchema.parse({}))
  assert.throws(() => taskMarksStateSchema.parse({ pending: null, marks: [] }))
  assert.throws(() => taskMarksStateSchema.parse({ pending: {}, marks: [500] }), 'numeric marks are v1, not objects')
  assert.throws(() => taskMarksStateSchema.parse({ pending: {}, marks: [{ seq: 0, name: 'x' }] }))
  assert.throws(() => taskMarksStateSchema.parse({ pending: {}, marks: [{ seq: 5 }] }), 'mark needs a name')
  assert.throws(() => taskMarksStateSchema.parse({ pending: { c: { kind: 'bogus', anchorSeq: 1 } }, marks: [] }))
  assert.throws(() => taskMarksStateSchema.parse({ pending: { c: { kind: 'begin', anchorSeq: -1 } }, marks: [] }))
})

test('begin/end round trip: named push and pop-by-name', () => {
  let state = null
  state = applyTaskMarks(state, assistantCall(100, [{ id: 'c1', name: 'task_begin' }]))
  assert.ok(state !== null && state.pending.c1 !== undefined && state.marks.length === 0,
    'assistant message registers pending intent but does not push')
  state = applyTaskMarks(state, toolResult('c1', BEGIN_OK('alpha'), 101))
  assert.deepEqual(state.marks, [{ seq: 100, name: 'alpha' }], 'success result pushes { seq, name }')
  state = applyTaskMarks(state, assistantCall(200, [{ id: 'c2', name: 'task_begin' }]))
  state = applyTaskMarks(state, toolResult('c2', BEGIN_OK('beta'), 201))
  assert.deepEqual(state.marks, [{ seq: 100, name: 'alpha' }, { seq: 200, name: 'beta' }], 'two names, two marks')
  // Closing by name, OUT OF order: ends 'alpha' first even though 'beta' is
  // the most recent. The REDUCER stays name-keyed on purpose — old logs
  // (recorded before the LIFO rule) must replay byte-identically; the TOOL
  // layer (foldDecision, tested below) now rejects such closes before any
  // event is written.
  state = applyTaskMarks(state, assistantCall(300, [{ id: 'c3', name: 'task_fold' }]))
  state = applyTaskMarks(state, toolResult('c3', END_OK('alpha'), 301))
  assert.deepEqual(state.marks, [{ seq: 200, name: 'beta' }], 'closing by name removes the matching mark')
  // closing 'beta' next
  state = applyTaskMarks(state, assistantCall(400, [{ id: 'c4', name: 'task_fold' }]))
  state = applyTaskMarks(state, toolResult('c4', END_OK('beta'), 401))
  assert.equal(state, null, 'all closed; empty stack with no pending intents normalizes to null')
})

test('closing an unknown name changes nothing', () => {
  let state = null
  state = applyTaskMarks(state, assistantCall(100, [{ id: 'c1', name: 'task_begin' }]))
  state = applyTaskMarks(state, toolResult('c1', BEGIN_OK('alpha'), 101))
  state = applyTaskMarks(state, assistantCall(200, [{ id: 'c2', name: 'task_fold' }]))
  state = applyTaskMarks(state, toolResult('c2', END_OK('nope'), 201))
  assert.deepEqual(state.marks, [{ seq: 100, name: 'alpha' }], 'mismatched name does not pop anything')
})

test('failed results keep the mark exactly like the in-memory era', () => {
  let state = null
  state = applyTaskMarks(state, assistantCall(100, [{ id: 'c1', name: 'task_begin' }]))
  state = applyTaskMarks(state, toolResult('c1', BEGIN_OK('alpha')))
  state = applyTaskMarks(state, assistantCall(200, [{ id: 'c2', name: 'task_fold' }]))
  state = applyTaskMarks(state, toolResult('c2', 'task_end failed (busy): lock active'))
  assert.deepEqual(state.marks, [{ seq: 100, name: 'alpha' }], 'transient failure text does not pop')
  state = applyTaskMarks(state, assistantCall(300, [{ id: 'c3', name: 'task_begin' }]))
  state = applyTaskMarks(state, toolResult('c3', 'task_begin failed: no assistant message found on the surface'))
  assert.deepEqual(state.marks, [{ seq: 100, name: 'alpha' }], 'failed task_begin does not push')
  state = applyTaskMarks(state, toolResult('c9', BEGIN_OK('alpha')))
  assert.deepEqual(state.marks, [{ seq: 100, name: 'alpha' }], 'result without a pending intent is ignored')
})

test('results only count for their own pending callId', () => {
  let state = null
  state = applyTaskMarks(state, assistantCall(100, [{ id: 'c1', name: 'task_begin' }]))
  const withPending = state
  // A different tool's result that happens to carry the success text.
  state = applyTaskMarks(state, toolResult('other', BEGIN_OK('alpha')))
  assert.equal(state, withPending, 'unmatched callId is ignored even with success text')
  state = applyTaskMarks(state, toolResult('c1', BEGIN_OK('alpha')))
  assert.deepEqual(state.marks, [{ seq: 100, name: 'alpha' }])
})

test('unrelated events and turn/start pass through', () => {
  let state = null
  state = applyTaskMarks(state, assistantCall(100, [{ id: 'c1', name: 'task_begin' }]))
  state = applyTaskMarks(state, toolResult('c1', BEGIN_OK('alpha')))
  assert.equal(applyTaskMarks(state, { type: 'todo/write', data: { todos: [] } }), state)
  assert.equal(applyTaskMarks(state, { type: 'turn/start', data: { turn: 2 } }), state, 'tasks span turns')
  assert.equal(applyTaskMarks(state, null), state)
  // Malformed assistant message without message/content changes nothing.
  assert.equal(applyTaskMarks(state, { type: 'assistant/message', data: {} }), state)
  assert.equal(applyTaskMarks(state, { seq: 5, type: 'assistant/message', data: { message: { content: 'not-array' } } }), state)
})

test('legacy task/mark snapshots are authoritative resets that clear pending', () => {
  // The ghost scenario from the live log: a v0-era mark (aborted in memory,
  // never logged) survives pure derivation…
  let state = null
  state = applyTaskMarks(state, assistantCall(100, [{ id: 'c1', name: 'task_begin' }]))
  state = applyTaskMarks(state, toolResult('c1', BEGIN_OK('alpha')))
  state = applyTaskMarks(state, assistantCall(200, [{ id: 'c2', name: 'task_fold' }]))
  state = applyTaskMarks(state, toolResult('c2', 'task_end failed (summary): summary is not smaller…'))
  assert.deepEqual(state.marks, [{ seq: 100, name: 'alpha' }], 'unlogged abort leaves a phantom mark')
  // …until a v1 whole-value snapshot baselines the stack. v1 numeric seqs are
  // DROPPED (v6): they predate named tasks, can never be closed by name, and
  // their spans are long folded. The reset must also consume pending intents.
  state = applyTaskMarks(state, assistantCall(300, [{ id: 'c3', name: 'task_begin' }]))
  state = applyTaskMarks(state, { type: 'task/mark', data: { marks: [300] } })
  assert.equal(state, null, 'snapshot of only-numeric marks drops them all and normalizes to null')
  state = applyTaskMarks(state, toolResult('c3', BEGIN_OK('alpha')))
  assert.equal(state, null, 'result after a cleared snapshot is inert (its pending intent was consumed)')
  // Named marks inside a snapshot pass through.
  state = applyTaskMarks(null, { type: 'task/mark', data: { marks: [{ seq: 42, name: 'beta' }, { seq: 7, name: '' }, 99] } })
  assert.deepEqual(state.marks, [{ seq: 42, name: 'beta' }], 'named snapshot marks kept, nameless/numeric dropped')
  state = applyTaskMarks(state, { type: 'task/mark', data: { marks: [] } })
  assert.equal(state, null, 'empty snapshot normalizes to null')
  assert.equal(applyTaskMarks(null, { type: 'task/mark', data: {} }), null, 'malformed snapshot ignored')
})

test('parallel task tools in one assistant message are all tracked', () => {
  let state = null
  state = applyTaskMarks(state, assistantCall(100, [{ id: 'c1', name: 'task_begin' }, { id: 'c2', name: 'compact' }]))
  assert.ok(state !== null && state.pending.c1 !== undefined, 'task_begin registers pending; compact does not')
  const afterCall = state
  state = applyTaskMarks(state, toolResult('c2', 'Compacted surface positions 1..3…'))
  assert.equal(state, afterCall, 'compact results are not task intents')
  state = applyTaskMarks(state, toolResult('c1', BEGIN_OK('alpha')))
  assert.deepEqual(state.marks, [{ seq: 100, name: 'alpha' }])
})

test('schema self-heals persisted rows carrying nameless phantom marks', () => {
  const phantom = { pending: {}, marks: [{ seq: 211961, name: '' }, { seq: 100, name: 'alpha' }] }
  const healed = taskMarksStateSchema.parse(phantom)
  assert.deepEqual(healed.marks, [{ seq: 100, name: 'alpha' }], 'nameless marks dropped on load, named kept')
  const onlyPhantoms = taskMarksStateSchema.parse({ pending: {}, marks: [{ seq: 1, name: '' }] })
  assert.deepEqual(onlyPhantoms.marks, [], 'all-nameless row heals to an empty stack')
  const ok = { pending: {}, marks: [{ seq: 5, name: 'x' }] }
  assert.equal(taskMarksStateSchema.parse(ok), ok, 'clean rows returned untouched (same reference)')
})

test('name normalization: whitespace and multi-name closing', () => {
  let state = null
  state = applyTaskMarks(state, assistantCall(100, [{ id: 'c1', name: 'task_begin' }]))
  state = applyTaskMarks(state, toolResult('c1', 'Task begun: fix  bug — 1 open: fix  bug. …', 101))
  assert.deepEqual(state.marks, [{ seq: 100, name: 'fix bug' }], 'whitespace collapses to a single space')
  state = applyTaskMarks(state, assistantCall(200, [{ id: 'c2', name: 'task_fold' }]))
  state = applyTaskMarks(state, toolResult('c2', 'Task folded: fix bug — all closed. …', 201))
  assert.equal(state, null, 'normalized name matches despite original multiple spaces; empty state is null')
})

test('validTaskName: rejects empty and delimiter-carrying names', () => {
  assert.equal(validTaskName('alpha'), true)
  assert.equal(validTaskName('fix — part 2'), false, 'the rendered-text delimiter truncates parsing')
  assert.equal(validTaskName(''), false)
  assert.equal(validTaskName(null), false)
  assert.equal(validTaskName(42), false)
  assert.equal(validTaskName('em—dash without spaces'), true, 'only " —" (space + em dash) is the delimiter')
  assert.equal(validTaskName('— leads with bare dash'), true, 'dash without a preceding space never matches the delimiter, so parsing stays lossless')
})

test('closeTarget: four states over the open-mark stack', () => {
  const marks = [{ seq: 10, name: 'alpha' }, { seq: 20, name: 'beta' }, { seq: 30, name: 'gamma' }]
  assert.deepEqual(closeTarget([], 'alpha'), { status: 'empty' })
  assert.deepEqual(closeTarget(marks, 'gamma'), { status: 'ok', mark: { seq: 30, name: 'gamma' } })
  const unknown = closeTarget(marks, 'nope')
  assert.equal(unknown.status, 'unknown')
  assert.deepEqual(unknown.open, ['alpha', 'beta', 'gamma'])
  const lifo = closeTarget(marks, 'alpha')
  assert.equal(lifo.status, 'lifo')
  assert.deepEqual(lifo.mark, { seq: 10, name: 'alpha' })
  assert.deepEqual(lifo.blocking, ['beta', 'gamma'], 'blocking lists newer tasks inside the target, in order')
})

test('closeTarget: duplicate names match the most recent occurrence, blocking deduped', () => {
  // Legacy snapshot can repeat names; the tool layer rejects duplicates.
  const marks = [{ seq: 10, name: 'alpha' }, { seq: 20, name: 'beta' }, { seq: 30, name: 'alpha' }]
  const target = closeTarget(marks, 'alpha')
  assert.equal(target.status, 'ok', 'most recent occurrence IS the stack top here')
  assert.deepEqual(target.mark, { seq: 30, name: 'alpha' })
  const older = closeTarget(marks, 'beta')
  assert.equal(older.status, 'lifo')
  assert.deepEqual(older.blocking, ['alpha'], 'duplicate newer names appear once')
})

test('foldDecision: invalid names, legacy escape hatch, empty stack', () => {
  assert.equal(foldDecision([], 'bad — name', [], true).action, 'invalid', 'delimiter name with no exact mark is invalid')
  assert.equal(foldDecision([{ seq: 5, name: 'bad — name' }], 'bad — name', [5, 6, 7], true).action, 'fold',
    'legacy mark whose stored name is exactly the invalid string stays closable (self-heals)')
  assert.equal(foldDecision([], '', [], true).action, 'invalid')
  assert.equal(foldDecision([], 'alpha', [], true).action, 'invalid', 'empty stack')
})

test('foldDecision: unknown and lifo outcomes', () => {
  const marks = [{ seq: 10, name: 'alpha' }, { seq: 20, name: 'beta' }]
  const nodes = [10, 11, 12, 20, 21, 22, 23]
  const unknown = foldDecision(marks, 'nope', nodes, true)
  assert.equal(unknown.action, 'unknown')
  assert.deepEqual(unknown.open, ['alpha', 'beta'])
  const lifo = foldDecision(marks, 'alpha', nodes, true)
  assert.equal(lifo.action, 'lifo')
  assert.deepEqual(lifo.blocking, ['beta'])
})

test('foldDecision: anchor shadowed by compaction degrades to unfolded', () => {
  const marks = [{ seq: 10, name: 'alpha' }]
  const decision = foldDecision(marks, 'alpha', [30, 31, 32], true)
  assert.equal(decision.action, 'unfolded')
  assert.equal(decision.reason, 'anchor')
  assert.deepEqual(decision.mark, { seq: 10, name: 'alpha' })
})

test('foldDecision: tooSmall precedes the engine check', () => {
  const marks = [{ seq: 10, name: 'alpha' }]
  // Defensive path: malformed descending nodes put the end before the anchor.
  assert.equal(foldDecision(marks, 'alpha', [10, 9], false).action, 'tooSmall')
  // Anchor as the ONLY node still attempts a fold (engineAvailable=false
  // degrades BEFORE the engine call, proving the fold path was taken); the
  // engine's not-smaller rejection later turns tiny spans into runtime tooSmall.
  assert.equal(foldDecision(marks, 'alpha', [10], false).action, 'unfolded')
  assert.equal(foldDecision(marks, 'alpha', [10, 11], true).action, 'fold')
})

test('foldDecision: region runs to the LAST node, never past a self-carrying step', () => {
  const marks = [{ seq: 10, name: 'alpha' }]
  const nodes = [10, 11, 12, 13, 14, 15]
  const plain = foldDecision(marks, 'alpha', nodes, true)
  assert.equal(plain.endSeq, 15, 'task folds run to the live edge — the final body message joins its OWN fold')
  // A host that commits the in-flight step early: the last node is the
  // assistant message carrying this very task_fold call — step back past it.
  const events = [
    { seq: 14, type: 'assistant/message', content: [{ type: 'text', text: 'body' }] },
    { seq: 15, type: 'assistant/message', content: [{ type: 'tool-call', name: 'task_fold' }] }
  ]
  const defended = foldDecision(marks, 'alpha', nodes, true, events)
  assert.equal(defended.action, 'fold')
  assert.equal(defended.endSeq, 14, 'the self-carrying node is excluded from the region')
  // Other tool calls or plain text in the last node fold normally.
  const benign = [
    { seq: 15, type: 'assistant/message', content: [{ type: 'tool-call', name: 'grep' }] }
  ]
  assert.equal(foldDecision(marks, 'alpha', nodes, true, benign).endSeq, 15)
  // Stepping back past the self node must still respect the anchor floor.
  const tight = foldDecision(marks, 'alpha', [10, 11], true, [
    { seq: 11, type: 'assistant/message', content: [{ type: 'tool-call', name: 'task_fold' }] }
  ])
  assert.equal(tight.action, 'fold')
  assert.equal(tight.endSeq, 10, 'single-node region [begin..begin] is a legal (tiny) fold')
})

test('foldDecision: engine unavailable degrades to unfolded; available folds', () => {
  const marks = [{ seq: 10, name: 'alpha' }]
  const nodes = [10, 11, 12, 13, 14, 15]
  const down = foldDecision(marks, 'alpha', nodes, false)
  assert.equal(down.action, 'unfolded')
  assert.equal(down.reason, 'engine')
  const up = foldDecision(marks, 'alpha', nodes, true)
  assert.equal(up.action, 'fold')
  assert.equal(up.startSeq, 10)
  assert.equal(up.endSeq, nodes[nodes.length - 1], 'end is the last surface node')
})

test('todoBridgeLine: roster rendering with names, none, and quote defense', () => {
  assert.equal(todoBridgeLine(['fix-bridge', 'add-tests']),
    'Todo bridge: todos changed; open tasks: "fix-bridge", "add-tests" — keep marks in sync: task_begin for new tasks, task_fold for finished tasks.')
  assert.equal(todoBridgeLine([]), 'Todo bridge: todos changed; open tasks: none — keep marks in sync: task_begin for new tasks, task_fold for finished tasks.')
  // Quotes in task names are neutralized so the roster stays parseable.
  assert.ok(!todoBridgeLine(['say "hi"']).includes('"say "hi""'))
  assert.ok(todoBridgeLine(['say "hi"']).includes("'"))
  // Defensive: non-array / junk input degrades to the empty roster.
  assert.equal(todoBridgeLine(undefined), todoBridgeLine([]))
  assert.equal(todoBridgeLine([null, 42, '', 'ok']).includes('"ok"'), true)
})

test('FOLD_SUMMARY_INSTRUCTION: five-section structure with user-inputs and pitfalls sections', () => {
  // v2 contract: the five section headings, in order.
  const sections = ['## What happened', '## User inputs & decisions', '## Changes', '## Pitfalls & gotchas', '## Outcomes']
  let at = -1
  for (const heading of sections) {
    const idx = FOLD_SUMMARY_INSTRUCTION.indexOf(heading)
    assert.ok(idx !== -1, 'missing heading: ' + heading)
    assert.ok(idx > at, 'heading out of order: ' + heading)
    at = idx
  }
  // The span-scoped philosophy and the new first-class rules survive.
  assert.ok(FOLD_SUMMARY_INSTRUCTION.includes('ONE FOLDED SPAN'))
  assert.ok(FOLD_SUMMARY_INSTRUCTION.includes('especially corrections'), 'user feedback rule present')
  assert.ok(FOLD_SUMMARY_INSTRUCTION.includes('why something failed'), 'pitfall-cause rule present')
  assert.ok(FOLD_SUMMARY_INSTRUCTION.includes('relay'), 'fallback-relay rule present (summary may back a never-sent deliverable)')
  assert.ok(FOLD_SUMMARY_INSTRUCTION.includes('cite its conclusions, not restate'), 'delivered-report citation rule present (Outcomes cites, never restates)')
  assert.ok(FOLD_SUMMARY_INSTRUCTION.includes('paths verbatim'), 'anchor-precision rule present (anchors double as recall grep keywords)')
  // Continuity-checkpoint sections contradict the fold's CLOSED-task contract
  // (they belong to the stock full-context instruction, not to folds).
  for (const banned of ['Pending Jobs', 'Current Work', 'Next Step', 'Primary Request']) {
    assert.ok(!FOLD_SUMMARY_INSTRUCTION.includes(banned), 'banned checkpoint section present: ' + banned)
  }
})

