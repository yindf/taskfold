// Offline tests for the deferred-archive drain (createArchiveDrain) under
// the 0.32.0 message gate: the fold fires once ONE assistant message
// follows the close result — any content counts (the old text-only
// requirement held folds open through a straight task_begin handoff, found
// live on the MasterGoUI session as the 插件侧源码审查 → up 仓库 handoff).
// The successor-anchor defer is gone entirely (the region is begin..close;
// anchors are begin-message seqs, so the defer branch was unreachable),
// and a 'wait' verdict skips the entry instead of aborting the pass.
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
 * shadowed). append() lets a test advance the log between drain passes
 * the way later turns would.
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

// The 0.32.0 headline shape: elder closes with its report text riding the
// SAME message as the task_end call (before the result — too early), and
// the first assistant message after the close is the successor's bare
// task_begin call, no text at all. Under the old text gate + successor
// defer this elder waited two extra steps and folded only AFTER the
// successor; now both fold in one pass.
test('tool-call-only handoff opens the gate: elder folds without waiting for text', async () => {
  const h = harness([
    assistantCall(10, [{ id: 'a1', name: 'task_begin' }]),
    toolResult(11, 'a1', BEGUN('elder', '1 open.')),
    assistantCall(20, [{ id: 'a2', name: 'task_end' }]),
    toolResult(21, 'a2', ENDED('elder', 'all closed. Archival queued.')),
    // The handoff: first assistant message after the close is a bare
    // task_begin — no text anywhere.
    assistantCall(30, [{ id: 'b1', name: 'task_begin' }]),
    toolResult(31, 'b1', BEGUN('younger', '1 open.')),
    // The elder's actual report text, stranded inside the successor's span.
    assistantText(35, 'elder report stranded between the successor begin and its close'),
    assistantCall(40, [{ id: 'b2', name: 'task_end' }]),
    toolResult(41, 'b2', ENDED('younger', 'all closed. Archival queued.')),
    assistantText(45, 'younger deliverable')
  ])
  await h.drain.processDeferredArchives(h.agent, undefined)

  // Younger (innermost-last) folded first and swept the stranded elder
  // report; elder folded right after in the SAME pass — no defer, no wait.
  assert.deepEqual(h.folds, [[35, 41], [20, 21]])
  // Both rows persist (their begin-message anchors 10/30 are never
  // shadowed by design) but both settle in memory via the drop path.
  assert.deepEqual(h.state().pendingArchives.map((p) => p.name), ['elder', 'younger'])
  assert.ok(h.drain.isSettledArchive(h.session, 10) && h.drain.isSettledArchive(h.session, 30), 'both rows settled in memory')

  // Restart: a fresh drain instance (settled memory lost) must NOT re-fold
  // — the shadowed close results route the replayed rows through 'drop'.
  const drain2 = createArchiveDrain({ ctx: h.ctx, engineFor: async () => h.engine, closingTasks: new Map() })
  await drain2.processDeferredArchives(h.agent, undefined)
  assert.equal(h.folds.length, 2, 'restart settles via drop, no duplicate fold')
})

// A newest entry whose post-close assistant message has not landed yet
// ('wait') must not abort the pass: the older, already-foldable entry
// still folds.
test('wait skips the entry instead of starving older foldable ones', async () => {
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
    // no assistant message after 41: the newest entry 'wait's
  ])
  await h.drain.processDeferredArchives(h.agent, undefined)

  assert.deepEqual(h.folds, [[20, 21]], 'the older ready entry folded despite the newer wait')
  assert.deepEqual(h.state().pendingArchives.map((p) => p.name), ['ready', 'pending deliverable'], 'the waiting entry stays queued, unsettled')
  assert.ok(!h.drain.isSettledArchive(h.session, 30), 'waiting entry not settled — retried next boundary')
})

// A 'wait' is a retry, not a verdict: the skip set dies with the pass, so
// the entry folds on the very next boundary once ANY assistant message
// lands — here, again, a bare task_begin handoff.
test('a waiting entry folds on the next pass once a message lands', async () => {
  const h = harness([
    assistantCall(10, [{ id: 'a1', name: 'task_begin' }]),
    toolResult(11, 'a1', BEGUN('elder', '1 open.')),
    assistantCall(20, [{ id: 'a2', name: 'task_end' }]),
    toolResult(21, 'a2', ENDED('elder', 'all closed. Archival queued.'))
    // nothing after the close yet
  ])
  await h.drain.processDeferredArchives(h.agent, undefined)
  assert.deepEqual(h.folds, [], 'no assistant message after the close: wait')
  assert.ok(!h.drain.isSettledArchive(h.session, 10), 'waiting entry not settled')

  h.append(assistantCall(30, [{ id: 'b1', name: 'task_begin' }]))
  h.append(toolResult(31, 'b1', BEGUN('younger', '1 open.')))
  await h.drain.processDeferredArchives(h.agent, undefined)
  assert.deepEqual(h.folds, [[20, 21]], 'the bare task_begin handoff opens the gate on the next pass')
})
