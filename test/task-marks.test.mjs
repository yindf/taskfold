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

const BEGIN_OK = (n) => 'Task begun: ' + n + ' — 1 open: ' + n + '. Call task_end({ name: \'' + n + '\' }) when this task completes, then task_commit.'
const END_OK = (n) => 'Task ended: ' + n + ' — all marks closed. Recorded for folding — call task_commit (alone in a step) to compress the complete task into one summary node.'
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
  // the most recent — name-keying, no implicit stack corruption.
  state = applyTaskMarks(state, assistantCall(300, [{ id: 'c3', name: 'task_end' }]))
  state = applyTaskMarks(state, toolResult('c3', END_OK('alpha'), 301))
  assert.deepEqual(state.marks, [{ seq: 200, name: 'beta' }], 'closing by name removes the matching mark')
  assert.deepEqual(state.lastEnded, { beginSeq: 100, endSeq: 301, name: 'alpha' }, 'records ended task span + name')
  // closing 'beta' next
  state = applyTaskMarks(state, assistantCall(400, [{ id: 'c4', name: 'task_end' }]))
  state = applyTaskMarks(state, toolResult('c4', END_OK('beta'), 401))
  assert.deepEqual(state.marks, [], 'all closed')
  assert.deepEqual(state.lastEnded, { beginSeq: 200, endSeq: 401, name: 'beta' }, 'empty stack stays alive for pending fold')
  state = applyTaskMarks(state, { seq: 500, type: 'compaction/summary', data: { shadowedSeqs: [401], shadowedRange: { start: 100, end: 401 } } })
  assert.equal(state, null, 'covering fold satisfies the pending request; empty state normalizes to null')
})

test('closing an unknown name changes nothing', () => {
  let state = null
  state = applyTaskMarks(state, assistantCall(100, [{ id: 'c1', name: 'task_begin' }]))
  state = applyTaskMarks(state, toolResult('c1', BEGIN_OK('alpha'), 101))
  state = applyTaskMarks(state, assistantCall(200, [{ id: 'c2', name: 'task_end' }]))
  state = applyTaskMarks(state, toolResult('c2', END_OK('nope'), 201))
  assert.deepEqual(state.marks, [{ seq: 100, name: 'alpha' }], 'mismatched name does not pop anything')
  assert.equal(state.lastEnded, undefined, 'no ended task recorded on name mismatch')
})

test('failed results keep the mark exactly like the in-memory era', () => {
  let state = null
  state = applyTaskMarks(state, assistantCall(100, [{ id: 'c1', name: 'task_begin' }]))
  state = applyTaskMarks(state, toolResult('c1', BEGIN_OK('alpha')))
  state = applyTaskMarks(state, assistantCall(200, [{ id: 'c2', name: 'task_end' }]))
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
  state = applyTaskMarks(state, assistantCall(200, [{ id: 'c2', name: 'task_end' }]))
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

test('lastEnded survives non-covering folds; coverage clears it (seqs or range)', () => {
  let state = null
  state = applyTaskMarks(state, assistantCall(100, [{ id: 'c1', name: 'task_begin' }]))
  state = applyTaskMarks(state, toolResult('c1', BEGIN_OK('alpha'), 101))
  state = applyTaskMarks(state, assistantCall(200, [{ id: 'c2', name: 'task_end' }]))
  state = applyTaskMarks(state, toolResult('c2', END_OK('alpha'), 201))
  assert.deepEqual(state.lastEnded, { beginSeq: 100, endSeq: 201, name: 'alpha' }, 'end-pop records the span + name')
  state = applyTaskMarks(state, { seq: 900, type: 'compaction/summary', data: { shadowedSeqs: [700, 701], shadowedRange: { start: 700, end: 701 } } })
  assert.deepEqual(state.lastEnded, { beginSeq: 100, endSeq: 201, name: 'alpha' }, 'unrelated fold does not satisfy the request')
  state = applyTaskMarks(state, { seq: 950, type: 'compaction/summary', data: { shadowedRange: { start: 100, end: 250 } } })
  assert.equal(state, null, 'range-only coverage satisfies the request; the empty state normalizes to null')
})

test('schema validates optional lastEnded; legacy resets clear it', () => {

  const ok = { pending: {}, marks: [], lastEnded: { beginSeq: 100, endSeq: 201, name: 'alpha' } }
  assert.equal(taskMarksStateSchema.parse(ok), ok)
  assert.throws(() => taskMarksStateSchema.parse({ pending: {}, marks: [], lastEnded: { beginSeq: 0, endSeq: 201, name: 'x' } }))
  assert.throws(() => taskMarksStateSchema.parse({ pending: {}, marks: [], lastEnded: { beginSeq: 100 } }))
  assert.throws(() => taskMarksStateSchema.parse({ pending: {}, marks: [], lastEnded: { beginSeq: 100, endSeq: 201 } }), 'lastEnded needs a name')
  let state = { pending: {}, marks: [], lastEnded: { beginSeq: 100, endSeq: 201, name: 'alpha' } }
  state = applyTaskMarks(state, { type: 'task/mark', data: { marks: [] } })
  assert.equal(state, null, 'legacy whole-value reset also drops the pending fold request')
})

test('schema self-heals persisted rows carrying nameless phantom marks', () => {
  const phantom = { pending: {}, marks: [{ seq: 211961, name: '' }, { seq: 100, name: 'alpha' }] }
  const healed = taskMarksStateSchema.parse(phantom)
  assert.deepEqual(healed.marks, [{ seq: 100, name: 'alpha' }], 'nameless marks dropped on load, named kept')
  const onlyPhantoms = taskMarksStateSchema.parse({ pending: {}, marks: [{ seq: 1, name: '' }] })
  assert.deepEqual(onlyPhantoms.marks, [], 'all-nameless row heals to an empty stack')
  const phantomEnded = taskMarksStateSchema.parse({ pending: {}, marks: [], lastEnded: { beginSeq: 1, endSeq: 2, name: '' } })
  assert.equal(phantomEnded.lastEnded, undefined, 'nameless lastEnded dropped too')
  const ok = { pending: {}, marks: [{ seq: 5, name: 'x' }] }
  assert.equal(taskMarksStateSchema.parse(ok), ok, 'clean rows returned untouched (same reference)')
})

test('name normalization: whitespace and multi-name closing', () => {
  let state = null
  state = applyTaskMarks(state, assistantCall(100, [{ id: 'c1', name: 'task_begin' }]))
  state = applyTaskMarks(state, toolResult('c1', 'Task begun: fix  bug — 1 open: fix  bug. …', 101))
  assert.deepEqual(state.marks, [{ seq: 100, name: 'fix bug' }], 'whitespace collapses to a single space')
  state = applyTaskMarks(state, assistantCall(200, [{ id: 'c2', name: 'task_end' }]))
  state = applyTaskMarks(state, toolResult('c2', 'Task ended: fix bug — all marks closed. …', 201))
  assert.deepEqual(state.marks, [], 'normalized name matches despite original multiple spaces')
})

test('a too-small task_commit verdict durably abandons the ended record', () => {
  let state = null
  state = applyTaskMarks(state, assistantCall(100, [{ id: 'c1', name: 'task_begin' }]))
  state = applyTaskMarks(state, toolResult('c1', BEGIN_OK('alpha4 回归'), 101))
  state = applyTaskMarks(state, assistantCall(200, [{ id: 'c2', name: 'task_end' }]))
  state = applyTaskMarks(state, toolResult('c2', 'Task ended: alpha4 回归 — all marks closed. …', 201))
  assert.ok(state.lastEnded !== undefined, 'ended record awaits its fold')
  // Non-terminal failures keep the record for a retry.
  state = applyTaskMarks(state, assistantCall(250, [{ id: 'cb', name: 'task_commit' }]))
  state = applyTaskMarks(state, toolResult('cb', 'task_commit failed (busy): a compaction lock is active; retry…', 251))
  assert.ok(state.lastEnded !== undefined, 'busy verdict keeps the record for retry')
  // The engine's too-small verdict is terminal — the reducer must abandon.
  state = applyTaskMarks(state, assistantCall(300, [{ id: 'c3', name: 'task_commit' }]))
  state = applyTaskMarks(state, toolResult('c3', 'task_commit failed (summary): the ended task "alpha4 回归" was too small to summarize ("summary is not smaller than the shadowed content (1042 estimated framed tokens >= 838)"); its history stays on the surface as-is', 301))
  assert.ok(state === null || state.lastEnded === undefined, 'summary-failure clears lastEnded (no eternal nudge)')
})
