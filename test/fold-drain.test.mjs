// Offline tests for the deferred-archive drain (createArchiveDrain): the
// ghost-anchor fix and the wait/defer anti-starvation skip. Found live on a
// real session: five task_end calls never folded because a committed fold's
// own queue row (whose begin anchor survives its own commit by design) was
// still counted as a pending SUCCESSOR anchor, deferring every older entry
// forever; and one 'wait'/'defer' verdict aborted the whole drain pass,
// starving older foldable entries behind it.
// Run in-process (the sandbox blocks node --test child processes):
//   node test/fold-drain.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { createArchiveDrain } from '../plugins/fold-drain.mjs'
import { applyTaskMarks } from '../plugins/task-marks.mjs'

/** assistant/message carrying tool-call blocks (shape per dsh-agent-loop). */
function assistantCall(seq, calls) {
  return {
    seq,
    type: 'assistant/message',
    data: { message: { content: calls.map((c) => ({ type: 'tool-call', id: c.id, name: c.name })) } }
  }
}

/** tool/result in the REAL persisted shape: linkage in tool-result blocks. */
function toolResult(seq, callId, text) {
  return {
    seq,
    type: 'tool/result',
    data: {
      message: {
        content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], isError: false }]
      }
    }
  }
}

/** assistant/message carrying a plain text block (a deliverable). */
function assistantText(seq, text) {
  return { seq, type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } }
}

const BEGUN = (n, rest) => 'Task begun: ' + n + ' — ' + rest
const ENDED = (n, rest) => 'Task ended: ' + n + ' — ' + rest

/**
 * A miniature harness around one session: projection state the drain reads
 * through ctx, a surface the engine commit rewrites, and an engine whose
 * compactRegion SHADOWS the region and feeds the synthetic compaction/
 * summary through the reducer — exactly what the host does on a real
 * commit (the reducer then drops queue rows whose begin anchor was
 * shadowed). replaceState() lets a test advance the log between drain
 * passes the way later turns would.
 */
function harness(events) {
  let state = null
  for (const e of events) state = applyTaskMarks(state, e)
  const session = {
    id: 's-' + Math.random().toString(36).slice(2, 8),
    events,
    surface: { nodes: events.filter((e) => e.type === 'assistant/message' || e.type === 'user/message' || e.type === 'tool/result').map((e) => e.seq) }
  }
  const ctx = { sessionProjections: { stateOf: () => state } }
  const folds = []
  const engine = {
    async compactRegion(startSeq, endSeq) {
      folds.push([startSeq, endSeq])
      const shadowed = session.surface.nodes.filter((n) => n >= startSeq && n <= endSeq)
      session.surface.nodes = session.surface.nodes.filter((n) => n < startSeq || n > endSeq)
      state = applyTaskMarks(state, { type: 'compaction/summary', data: { shadowedSeqs: shadowed } })
      return { shadowedTokenCount: 1000 }
    }
  }
  const agent = { session }
  const drain = createArchiveDrain({ ctx, engineFor: async () => engine, closingTasks: new Map() })
  return {
    session, agent, ctx, engine, folds, drain,
    state: () => state,
    append(e) {
      session.events.push(e)
      state = applyTaskMarks(state, e)
      if (e.type === 'assistant/message' || e.type === 'user/message' || e.type === 'tool/result') session.surface.nodes.push(e.seq)
    }
  }
}

// The MasterGoUI shape: outer A open across everything; B closes BEFORE a
// later sibling C even begins; one shared deliverable text lands after C's
// own close. C is innermost-last and folds; its queue row (begin anchor 50,
// deliberately never shadowed by its own fold) must then NOT count as B's
// pending successor — otherwise B (deliverable after 50) defers forever and
// A starves behind B. This test fails on the pre-fix drain.
test('settled ghost row is not a successor anchor: older siblings still fold', async () => {
  const h = harness([
    assistantCall(10, [{ id: 'a1', name: 'task_begin' }]),
    toolResult(11, 'a1', BEGUN('outer', '1 open.')),
    assistantCall(20, [{ id: 'b1', name: 'task_begin' }]),
    toolResult(21, 'b1', BEGUN('older sibling', '2 open.')),
    assistantCall(40, [{ id: 'b2', name: 'task_end' }]),
    toolResult(41, 'b2', ENDED('older sibling', '1 open: outer. Archival queued.')),
    assistantCall(50, [{ id: 'c1', name: 'task_begin' }]),
    toolResult(51, 'c1', BEGUN('younger sibling', '2 open.')),
    assistantCall(60, [{ id: 'c2', name: 'task_end' }]),
    toolResult(61, 'c2', ENDED('younger sibling', '1 open: outer. Archival queued.')),
    assistantText(65, 'deliverable for both siblings'),
    assistantCall(70, [{ id: 'a2', name: 'task_end' }]),
    toolResult(71, 'a2', ENDED('outer', 'all closed. Archival queued.')),
    assistantText(75, 'deliverable for outer')
  ])
  await h.drain.processDeferredArchives(h.agent, undefined)

  // C folded first (innermost-last), then B unblocked, then the outer fold
  // swept the sibling anchors — the reducer dropped both queued rows.
  assert.deepEqual(h.folds, [[60, 61], [40, 41], [20, 71]])
  assert.equal(h.state().pendingArchives.length, 1, 'only the outermost row persists (its anchor is never shadowed)')
  assert.equal(h.state().pendingArchives[0].name, 'outer')
  assert.ok(h.drain.isSettledArchive(h.session, 10), 'outer row settled in memory')

  // Restart: a fresh drain instance (settled memory lost) must NOT re-fold
  // — the shadowed close result routes the row through 'drop' again.
  const drain2 = createArchiveDrain({ ctx: h.ctx, engineFor: async () => h.engine, closingTasks: new Map() })
  await drain2.processDeferredArchives(h.agent, undefined)
  assert.equal(h.folds.length, 3, 'restart settles via drop, no duplicate fold')
})

// A newest entry whose deliverable has not landed yet ('wait') must not
// abort the pass: the older, already-foldable entry still folds. This test
// fails on the pre-fix drain (single 'wait' → return).
test('wait/defer skips the entry instead of starving older foldable ones', async () => {
  const h = harness([
    assistantCall(10, [{ id: 'a1', name: 'task_begin' }]),
    toolResult(11, 'a1', BEGUN('ready', '1 open.')),
    assistantCall(20, [{ id: 'a2', name: 'task_end' }]),
    toolResult(21, 'a2', ENDED('ready', 'all closed. Archival queued.')),
    assistantText(25, 'deliverable for ready'),
    assistantCall(30, [{ id: 'd1', name: 'task_begin' }]),
    toolResult(31, 'd1', BEGUN('pending deliverable', '1 open.')),
    assistantCall(40, [{ id: 'd2', name: 'task_end' }]),
    toolResult(41, 'd2', ENDED('pending deliverable', 'all closed. Archival queued.'))
    // no assistant text after 41: the newest entry 'wait's
  ])
  await h.drain.processDeferredArchives(h.agent, undefined)

  assert.deepEqual(h.folds, [[20, 21]], 'the older ready entry folded despite the newer wait')
  assert.deepEqual(h.state().pendingArchives.map((p) => p.name), ['ready', 'pending deliverable'], 'the waiting entry stays queued, unsettled')
  assert.ok(!h.drain.isSettledArchive(h.session, 30), 'waiting entry not settled — retried next boundary')
})

// The skip set must die with the pass: a deferred entry is retried on the
// NEXT boundary, so a successor that closes later releases it for good.
// Ordering per the gate's semantics: outer closes FIRST, the successor
// begins after the close, and outer's deliverable lands after the
// successor's begin anchor → defer.
test('skipped defer is retried on the next drain pass', async () => {
  const h = harness([
    assistantCall(10, [{ id: 'a1', name: 'task_begin' }]),
    toolResult(11, 'a1', BEGUN('outer', '1 open.')),
    assistantCall(30, [{ id: 'a2', name: 'task_end' }]),
    toolResult(31, 'a2', ENDED('outer', 'all closed. Archival queued.')),
    assistantCall(40, [{ id: 's1', name: 'task_begin' }]),
    toolResult(41, 's1', BEGUN('successor', '1 open.'))
  ])
  await h.drain.processDeferredArchives(h.agent, undefined)
  assert.deepEqual(h.folds, [], 'no deliverable yet: outer waits, nothing folds')

  h.append(assistantText(45, 'outer deliverable after the successor began'))
  await h.drain.processDeferredArchives(h.agent, undefined)
  assert.deepEqual(h.folds, [], 'deliverable after the open successor anchor still defers')
  assert.ok(!h.drain.isSettledArchive(h.session, 10), 'deferred entry not settled')

  h.append(assistantCall(50, [{ id: 's2', name: 'task_end' }]))
  h.append(toolResult(51, 's2', ENDED('successor', 'all closed. Archival queued.')))
  h.append(assistantText(55, 'successor deliverable'))
  await h.drain.processDeferredArchives(h.agent, undefined)
  // Successor's region [45..51] also swallows outer's stranded deliverable
  // (45, sitting between successor's begin result and its close) — the
  // documented leftover-sweep behavior — then the retried outer folds.
  assert.deepEqual(h.folds, [[45, 51], [30, 31]], 'successor folds, then the previously deferred outer folds in the same pass')
})
