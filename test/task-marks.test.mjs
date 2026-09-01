// Offline tests for the taskMarks projection pieces exported from
// compact-region.mjs (v2: derived from native events): the duck-typed state
// schema and the reducer. Run in-process (the sandbox blocks node --test
// child processes):
//   node test/task-marks.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyTaskMarks, taskMarksStateSchema } from '../plugins/compact-region.mjs'

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

const BEGIN_OK = 'Task mark set (depth 1). Call task_end alone in a step when this task completes.'
const END_COMPACTED = 'Task ended and compacted into one summary node (2845 shadowed tokens estimated, 0 mark(s) still open).\n\nSummary:\n…'
const END_TOO_SMALL = 'Task ended without compaction (0 mark(s) still open): the span was too small…'
const END_TWOPHASE = 'Task ended — all marks closed. The complete task span (its task_begin pair, body, and this pair) folds into one summary node automatically next; if the span is too small it stays as-is. Original entries stay archived in the event log — compact_recall reads them back by seq.\nTitle: two-phase fold'

test('schema accepts null and well-formed { pending, marks } states', () => {
  assert.equal(taskMarksStateSchema.parse(null), null)
  const ok = { pending: { c1: { kind: 'begin', anchorSeq: 5 } }, marks: [5] }
  assert.equal(taskMarksStateSchema.parse(ok), ok)
})

test('schema rejects malformed persisted state', () => {
  assert.throws(() => taskMarksStateSchema.parse('nope'))
  assert.throws(() => taskMarksStateSchema.parse([]), 'v1 whole-value rows must not pass v2 schema')
  assert.throws(() => taskMarksStateSchema.parse({}))
  assert.throws(() => taskMarksStateSchema.parse({ pending: null, marks: [] }))
  assert.throws(() => taskMarksStateSchema.parse({ pending: {}, marks: [0] }))
  assert.throws(() => taskMarksStateSchema.parse({ pending: { c: { kind: 'bogus', anchorSeq: 1 } }, marks: [] }))
  assert.throws(() => taskMarksStateSchema.parse({ pending: { c: { kind: 'begin', anchorSeq: -1 } }, marks: [] }))
})

test('successful begin/end round trip: push on result text, pop on result text', () => {
  let state = null
  state = applyTaskMarks(state, assistantCall(100, [{ id: 'c1', name: 'task_begin' }]))
  assert.ok(state !== null && state.pending.c1 !== undefined && state.marks.length === 0,
    'assistant message registers pending intent but does not push')
  state = applyTaskMarks(state, toolResult('c1', BEGIN_OK, 101))
  assert.deepEqual(state.marks, [100], 'success result pushes the anchor seq')
  state = applyTaskMarks(state, assistantCall(200, [{ id: 'c2', name: 'task_begin' }]))
  state = applyTaskMarks(state, toolResult('c2', BEGIN_OK, 201))
  assert.deepEqual(state.marks, [100, 200], 'nesting pushes LIFO')
  state = applyTaskMarks(state, assistantCall(300, [{ id: 'c3', name: 'task_end' }]))
  assert.deepEqual(state.marks, [100, 200], 'task_end call alone does not pop yet')
  state = applyTaskMarks(state, toolResult('c3', END_COMPACTED, 301))
  assert.deepEqual(state.marks, [100], 'success result pops innermost')
  assert.deepEqual(state.lastEnded, { beginSeq: 200, endSeq: 301 }, 'end-pop records the ended task span')
  state = applyTaskMarks(state, assistantCall(400, [{ id: 'c4', name: 'task_end' }]))
  state = applyTaskMarks(state, toolResult('c4', END_TOO_SMALL, 401))
  assert.deepEqual(state.marks, [], 'compacted:false still pops')
  assert.deepEqual(state.lastEnded, { beginSeq: 100, endSeq: 401 }, 'empty stack stays alive for the pending fold')
  state = applyTaskMarks(state, { seq: 500, type: 'compaction/summary', data: { shadowedSeqs: [100, 101, 200, 201, 300, 301, 400, 401], shadowedRange: { start: 100, end: 401 } } })
  assert.equal(state, null, 'covering fold satisfies the pending request; empty state normalizes to null')
})

test('failed results keep the mark exactly like the in-memory era', () => {
  let state = null
  state = applyTaskMarks(state, assistantCall(100, [{ id: 'c1', name: 'task_begin' }]))
  state = applyTaskMarks(state, toolResult('c1', BEGIN_OK))
  state = applyTaskMarks(state, assistantCall(200, [{ id: 'c2', name: 'task_end' }]))
  state = applyTaskMarks(state, toolResult('c2', 'task_end failed (busy): lock active [open marks: 1]'))
  assert.deepEqual(state.marks, [100], 'transient failure text does not pop')
  state = applyTaskMarks(state, assistantCall(300, [{ id: 'c3', name: 'task_begin' }]))
  state = applyTaskMarks(state, toolResult('c3', 'task_begin failed: no assistant message found on the surface'))
  assert.deepEqual(state.marks, [100], 'failed task_begin does not push')
  state = applyTaskMarks(state, toolResult('c9', BEGIN_OK))
  assert.deepEqual(state.marks, [100], 'result without a pending intent is ignored')
})

test('results only count for their own pending callId', () => {
  let state = null
  state = applyTaskMarks(state, assistantCall(100, [{ id: 'c1', name: 'task_begin' }]))
  const withPending = state
  // A different tool's result that happens to carry the success text.
  state = applyTaskMarks(state, toolResult('other', BEGIN_OK))
  assert.equal(state, withPending, 'unmatched callId is ignored even with success text')
  state = applyTaskMarks(state, toolResult('c1', BEGIN_OK))
  assert.deepEqual(state.marks, [100])
})

test('unrelated events and turn/start pass through', () => {
  let state = null
  state = applyTaskMarks(state, assistantCall(100, [{ id: 'c1', name: 'task_begin' }]))
  state = applyTaskMarks(state, toolResult('c1', BEGIN_OK))
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
  state = applyTaskMarks(state, toolResult('c1', BEGIN_OK))
  state = applyTaskMarks(state, assistantCall(200, [{ id: 'c2', name: 'task_end' }]))
  state = applyTaskMarks(state, toolResult('c2', 'task_end failed (summary): summary is not smaller…'))
  assert.deepEqual(state.marks, [100], 'unlogged abort leaves a phantom mark')
  // …until a v1 whole-value snapshot baselines the stack. Note the real
  // interleaving: snapshot lands BETWEEN the new call and its result, and
  // the reset must consume that pending intent so the result cannot
  // double-apply.
  state = applyTaskMarks(state, assistantCall(300, [{ id: 'c3', name: 'task_begin' }]))
  state = applyTaskMarks(state, { type: 'task/mark', data: { marks: [300] } })
  assert.deepEqual(state.marks, [300], 'snapshot replaces the whole stack')
  assert.equal(state.pending.c3, undefined, 'snapshot clears pending intents')
  state = applyTaskMarks(state, toolResult('c3', BEGIN_OK))
  assert.deepEqual(state.marks, [300], 'result after a snapshot is inert')
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
  state = applyTaskMarks(state, toolResult('c1', BEGIN_OK))
  assert.deepEqual(state.marks, [100])
})

test('lastEnded survives non-covering folds; coverage clears it (seqs or range)', () => {
  let state = null
  state = applyTaskMarks(state, assistantCall(100, [{ id: 'c1', name: 'task_begin' }]))
  state = applyTaskMarks(state, toolResult('c1', BEGIN_OK, 101))
  state = applyTaskMarks(state, assistantCall(200, [{ id: 'c2', name: 'task_end' }]))
  state = applyTaskMarks(state, toolResult('c2', END_TWOPHASE, 201))
  assert.deepEqual(state.lastEnded, { beginSeq: 100, endSeq: 201 }, 'two-phase end-pop records the span')
  state = applyTaskMarks(state, { seq: 900, type: 'compaction/summary', data: { shadowedSeqs: [700, 701], shadowedRange: { start: 700, end: 701 } } })
  assert.deepEqual(state.lastEnded, { beginSeq: 100, endSeq: 201 }, 'unrelated fold does not satisfy the request')
  state = applyTaskMarks(state, { seq: 950, type: 'compaction/summary', data: { shadowedRange: { start: 100, end: 250 } } })
  assert.equal(state, null, 'range-only coverage satisfies the request; the empty state normalizes to null')
})

test('schema validates optional lastEnded; legacy resets clear it', () => {
  const ok = { pending: {}, marks: [], lastEnded: { beginSeq: 100, endSeq: 201 } }
  assert.equal(taskMarksStateSchema.parse(ok), ok)
  assert.throws(() => taskMarksStateSchema.parse({ pending: {}, marks: [], lastEnded: { beginSeq: 0, endSeq: 201 } }))
  assert.throws(() => taskMarksStateSchema.parse({ pending: {}, marks: [], lastEnded: { beginSeq: 100 } }))
  let state = { pending: {}, marks: [], lastEnded: { beginSeq: 100, endSeq: 201 } }
  state = applyTaskMarks(state, { type: 'task/mark', data: { marks: [] } })
  assert.equal(state, null, 'legacy whole-value reset also drops the pending fold request')
})
