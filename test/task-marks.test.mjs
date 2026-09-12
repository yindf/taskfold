// Offline tests for the taskMarks projection pieces exported from
// plugins/task-marks.mjs: the duck-typed state schema, the reducer, and the
// pure close/fold decision helpers (closeTarget / validTaskName /
// deferredArchivePlan). Instruction contracts live in fold-instruction.mjs,
// the todo-bridge line in lifecycle-nudges.mjs.
// Run in-process (the sandbox blocks node --test child processes):
//   node test/task-marks.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyTaskMarks, taskMarksStateSchema, closeTarget, validTaskName, deferredArchivePlan, siblingTaskMarkCalls, lastAssistantToolNames } from '../plugins/task-marks.mjs'
import { todoBridgeLine, shouldSuggestDecomposition, decomposeHintLine } from '../plugins/lifecycle-nudges.mjs'
import { FOLD_SUMMARY_INSTRUCTION, DETAILED_CHECKPOINT_INSTRUCTION, buildFoldInstruction } from '../plugins/fold-instruction.mjs'

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

test('schema validates pendingArchives entries FOR REAL — foldResultSeq included', () => {
  // The error message always claimed '{ seq, name, foldResultSeq } objects';
  // a row missing foldResultSeq used to pass load and then wedge the
  // deferred drain in a permanent 'wait'. It must throw, loudly, at parse.
  const good = { pending: {}, marks: [], pendingArchives: [{ seq: 10, name: 'alpha', foldResultSeq: 25 }] }
  assert.equal(taskMarksStateSchema.parse(good), good)
  assert.throws(() => taskMarksStateSchema.parse({ pending: {}, marks: [], pendingArchives: [{ seq: 10, name: 'alpha' }] }),
    /pendingArchives/, 'missing foldResultSeq is malformed state')
  assert.throws(() => taskMarksStateSchema.parse({ pending: {}, marks: [], pendingArchives: [{ seq: 10, name: 'alpha', foldResultSeq: 0 }] }),
    /pendingArchives/, 'foldResultSeq must be positive, like every other seq')
  assert.throws(() => taskMarksStateSchema.parse({ pending: {}, marks: [], pendingArchives: [{ seq: 10, name: 'alpha', foldResultSeq: '25' }] }),
    /pendingArchives/, 'string seqs are malformed')
  // v8-and-earlier rows without the field at all still replay fine.
  const legacy = { pending: {}, marks: [] }
  assert.equal(taskMarksStateSchema.parse(legacy), legacy)
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

test('archive closure keys on the close result, not only the begin anchor', () => {
  // The REAL shape of a committed deferred fold: the shadowed region starts
  // AFTER the 'Task begun' result (so the begin anchor survives on the
  // surface) and ends AT the close result. Keying only on the anchor left the
  // entry in pendingArchives forever — the dock rendered it as a permanent
  // 'folding…' row (replayed from a live log: 6 stuck rows).
  let state = null
  state = applyTaskMarks(state, assistantCall(100, [{ id: 'c1', name: 'task_begin' }]))
  state = applyTaskMarks(state, toolResult('c1', BEGIN_OK('alpha'), 101))
  state = applyTaskMarks(state, assistantCall(200, [{ id: 'c2', name: 'task_fold' }]))
  state = applyTaskMarks(state, toolResult('c2', END_OK('alpha'), 201))
  assert.deepEqual(state.pendingArchives, [{ seq: 100, name: 'alpha', foldResultSeq: 201 }],
    'a close queues its archive')
  // fold region = [102, 201]: anchor 100 NOT shadowed, close result 201 gone.
  state = applyTaskMarks(state, { seq: 300, type: 'compaction/summary', data: { shadowedSeqs: [102, 150, 201], shadowedTokenCount: 9 } })
  assert.equal(state, null, 'shadowing only the close result settles the archive')
})

test('archive stays queued while neither witness is shadowed', () => {
  let state = null
  state = applyTaskMarks(state, assistantCall(100, [{ id: 'c1', name: 'task_begin' }]))
  state = applyTaskMarks(state, toolResult('c1', BEGIN_OK('alpha'), 101))
  state = applyTaskMarks(state, assistantCall(200, [{ id: 'c2', name: 'task_fold' }]))
  state = applyTaskMarks(state, toolResult('c2', END_OK('alpha'), 201))
  // an unrelated summary (some other task's fold) touches neither seq
  state = applyTaskMarks(state, { seq: 400, type: 'compaction/summary', data: { shadowedSeqs: [7, 8, 9], shadowedTokenCount: 9 } })
  assert.deepEqual(state.pendingArchives, [{ seq: 100, name: 'alpha', foldResultSeq: 201 }],
    'unrelated shadowing keeps the archive queued')
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
    'Todo bridge: todo_write was called; open tasks: "fix-bridge", "add-tests" — mirror the plan in marks: as you start a todo item with a verifiable outcome, task_begin a nested mark for it; task_end it when that item is done.')
  assert.equal(todoBridgeLine([]), 'Todo bridge: todo_write was called; open tasks: none — mirror the plan in marks: as you start a todo item with a verifiable outcome, task_begin a nested mark for it; task_end it when that item is done.')
  // Quotes in task names are neutralized so the roster stays parseable.
  assert.ok(!todoBridgeLine(['say "hi"']).includes('"say "hi""'))
  assert.ok(todoBridgeLine(['say "hi"']).includes("'"))
  // Defensive: non-array / junk input degrades to the empty roster.
  assert.equal(todoBridgeLine(undefined), todoBridgeLine([]))
  assert.equal(todoBridgeLine([null, 42, '', 'ok']).includes('"ok"'), true)
})

test('shouldSuggestDecomposition: fires only in the 8–19 round window with active work', () => {
  // Before the window: a fresh task has nothing to decompose yet.
  assert.equal(shouldSuggestDecomposition(1, 7, 10), false)
  // In the window, work happening.
  assert.equal(shouldSuggestDecomposition(1, 8, 3), true)
  assert.equal(shouldSuggestDecomposition(2, 19, 9), true)
  // At 20 the close-nag (Nudge 2) takes over — never render both.
  assert.equal(shouldSuggestDecomposition(1, 20, 10), false)
  // No work (waiting on a job/reply): no decomposition pressure.
  assert.equal(shouldSuggestDecomposition(1, 12, 2), false)
  // No open task: Nudge 1's territory.
  assert.equal(shouldSuggestDecomposition(0, 12, 10), false)
})

test('decomposeHintLine: byte-stable wording, quotes neutralized', () => {
  const a = decomposeHintLine('review week 47')
  const b = decomposeHintLine('review week 47')
  assert.equal(a, b, 'byte-stable for a given name')
  assert.ok(a.startsWith('Task lifecycle: task "review week 47" has been open 8+ rounds with active work'))
  assert.ok(a.includes('innermost closes first'))
  assert.ok(!decomposeHintLine('say "hi"').includes('"say "hi""'), 'embedded quotes neutralized')
})

/** assistant/message helper for the deferred-archive gate tests. */
function assistantMsg(seq, blocks) {
  return { seq, type: 'assistant/message', data: { message: { content: blocks } } }
}

/** tool/result event helper carrying one text tool-result. */
function toolResultEvent(seq, text) {
  return { seq, type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'r' + seq, content: [{ type: 'text', text }] }] } } }
}

test('deferredArchivePlan: the message gate (wait / fold / drop)', () => {
  const p = { seq: 10, name: 'alpha', foldResultSeq: 25 }
  const begun = toolResultEvent(11, 'Task begun: alpha — 1 open.')
  const nodes = [10, 11, 15, 20, 25, 30, 35]
  // ① No assistant MESSAGE after the close (tool results and user messages
  // only) → never fold.
  const noMessage = [begun, toolResultEvent(30, '3 matches'), { seq: 32, type: 'user/message', data: { message: { content: [{ type: 'text', text: 'hm' }] } } }]
  assert.equal(deferredArchivePlan(p, nodes, noMessage).action, 'wait', 'non-assistant events after the close do not open the gate')
  // ② ANY assistant message after the close opens the gate — a
  // reasoning/tool-call-only step included (0.32.0: the old text-only
  // requirement held folds open through a straight task_begin handoff).
  // The span opens at the first surface node AFTER the "Task begun" result
  // (a region starting AT the result would split the begin call/result
  // pair — the engine rejects unbalanced leading cuts) and closes at the
  // close result's own seq; the begin CALL (seq 10) and the begun result
  // (11) both stay on the surface, and so does everything after the end.
  const toolCallStep = [begun, assistantMsg(30, [{ type: 'reasoning', text: 'thinking…' }, { type: 'tool-call', id: 'c', name: 'read', arguments: '{}' }])]
  const plan = deferredArchivePlan(p, nodes, toolCallStep)
  assert.equal(plan.action, 'fold', 'a tool-call-only message opens the gate')
  assert.equal(plan.startSeq, 15, 'span opens just after the "Task begun" result — never at it (unbalanced cut)')
  assert.equal(plan.endSeq, 25, 'span closes at the close result — never the gate message')
  const delivered = [...toolCallStep, assistantMsg(35, [{ type: 'text', text: 'final report' }])]
  // ③ Whitespace-only text still opens the gate — existence counts, not
  // content.
  const blank = [begun, assistantMsg(30, [{ type: 'text', text: '   ' }])]
  assert.equal(deferredArchivePlan(p, nodes, blank).action, 'fold', 'whitespace-only message opens the gate')
  // ④ Anchor shadowed (AUTO compaction took seq 10 off the surface) → drop.
  assert.equal(deferredArchivePlan(p, [11, 15, 20, 25, 30], delivered).action, 'drop')
  // ⑤ Close result shadowed (AUTO compaction took seq 25 off the surface) →
  // the span's end is gone; drop rather than fold a truncated region.
  assert.equal(deferredArchivePlan(p, [10, 11, 15, 20, 30, 35], delivered).action, 'drop')
  // ⑥ "Task begun" result shadowed while the call is still on the surface →
  // fall back to the v0.18 region (fold from the call) rather than drop.
  const fallback = deferredArchivePlan(p, [10, 15, 20, 25, 30, 35], delivered)
  assert.equal(fallback.action, 'fold')
  assert.equal(fallback.startSeq, 10, 'shadowed begin result folds from the call itself')
  // ⑦ Legacy events without any "Task begun" result → same fallback.
  const legacy = deferredArchivePlan(p, nodes, delivered.filter((e) => e !== begun))
  assert.equal(legacy.action, 'fold')
  assert.equal(legacy.startSeq, 10, 'legacy spans fold from the call, exactly like v0.18')
  // ⑧ Nothing between the begun result and the close → the after-result
  // region would be empty; fall back to the call-anchored region.
  const tight = deferredArchivePlan(p, [10, 11, 25, 30, 35], delivered)
  assert.equal(tight.action, 'fold')
  assert.equal(tight.startSeq, 10, 'no node after the begun result folds from the call')
  // ⑨ Inconsistent persisted row (close seq not locatable after the
  // anchor): waiting would be permanent — the plan drops instead, so the
  // drain settles the entry and moves on.
  const corrupt = { seq: 10, name: 'alpha' }
  assert.equal(deferredArchivePlan(corrupt, nodes, delivered).action, 'drop', 'missing foldResultSeq drops, never waits')
  assert.equal(deferredArchivePlan({ seq: 10, name: 'alpha', foldResultSeq: 5 }, nodes, delivered).action, 'drop',
    'close seq before the begin anchor is inconsistent — drop')
})

test('deferredArchivePlan: parallel-begin guard — the start skips the partner results of the begin message', () => {
  // The begin-carrying assistant message (seq 10) calls task_begin AND a
  // partner tool in parallel. Live regression on dsh 0.1.2-rc.1: the old
  // plan opened the span at the first surface node after the "Task begun"
  // result — the partner's tool/result — whose cut splits the partner's
  // call/result pair. The engine rejects unbalanced START boundaries and
  // the drain cannot self-heal them, so every retry failed ('fold failed').
  const p = { seq: 10, name: 'alpha', foldResultSeq: 25 }
  const beginMsg = assistantMsg(10, [
    { type: 'tool-call', id: 'b1', name: 'task_begin', arguments: '{"name":"alpha"}' },
    { type: 'tool-call', id: 'p1', name: 'grep', arguments: '{}' }
  ])
  const begun = { seq: 11, type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'b1', content: [{ type: 'text', text: 'Task begun: alpha — 1 open.' }] }] } } }
  const partner = { seq: 12, type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'p1', content: [{ type: 'text', text: '3 matches' }] }] } } }
  const deliverable = assistantMsg(30, [{ type: 'text', text: 'final report' }])
  // ① Partner result AFTER the begun result: the span must open past BOTH
  // results (node 15), never at the partner result (node 12).
  const nodes = [10, 11, 12, 15, 20, 25, 30, 35]
  const plan = deferredArchivePlan(p, nodes, [beginMsg, begun, partner, deliverable])
  assert.equal(plan.action, 'fold')
  assert.equal(plan.startSeq, 15, 'parallel partner results are skipped — a cut at 12 would split the grep pair')
  assert.equal(plan.endSeq, 25)
  // ② Partner result BEFORE the begun result: the begun result is already
  // the last of the batch; identical outcome.
  const swapped = deferredArchivePlan(p, nodes, [beginMsg, { ...partner, seq: 11 }, { ...begun, seq: 12 }, deliverable])
  assert.equal(swapped.startSeq, 15, 'order inside the parallel batch does not matter — the floor is the max result seq')
  // ③ A partner that never produced a result (interrupted step) must not
  // wedge the plan: the floor falls back to the begun result alone, and the
  // next node opens the span exactly like the single-call case.
  const interrupted = deferredArchivePlan(p, nodes, [beginMsg, begun, deliverable])
  assert.equal(interrupted.startSeq, 12, 'missing partner result degrades to the first node after the begun result')
  // ④ A single-call begin keeps the exact pre-guard choice.
  const single = deferredArchivePlan(p, [10, 11, 15, 20, 25, 30, 35], [
    assistantMsg(10, [{ type: 'tool-call', id: 'b1', name: 'task_begin', arguments: '{}' }]), begun, deliverable
  ])
  assert.equal(single.startSeq, 15, 'single-call begin is byte-identical to the old behavior')
  // ⑤ The guard only skips results of the BEGIN message's own calls — a
  // later step's unrelated result (different call id, same shape) still
  // opens the span when it is the first node after the floor.
  const laterStep = { seq: 12, type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'other-message-call', content: [{ type: 'text', text: 'x' }] }] } } }
  const foreign = deferredArchivePlan(p, nodes, [
    assistantMsg(10, [{ type: 'tool-call', id: 'b1', name: 'task_begin', arguments: '{}' }]), begun, laterStep, deliverable
  ])
  assert.equal(foreign.startSeq, 12, 'unrelated later results are span content, not floor candidates')
})

test('deferredArchivePlan: parallel-end guard — the end extends past the partner results of the close message', () => {
  // The close-carrying assistant message (seq 22) calls task_end AND other
  // tools in parallel — the live wxgame shape was task_end(A) + the
  // successor's task_begin(B) in ONE message. The close result (25) is
  // then followed by the partners' results on the surface, so a cut AT 25
  // splits those call/result pairs: an unbalanced END boundary. The drain's
  // shrink walk "fixed" it by committing below the close result — the fold
  // never shadowed foldResultSeq, the row never settled, and every
  // boundary re-summarized the previous summary node (live: one task
  // folded 5 times). The end now extends past the LAST partner result.
  const p = { seq: 10, name: 'alpha', foldResultSeq: 25 }
  const beginMsg = assistantMsg(10, [{ type: 'tool-call', id: 'b1', name: 'task_begin', arguments: '{}' }])
  const begun = { seq: 11, type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'b1', content: [{ type: 'text', text: 'Task begun: alpha — 1 open.' }] }] } } }
  const work = { seq: 15, type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'w1', content: [{ type: 'text', text: 'work output' }] }] } } }
  const closeMsg = assistantMsg(22, [
    { type: 'tool-call', id: 'e1', name: 'task_end', arguments: '{}' },
    { type: 'tool-call', id: 'n1', name: 'task_begin', arguments: '{}' },
    { type: 'tool-call', id: 'p1', name: 'present', arguments: '{}' }
  ])
  const ended = { seq: 25, type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'e1', content: [{ type: 'text', text: 'Task ended: alpha — 1 open. Archival queued.' }] }] } } }
  const nextBegun = { seq: 26, type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'n1', content: [{ type: 'text', text: 'Task begun: beta — 1 open.' }] }] } } }
  const presented = { seq: 27, type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'p1', content: [{ type: 'text', text: 'files presented' }] }] } } }
  const deliverable = assistantMsg(30, [{ type: 'text', text: 'alpha report' }])
  const events = [beginMsg, begun, work, closeMsg, ended, nextBegun, presented, deliverable]
  // ① The end extends past the LAST partner result still on the surface
  // (27, not 26): the cut leaves the close message's calls AND results all
  // inside the span, the committed fold shadows the close result at 25,
  // and the row settles on the first fold.
  const nodes = [10, 11, 15, 22, 25, 26, 27, 30]
  const plan = deferredArchivePlan(p, nodes, events)
  assert.equal(plan.action, 'fold')
  assert.equal(plan.startSeq, 15)
  assert.equal(plan.endSeq, 27, 'the end extends past the LAST partner result — a cut at 25 would split the begun/presented pairs')
  // ② Partner results shadowed (AUTO compaction took 26 and 27 off the
  // surface): no extension candidate remains; the end stays at the close
  // result — byte-identical to the pre-guard plan.
  assert.equal(deferredArchivePlan(p, [10, 11, 15, 22, 25, 30], events).endSeq, 25,
    'shadowed partner results leave the end at the close result')
  // ③ A single-call close keeps the exact pre-guard choice.
  const singleEvents = [
    beginMsg, begun, work,
    assistantMsg(22, [{ type: 'tool-call', id: 'e1', name: 'task_end', arguments: '{}' }]),
    ended, deliverable
  ]
  const single = deferredArchivePlan(p, [10, 11, 15, 22, 25, 30], singleEvents)
  assert.equal(single.endSeq, 25, 'single-call close is byte-identical to the old behavior')
  // ④ The guard only extends over the CLOSE message's own calls: a LATER
  // step's unrelated call/result after the close still ends the span at
  // the close result (that pair is outside the region, so the cut at 25 is
  // balanced for it).
  const laterStepEvents = [
    beginMsg, begun, work,
    assistantMsg(22, [{ type: 'tool-call', id: 'e1', name: 'task_end', arguments: '{}' }]),
    ended,
    assistantMsg(26, [{ type: 'tool-call', id: 'u1', name: 'read', arguments: '{}' }]),
    { seq: 27, type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'u1', content: [{ type: 'text', text: 'content' }] }] } } },
    deliverable
  ]
  const foreign = deferredArchivePlan(p, [10, 11, 15, 22, 25, 26, 27, 30], laterStepEvents)
  assert.equal(foreign.endSeq, 25, 'unrelated later results are not extension candidates')
  // ⑤ Legacy/odd shape — no close event at foldResultSeq at all: the guard
  // degrades to no extension (the old plan), never to a bogus region.
  const legacy = deferredArchivePlan(p, nodes, events.filter((e) => e !== ended))
  assert.equal(legacy.endSeq, 25, 'missing close event skips the extension entirely')
})

test('deferredArchivePlan: the region start follows SURFACE POSITION, not seq magnitude', () => {
  // Live regression (fold #3 of a real session on dsh 0.1.2-rc.1). After an
  // earlier fold commits, its summary node sits AT the position of the region
  // it shadowed while carrying a seq from the log's END — so the surface is
  // NOT seq-ordered. The old plan scanned for the SMALLEST seq in
  // (begunResult, closeResult) and picked that summary node (seq 183), which
  // sits BEFORE the task's own begin call: the fold then swallowed the
  // 'Task begun' bookmark, the nested subtask's begin pair and two
  // already-committed summary nodes (the engine's region is a contiguous
  // slice from the chosen position). The region must open at the POSITIONAL
  // successor of the begun result (187) instead.
  const p = { seq: 177, name: 'gamma', foldResultSeq: 216 }
  const beginMsg = assistantMsg(177, [{ type: 'tool-call', id: 'b', name: 'task_begin', arguments: '{}' }])
  const begun = { seq: 179, type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'b', content: [{ type: 'text', text: 'Task begun: gamma — 1 open.' }] }] } } }
  const deliverable = assistantMsg(221, [{ type: 'text', text: 'report' }])
  const events = [beginMsg, begun, deliverable]
  // Positions: 0    1    2    3    4    5    6    7    8    9
  // nodes:    183  177  179  187  199  201  216  214  220  221
  // 183 = fold #1's committed summary node and 220 = fold #2's: both sit at
  // the position of the region they shadowed while carrying seqs from the
  // log's end, which is exactly what makes the numeric scan pick them.
  const nodes = [183, 177, 179, 187, 199, 201, 216, 214, 220, 221]
  const plan = deferredArchivePlan(p, nodes, events)
  assert.equal(plan.action, 'fold')
  assert.equal(plan.startSeq, 187, 'the span opens at the positional successor of the begun result')
  assert.equal(plan.endSeq, 216, 'the span still closes at the close result')
  // The three nodes the old scan swallowed now stay on the surface.
  for (const stay of [183, 177, 179]) {
    assert.ok(nodes.indexOf(stay) < nodes.indexOf(plan.startSeq), 'node ' + stay + ' stays before the span')
  }
  // Same shape with the begun result's successor being the close result:
  // there is no room for an after-result region, so the plan falls back to
  // the begin call — never to endPos (which cannot open a region).
  const tightNodes = [183, 177, 179, 216, 221]
  const tight = deferredArchivePlan(p, tightNodes, events)
  assert.equal(tight.action, 'fold')
  assert.equal(tight.startSeq, 177, 'no positional room after the begun result folds from the call')
  // A surface whose order contradicts the log (close before begin) drops
  // rather than folding a bogus region.
  assert.equal(deferredArchivePlan(p, [216, 177, 179, 221], events).action, 'drop')
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
  assert.ok(FOLD_SUMMARY_INSTRUCTION.includes('\'Task begun\' result'), 'span bracket declared: opens just after the Task begun result, closes at the Task ended result')
  assert.ok(FOLD_SUMMARY_INSTRUCTION.includes('especially corrections'), 'user feedback rule present')
  assert.ok(FOLD_SUMMARY_INSTRUCTION.includes('why something failed'), 'pitfall-cause rule present')
  assert.ok(FOLD_SUMMARY_INSTRUCTION.includes('relay'), 'fallback-relay rule present (summary may back a never-sent deliverable)')
  assert.ok(FOLD_SUMMARY_INSTRUCTION.includes('cite its conclusions, not restate'), 'delivered-report citation rule present (Outcomes cites, never restates)')
  assert.ok(FOLD_SUMMARY_INSTRUCTION.includes('paths verbatim'), 'anchor-precision rule present (anchors double as recall grep keywords)')
  assert.ok(!FOLD_SUMMARY_INSTRUCTION.includes('word budget'), 'no word budget anywhere — coverage is governed by structure, not a budget')
  assert.ok(FOLD_SUMMARY_INSTRUCTION.includes('Changes is exhaustive — every file path written or edited'), 'changes are exhaustive, never culled to a bullet count')
  assert.ok(FOLD_SUMMARY_INSTRUCTION.includes('keeps every request, correction, and approval'), 'user inputs are kept in full')
  assert.ok(FOLD_SUMMARY_INSTRUCTION.includes('stay grep-able later'), 'changes are durable grep-able artifacts; commands belong to What happened')
  // Continuity-checkpoint sections contradict the fold's CLOSED-task contract
  // (they belong to the stock full-context instruction, not to folds).
  for (const banned of ['Pending Jobs', 'Current Work', 'Next Step', 'Primary Request']) {
    assert.ok(!FOLD_SUMMARY_INSTRUCTION.includes(banned), 'banned checkpoint section present: ' + banned)
  }
})

test('buildFoldInstruction: prefix envelope scopes the begin→end region explicitly', () => {
  // The span-only variant IS the exported instruction (byte-identical).
  assert.equal(buildFoldInstruction({}), FOLD_SUMMARY_INSTRUCTION)
  assert.equal(buildFoldInstruction({ prefix: false, name: 'X' }), FOLD_SUMMARY_INSTRUCTION)
  // The prefix variant declares the region by its explicit lifecycle markers.
  const scoped = buildFoldInstruction({ prefix: true, name: '发布 v0' })
  assert.ok(scoped.includes('EARLIER CONVERSATION'), 'two-part input declared')
  assert.ok(scoped.includes('begins immediately after the result message \'Task begun: 发布 v0\''), 'begin marker named')
  assert.ok(scoped.includes('ends with the result message \'Task ended: 发布 v0\''), 'end marker named')
  assert.ok(scoped.includes('Summarize ONLY that final span'), 'only-the-span rule present')
  assert.ok(scoped.includes('CONTEXT ONLY'), 'earlier conversation declared context-only')
  assert.ok(scoped.includes('never summarize it, restate it, or fold any of it'), 'no-drift rule present')
  // Both variants share the boundary rule, the five sections, and the rules.
  for (const shared of ['stay outside the span by design', '## What happened', '## Outcomes', 'paths verbatim']) {
    assert.ok(scoped.includes(shared), 'shared core present: ' + shared)
    assert.ok(FOLD_SUMMARY_INSTRUCTION.includes(shared), 'shared core present in span-only: ' + shared)
  }
  // A missing name degrades to a placeholder, never to a broken sentence.
  const anon = buildFoldInstruction({ prefix: true })
  assert.ok(anon.includes('Task begun: <the task name>'), 'anonymous placeholder present')
})

test('DETAILED_CHECKPOINT_INSTRUCTION: uncapped, exhaustive, structure-preserving stock replacement', () => {
  // The stock checkpoint's eight sections survive (host consumers and the
  // continuing model keep a familiar shape)...
  for (const heading of ['## Primary Request and Intent', '## Key Technical Concepts', '## Files and Code', '## Errors and Fixes', '## Pending Jobs', '## Current Work', '## Next Step', '## Critical Context']) {
    assert.ok(DETAILED_CHECKPOINT_INSTRUCTION.includes(heading), 'missing heading: ' + heading)
  }
  // ...but every cap is gone and detail is mandated.
  assert.ok(DETAILED_CHECKPOINT_INSTRUCTION.includes('NO length cap and NO bullet-count cap'), 'no caps rule present')
  assert.ok(DETAILED_CHECKPOINT_INSTRUCTION.includes('compress phrasing, never facts'), 'facts are never the thing compressed')
  assert.ok(DETAILED_CHECKPOINT_INSTRUCTION.includes('exhaustive, no selection'), 'Files and Code is exhaustive')
  assert.ok(DETAILED_CHECKPOINT_INSTRUCTION.includes('keep every failure cause'), 'every failure cause survives')
  assert.ok(DETAILED_CHECKPOINT_INSTRUCTION.includes('prior checkpoint block'), 'prior-checkpoint merge rule present')
  assert.ok(!DETAILED_CHECKPOINT_INSTRUCTION.includes('terse'), 'the stock terse-bullets directive is gone')
  assert.notEqual(DETAILED_CHECKPOINT_INSTRUCTION, FOLD_SUMMARY_INSTRUCTION, 'fold and checkpoint instructions stay distinct artifacts')
})

// ── sibling guard: task-mark calls must be alone in their message ──────
// The execute-time guard behind the PARALLEL-END relay rejection: a
// task_begin batched into a task_end's message puts its anchor inside the
// predecessor's fold span and costs it an archive (see siblingTaskMarkCalls).

/** Fake session exposing events the way the two access paths expect. */
function guardSession(events, { legacy = false } = {}) {
  const rows = events.filter((e) => Number.isInteger(e.seq))
  if (legacy) return { surface: { nodes: rows.map((e) => e.seq) }, events }
  const bySeq = new Map(rows.map((e) => [e.seq, e]))
  return { surface: { nodes: rows.map((e) => e.seq) }, eventAt: (seq) => (bySeq.has(seq) ? bySeq.get(seq) : null) }
}

test('sibling guard: relay message flags BOTH directions, alone passes', () => {
  const relay = guardSession([assistantCall(22, [{ id: 'e1', name: 'task_end' }, { id: 'n1', name: 'task_begin' }])])
  assert.deepEqual(siblingTaskMarkCalls(relay, 'task_begin'), ['task_end'], 'the begin sees its end sibling')
  assert.deepEqual(siblingTaskMarkCalls(relay, 'task_end'), ['task_begin'], 'the end sees its begin sibling')
  const alone = guardSession([assistantCall(10, [{ id: 'b1', name: 'task_begin' }])])
  assert.deepEqual(siblingTaskMarkCalls(alone, 'task_begin'), [], 'a lone begin is the required shape')
  // Contract: `self` is always the executing tool, so its call IS in the
  // carrier — a begin-only message can only ever be queried as 'task_begin'.
})

test('sibling guard: non-trio partners and task_fold siblings', () => {
  // present riding the close is NOT rejected — deferredArchivePlan's
  // PARALLEL-END extension already covers non-mark partners correctly.
  const withPresent = guardSession([assistantCall(22, [{ id: 'e1', name: 'task_end' }, { id: 'p1', name: 'present' }])])
  assert.deepEqual(siblingTaskMarkCalls(withPresent, 'task_end'), [], 'present is not a task-mark call')
  // task_fold is in the reducer's parser trio, so it counts as a sibling.
  const withFold = guardSession([assistantCall(22, [{ id: 'e1', name: 'task_end' }, { id: 'f1', name: 'task_fold' }])])
  assert.deepEqual(siblingTaskMarkCalls(withFold, 'task_end'), ['task_fold'], 'legacy task_fold is a sibling')
  // Two begins in one message: the second sees the first (self-skip is one).
  const double = guardSession([assistantCall(22, [{ id: 'b1', name: 'task_begin' }, { id: 'b2', name: 'task_begin' }])])
  assert.deepEqual(siblingTaskMarkCalls(double, 'task_begin'), ['task_begin'], 'a second begin in the same message is flagged')
})

test('sibling guard: unreadable carriers degrade to null, never block', () => {
  assert.equal(siblingTaskMarkCalls({ surface: { nodes: [] }, eventAt: () => null }, 'task_begin'), null, 'no assistant message: no verdict')
  const textOnly = guardSession([{ seq: 5, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'report' }] } } }])
  assert.equal(lastAssistantToolNames(textOnly), null, 'text-only message carries no calls')
  assert.equal(siblingTaskMarkCalls(textOnly, 'task_begin'), null, 'text-only carrier: no verdict')
})

test('sibling guard: reads the LAST assistant message via both access paths', () => {
  const events = [
    assistantCall(10, [{ id: 'b1', name: 'task_begin' }]),
    assistantCall(22, [{ id: 'e1', name: 'task_end' }, { id: 'n1', name: 'task_begin' }])
  ]
  for (const legacy of [false, true]) {
    const s = guardSession(events, { legacy })
    assert.deepEqual(siblingTaskMarkCalls(s, 'task_begin'), ['task_end'], (legacy ? 'events-snapshot' : 'eventAt') + ' path: the last message is the carrier')
    assert.deepEqual(lastAssistantToolNames(s), ['task_end', 'task_begin'], (legacy ? 'events-snapshot' : 'eventAt') + ' path: full call order')
  }
})

