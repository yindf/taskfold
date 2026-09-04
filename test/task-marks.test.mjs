// Offline tests for the taskMarks projection pieces exported from
// compact-region.mjs: the duck-typed state schema, the reducer, and the pure
// close/fold decision helpers (closeTarget / validTaskName / deferredArchivePlan).
// Run in-process (the sandbox blocks node --test child processes):
//   node test/task-marks.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyTaskMarks, taskMarksStateSchema, closeTarget, validTaskName, todoBridgeLine, deferredArchivePlan, FOLD_SUMMARY_INSTRUCTION } from '../plugins/compact-region.mjs'

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
  // layer (closeTarget, tested below) now rejects such closes before any
  // event is written.
  state = applyTaskMarks(state, assistantCall(300, [{ id: 'c3', name: 'task_fold' }]))
  state = applyTaskMarks(state, toolResult('c3', END_OK('alpha'), 301))
  assert.deepEqual(state.marks, [{ seq: 200, name: 'beta' }], 'closing by name removes the matching mark')
  // closing 'beta' next
  state = applyTaskMarks(state, assistantCall(400, [{ id: 'c4', name: 'task_fold' }]))
  state = applyTaskMarks(state, toolResult('c4', END_OK('beta'), 401))
  // v9 full-deferred: closes leave queued archives until a compaction event
  // shadows their anchors.
  assert.deepEqual(state.marks, [], 'all marks popped')
  assert.deepEqual(state.pendingArchives, [
    { seq: 100, name: 'alpha', foldResultSeq: 301 },
    { seq: 200, name: 'beta', foldResultSeq: 401 }
  ], 'both closes queued their archives')
  // Archive closure: the alpha fold shadows seq 100 → that entry drops;
  // beta's stays.
  state = applyTaskMarks(state, { seq: 500, type: 'compaction/summary', data: { shadowedSeqs: [100, 250, 300, 301], shadowedTokenCount: 9 } })
  assert.deepEqual(state.pendingArchives, [{ seq: 200, name: 'beta', foldResultSeq: 401 }], 'shadowed anchor drops its archive entry')
  state = applyTaskMarks(state, { seq: 600, type: 'compaction/summary', data: { shadowedSeqs: [200, 400, 401], shadowedTokenCount: 9 } })
  assert.equal(state, null, 'all archives settled; state normalizes to null')
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
  assert.deepEqual(state.marks, [], 'normalized name matches despite original multiple spaces')
  assert.deepEqual(state.pendingArchives, [{ seq: 100, name: 'fix bug', foldResultSeq: 201 }], 'the close queued its archive')
})

test('task_end result prefix pops the mark and queues, legacy Task folded still replays', () => {
  let state = null
  state = applyTaskMarks(state, assistantCall(290, [{ id: 'b0', name: 'task_begin' }]))
  state = applyTaskMarks(state, toolResult('b0', 'Task begun: modern task — 1 open. …', 291))
  state = applyTaskMarks(state, assistantCall(300, [{ id: 'e1', name: 'task_end' }]))
  state = applyTaskMarks(state, toolResult('e1', 'Task ended: modern task — all closed. Archival queued — …', 301))
  assert.deepEqual(state.marks, [], 'new prefix pops the mark')
  assert.deepEqual(state.pendingArchives, [{ seq: 290, name: 'modern task', foldResultSeq: 301 }], 'new prefix queues the archive')
  state = applyTaskMarks(state, assistantCall(350, [{ id: 'b1', name: 'task_begin' }]))
  state = applyTaskMarks(state, toolResult('b1', 'Task begun: legacy replay — 1 open. …', 351))
  state = applyTaskMarks(state, assistantCall(400, [{ id: 'e2', name: 'task_fold' }]))
  state = applyTaskMarks(state, toolResult('e2', 'Task folded: legacy replay — all closed. …', 401))
  assert.deepEqual(state.marks, [], 'legacy prefix still accepted on old-log replay')
  assert.deepEqual(state.pendingArchives.some((p) => p.name === 'legacy replay'), true, 'legacy close queues too')
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

test('todoBridgeLine: roster rendering with names, none, and quote defense', () => {
  assert.equal(todoBridgeLine(['fix-bridge', 'add-tests']),
    'Todo bridge: todo_write was called; open tasks: "fix-bridge", "add-tests" — keep marks in sync: task_begin for new tasks, task_end for finished tasks.')
  assert.equal(todoBridgeLine([]), 'Todo bridge: todo_write was called; open tasks: none — keep marks in sync: task_begin for new tasks, task_end for finished tasks.')
  // Quotes in task names are neutralized so the roster stays parseable.
  assert.ok(!todoBridgeLine(['say "hi"']).includes('"say "hi""'))
  assert.ok(todoBridgeLine(['say "hi"']).includes("'"))
  // Defensive: non-array / junk input degrades to the empty roster.
  assert.equal(todoBridgeLine(undefined), todoBridgeLine([]))
  assert.equal(todoBridgeLine([null, 42, '', 'ok']).includes('"ok"'), true)
})

/** assistant/message helper for the deferred-archive gate tests. */
function assistantMsg(seq, blocks) {
  return { seq, type: 'assistant/message', data: { message: { content: blocks } } }
}

/** tool/result event helper carrying one text tool-result. */
function toolResultEvent(seq, text) {
  return { seq, type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'r' + seq, content: [{ type: 'text', text }] }] } } }
}

test('deferredArchivePlan: the deliverable gate (wait / fold / defer / drop)', () => {
  const p = { seq: 10, name: 'alpha', foldResultSeq: 25 }
  const begun = toolResultEvent(11, 'Task begun: alpha — 1 open.')
  const nodes = [10, 11, 15, 20, 25, 30, 35]
  // ① No deliverable after the close → never fold (reasoning and tool calls
  // do NOT count as deliverables).
  const reasoningOnly = [begun, assistantMsg(30, [{ type: 'reasoning', text: 'thinking…' }, { type: 'tool-call', id: 'c', name: 'read', arguments: '{}' }])]
  assert.equal(deferredArchivePlan(p, nodes, reasoningOnly, []).action, 'wait', 'reasoning/tool-call steps are not deliverables')
  // ② Deliverable text landed, no successor anchor → fold, bracketed by the
  // two lifecycle RESULTS: startSeq is the "Task begun" result's seq, endSeq
  // is the close result's own seq; the begin CALL (seq 10) stays on the
  // surface, and so does everything after the end.
  const delivered = [...reasoningOnly, assistantMsg(35, [{ type: 'text', text: 'final report' }])]
  const plan = deferredArchivePlan(p, nodes, delivered, [])
  assert.equal(plan.action, 'fold')
  assert.equal(plan.startSeq, 11, 'span opens at the "Task begun" result, not the call')
  assert.equal(plan.endSeq, 25, 'span closes at the close result — never the deliverable')
  // ③ Successor anchor open with deliverable before it → same
  // result..result region (successors sit after the end by construction).
  const trimNodes = [10, 11, 15, 20, 25, 28, 30, 35]
  const earlyDeliverable = [begun, assistantMsg(28, [{ type: 'text', text: 'final report' }])]
  const withSuccessor = deferredArchivePlan(p, trimNodes, earlyDeliverable, [30])
  assert.equal(withSuccessor.action, 'fold')
  assert.equal(withSuccessor.endSeq, 25, 'region still ends at the close result')
  // ④ Deliverable AFTER the successor anchor (out-of-order close) → defer.
  const lateDeliverable = [begun, assistantMsg(40, [{ type: 'text', text: 'late report' }])]
  assert.equal(deferredArchivePlan(p, [...trimNodes, 40], lateDeliverable, [30]).action, 'defer')
  // ⑤ Anchor shadowed (AUTO compaction took seq 10 off the surface) → drop.
  assert.equal(deferredArchivePlan(p, [11, 15, 20, 25, 30], delivered, []).action, 'drop')
  // ⑥ Close result shadowed (AUTO compaction took seq 25 off the surface) →
  // the span's end is gone; drop rather than fold a truncated region.
  assert.equal(deferredArchivePlan(p, [10, 11, 15, 20, 30, 35], delivered, []).action, 'drop')
  // ⑦ "Task begun" result shadowed while the call is still on the surface →
  // fall back to the v0.18 region (fold from the call) rather than drop.
  const fallback = deferredArchivePlan(p, [10, 15, 20, 25, 30, 35], delivered, [])
  assert.equal(fallback.action, 'fold')
  assert.equal(fallback.startSeq, 10, 'shadowed begin result folds from the call itself')
  // ⑧ Legacy events without any "Task begun" result → same fallback.
  const legacy = deferredArchivePlan(p, nodes, delivered.filter((e) => e !== begun), [])
  assert.equal(legacy.action, 'fold')
  assert.equal(legacy.startSeq, 10, 'legacy spans fold from the call, exactly like v0.18')
  // Empty-text deliverables do not count.
  const blank = [begun, assistantMsg(30, [{ type: 'text', text: '   ' }])]
  assert.equal(deferredArchivePlan(p, nodes, blank, []).action, 'wait', 'whitespace-only text is not a deliverable')
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
  assert.ok(FOLD_SUMMARY_INSTRUCTION.includes('\'Task begun\' result'), 'span bracket declared: opens at the Task begun result, closes at the Task ended result')
  assert.ok(FOLD_SUMMARY_INSTRUCTION.includes('especially corrections'), 'user feedback rule present')
  assert.ok(FOLD_SUMMARY_INSTRUCTION.includes('why something failed'), 'pitfall-cause rule present')
  assert.ok(FOLD_SUMMARY_INSTRUCTION.includes('relay'), 'fallback-relay rule present (summary may back a never-sent deliverable)')
  assert.ok(FOLD_SUMMARY_INSTRUCTION.includes('cite its conclusions, not restate'), 'delivered-report citation rule present (Outcomes cites, never restates)')
  assert.ok(FOLD_SUMMARY_INSTRUCTION.includes('paths verbatim'), 'anchor-precision rule present (anchors double as recall grep keywords)')
  assert.ok(FOLD_SUMMARY_INSTRUCTION.includes('exempt from these caps'), 'user-inputs section is exempt from the caps, not in conflict with them')
  assert.ok(FOLD_SUMMARY_INSTRUCTION.includes('stay grep-able later'), 'changes are durable grep-able artifacts; commands belong to What happened')
  // Continuity-checkpoint sections contradict the fold's CLOSED-task contract
  // (they belong to the stock full-context instruction, not to folds).
  for (const banned of ['Pending Jobs', 'Current Work', 'Next Step', 'Primary Request']) {
    assert.ok(!FOLD_SUMMARY_INSTRUCTION.includes(banned), 'banned checkpoint section present: ' + banned)
  }
})

