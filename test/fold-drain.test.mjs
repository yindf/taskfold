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
 * commit (the reducer then drops the queue row whose CLOSE RESULT it
 * shadowed — every fold region ENDS at the close result). append() lets a
 * test advance the log between drain passes the way later turns would.
 */
function harness(events, opts) {
  let state = null
  for (const e of events) state = applyTaskMarks(state, e)
  const session = {
    id: 's-' + Math.random().toString(36).slice(2, 8),
    events,
    surface: { nodes: events.filter((e) => e.type === 'assistant/message' || e.type === 'user/message' || e.type === 'tool/result').map((e) => e.seq) }
  }
  const ctx = { sessionProjections: { stateOf: () => state } }
  const folds = []
  const attempts = []
  const rejectEnds = new Set(opts !== undefined && Array.isArray(opts.rejectEnds) ? opts.rejectEnds : [])
  const failWith = opts !== undefined && typeof opts.failWith === 'string' ? opts.failWith : null
  const engine = {
    async compactRegion(startSeq, endSeq) {
      attempts.push([startSeq, endSeq])
      if (failWith !== null) {
        const err = new Error(failWith)
        if (opts !== undefined && typeof opts.failCode === 'string') err.code = opts.failCode
        throw err
      }
      if (rejectEnds.has(endSeq)) {
        throw new Error('compactRegion: end seq ' + endSeq + ' is not a balanced boundary (would split a step, or the step is still open)')
      }
      folds.push([startSeq, endSeq])
      // The real engine slices the span by surface POSITION
      // (validateSurfaceRegion: nodes.slice(startIdx, endIdx + 1)) — never by
      // seq range: a committed fold re-inserts its summary node at the
      // position of the region it shadowed while the node keeps a seq from
      // the log's end, so the surface is not seq-ordered.
      const nodes = session.surface.nodes
      const startIdx = nodes.indexOf(startSeq)
      const endIdx = nodes.indexOf(endSeq)
      if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
        throw new Error('compactRegion: start seq ' + startSeq + ' is after end seq ' + endSeq + ' on the surface')
      }
      const shadowed = nodes.slice(startIdx, endIdx + 1)
      session.surface.nodes = nodes.slice(0, startIdx).concat(nodes.slice(endIdx + 1))
      state = applyTaskMarks(state, { type: 'compaction/summary', data: { shadowedSeqs: shadowed } })
      return { shadowedTokenCount: 1000 }
    }
  }
  const agent = { session }
  const drain = createArchiveDrain({ ctx, engineFor: async () => engine, closingTasks: new Map() })
  return {
    session, agent, ctx, engine, folds, attempts, drain,
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
  // Both rows are GONE from the projection: each committed fold shadowed the
  // close result it was queued for, and the reducer's archive closure drops
  // such rows immediately (they used to linger forever — the dock drew them
  // as permanent 'folding…' rows). The in-memory settled set agrees.
  assert.equal(h.state(), null, 'both archive rows closed out of the projection')
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
  assert.deepEqual(h.state().pendingArchives.map((p) => p.name), ['pending deliverable'], 'the folded entry left the projection; the waiting entry stays queued')
  assert.ok(h.drain.isSettledArchive(h.session, 10), 'the folded entry is settled in memory')
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

// The balanced-boundary END shrink walks surface POSITIONS. Review-found
// regression: the old shrink picked "the largest seq below `end`", which on a
// post-fold surface is meaningless — a nested fold's summary node sits at the
// position of the region it shadowed while carrying a seq from the log's END.
// With the corrected positional start (226, the node right after the begun
// result) the old scan found NO candidate at all (no node satisfies
// `226 <= s < 216`), so it broke out with a null result and gamma closed
// unfolded through the silent tooSmall path.
test('a rejected END boundary shrinks by one surface POSITION, never by seq order', async () => {
  const h = harness([
    assistantCall(177, [{ id: 'b1', name: 'task_begin' }]),
    toolResult(179, 'b1', BEGUN('gamma', '1 open.')),
    toolResult(226, 'w1', 'work output inside gamma'),
    assistantCall(214, [{ id: 'e1', name: 'task_end' }]),
    toolResult(216, 'e1', ENDED('gamma', 'all closed. Archival queued.')),
    assistantText(221, 'gamma deliverable')
  ], { rejectEnds: [216, 214] })
  // A nested subtask folded while gamma stayed open: its committed summary
  // node (220) replaced its own region — a position INSIDE gamma's span —
  // while carrying the newest seq in the log.
  h.session.surface.nodes.splice(3, 0, 220)

  await h.drain.processDeferredArchives(h.agent, undefined)

  assert.deepEqual(h.attempts.slice(0, 3), [[226, 216], [226, 214], [226, 220]], 'the END walks back one surface POSITION at a time')
  assert.deepEqual(h.folds, [[226, 220]], 'the first acceptable boundary commits')
  // The residual close pair cannot be cut at either node (its CALL is
  // unbalanced too), so the walk stops at the minimal region instead of
  // looping: two more attempts, no more.
  assert.equal(h.attempts.length, 5, 'the walk stops when the END reaches the START')
  assert.deepEqual(h.state().pendingArchives.map((p) => p.name), ['gamma'], 'the entry stays queued (its anchor was never shadowed)')
})

// Retry budget (review-found): ONE fold attempt is a whole summarization call
// (30–70 s), and the old drain re-attempted a failing entry at EVERY step
// boundary forever — no cap, no backoff, and the classified error's own
// message was dropped, so the HOLD line named a cause the log never recorded.
test('a failing archive backs off geometrically and names its cause', async () => {
  const h = harness([
    assistantCall(10, [{ id: 'a1', name: 'task_begin' }]),
    toolResult(11, 'a1', BEGUN('stuck', '1 open.')),
    assistantCall(20, [{ id: 'a2', name: 'task_end' }]),
    toolResult(21, 'a2', ENDED('stuck', 'all closed. Archival queued.')),
    assistantText(25, 'deliverable')
  ], { failWith: 'summary structure failure: expected the summary to open with a "## " section heading, got: 摘要' })

  // Pass 1: one attempt, then a HOLD failure that carries the cause and the
  // attempt count.
  await h.drain.processDeferredArchives(h.agent, undefined)
  assert.equal(h.attempts.length, 1)
  const fails = h.drain.autoFoldFailures.get(h.session.id)
  assert.equal(fails.get('stuck'), 'fold failed, attempt 1: summary structure failure: expected the summary to open with a "## " section heading, got: 摘要')

  // Pass 2 is the first boundary of the attempt-1 backoff (one pass): retry.
  await h.drain.processDeferredArchives(h.agent, undefined)
  assert.equal(h.attempts.length, 2)
  assert.ok(fails.get('stuck').includes('attempt 2'))

  // Pass 3 sits inside the attempt-2 window (two passes) and bills nothing.
  await h.drain.processDeferredArchives(h.agent, undefined)
  assert.equal(h.attempts.length, 2, 'a backoff boundary costs no summarization call')

  // Pass 4 is the first boundary after it: attempt 3, backing off four.
  await h.drain.processDeferredArchives(h.agent, undefined)
  assert.equal(h.attempts.length, 3)
  const state = h.drain.autoFoldAttempts.get(h.session.id).get(10)
  assert.equal(state.attempts, 3)
  assert.equal(state.nextPass, 8, 'attempt 3 backs off four boundaries')
  // Never abandoned silently: the entry stays queued and keeps its retry state.
  assert.ok(!h.drain.isSettledArchive(h.session, 10))
})

test('a cancelled fold is quiet on its first occurrence and visible if it repeats', async () => {
  const h = harness([
    assistantCall(10, [{ id: 'a1', name: 'task_begin' }]),
    toolResult(11, 'a1', BEGUN('interrupted', '1 open.')),
    assistantCall(20, [{ id: 'a2', name: 'task_end' }]),
    toolResult(21, 'a2', ENDED('interrupted', 'all closed. Archival queued.')),
    assistantText(25, 'deliverable')
  ], { failWith: 'the turn was cancelled', failCode: 'cancelled' })

  // The normal shape of an interrupted turn (Esc, superseded turn): the retry
  // is unconditional anyway, so the first one publishes no HOLD line.
  await h.drain.processDeferredArchives(h.agent, undefined)
  assert.equal(h.drain.autoFoldFailures.get(h.session.id), undefined, 'no noise from a single cancellation')
  await h.drain.processDeferredArchives(h.agent, undefined)
  assert.match(h.drain.autoFoldFailures.get(h.session.id).get('interrupted'), /^fold cancelled, attempt 2: /)
})

// AGENT-LEVEL SINGLE FLIGHT (backported from the alpha channel): the drain's
// running guard is keyed by session id. Cross-session: a fold in flight for
// session A must not defer session B's drain — B folds immediately. Live
// origin (alpha, dsh 0.1.7-alpha.2): a subagent session whose ONLY two drain
// opportunities both fell inside a sibling 37.5 s fold window lost its
// archive forever, because the queued retry needed a step boundary that a
// settled subagent never produces.
test('cross-session drain calls fold concurrently — no starvation behind a sibling pass', async () => {
  const mk = (id) => {
    const events = [
      assistantCall(10, [{ id: id + '-1', name: 'task_begin' }]),
      toolResult(11, id + '-1', BEGUN(id, '1 open.')),
      assistantCall(20, [{ id: id + '-2', name: 'task_end' }]),
      toolResult(21, id + '-2', ENDED(id, 'all closed. Archival queued.')),
      assistantText(25, id + ' deliverable')
    ]
    let state = null
    for (const e of events) state = applyTaskMarks(state, e)
    const session = { id, events, surface: { nodes: [10, 11, 20, 21, 25] } }
    return { session, agent: { session } }
  }
  const A = mk('sess-a')
  const B = mk('sess-b')
  const states = new Map([[A.session.id, null], [B.session.id, null]])
  // Re-derive per-session state the way the harness does, then key it by id.
  for (const pair of [[A, A.session.events], [B, B.session.events]]) {
    let s = null
    for (const e of pair[1]) s = applyTaskMarks(s, e)
    states.set(pair[0].session.id, s)
  }
  const ctx = { sessionProjections: { stateOf: (session) => states.get(session.id) } }
  const order = []
  let releaseA
  let enteredAResolve
  const enteredA = new Promise((r) => { enteredAResolve = r })
  const engine = {
    async compactRegion(startSeq, endSeq, agent) {
      const session = agent.session
      if (session.id === A.session.id) {
        enteredAResolve()
        await new Promise((r) => { releaseA = r })
      }
      order.push(session.id)
      const nodes = session.surface.nodes
      const startIdx = nodes.indexOf(startSeq)
      const endIdx = nodes.indexOf(endSeq)
      const shadowed = nodes.slice(startIdx, endIdx + 1)
      session.surface.nodes = nodes.slice(0, startIdx).concat(nodes.slice(endIdx + 1))
      states.set(session.id, applyTaskMarks(states.get(session.id), { type: 'compaction/summary', data: { shadowedSeqs: shadowed } }))
      return { shadowedTokenCount: 1000 }
    }
  }
  const drain = createArchiveDrain({ ctx, engineFor: async () => engine, closingTasks: new Map() })

  const pA = drain.processDeferredArchives(A.agent, undefined)
  await enteredA
  // A's fold is mid-flight; B's drain must NOT wait for it (the old
  // process-level guard returned silently here, deferring B to a boundary
  // that might never come at turn stop).
  const pB = drain.processDeferredArchives(B.agent, undefined)
  await pB
  assert.deepEqual(order, ['sess-b'], 'B folded while A was still in flight')
  releaseA()
  await pA
  assert.deepEqual(order, ['sess-b', 'sess-a'], 'A folded after its release')
  assert.equal(states.get(A.session.id), null, 'A row closed out of the projection')
  assert.equal(states.get(B.session.id), null, 'B row closed out of the projection')
})

// The same-session guard exists only for theoretical reentry (the host loop
// serializes one session's dispatch): a reentrant call merges into ONE
// chained pass instead of being dropped to a boundary a settled session may
// never reach. After the in-flight fold commits, the chained pass re-plans,
// finds the row gone, and bills zero extra summarization calls.
test('same-session reentry chains one pass instead of dropping it', async () => {
  const events = [
    assistantCall(10, [{ id: 'r1', name: 'task_begin' }]),
    toolResult(11, 'r1', BEGUN('reentry', '1 open.')),
    assistantCall(20, [{ id: 'r2', name: 'task_end' }]),
    toolResult(21, 'r2', ENDED('reentry', 'all closed. Archival queued.')),
    assistantText(25, 'deliverable')
  ]
  let state = null
  for (const e of events) state = applyTaskMarks(state, e)
  const session = { id: 'sess-r', events, surface: { nodes: [10, 11, 20, 21, 25] } }
  const agent = { session }
  const ctx = { sessionProjections: { stateOf: () => state } }
  const attempts = []
  let release
  let enteredResolve
  const entered = new Promise((r) => { enteredResolve = r })
  const engine = {
    async compactRegion(startSeq, endSeq) {
      attempts.push([startSeq, endSeq])
      enteredResolve()
      await new Promise((r) => { release = r })
      const nodes = session.surface.nodes
      const startIdx = nodes.indexOf(startSeq)
      const endIdx = nodes.indexOf(endSeq)
      const shadowed = nodes.slice(startIdx, endIdx + 1)
      session.surface.nodes = nodes.slice(0, startIdx).concat(nodes.slice(endIdx + 1))
      state = applyTaskMarks(state, { type: 'compaction/summary', data: { shadowedSeqs: shadowed } })
      return { shadowedTokenCount: 1000 }
    }
  }
  const drain = createArchiveDrain({ ctx, engineFor: async () => engine, closingTasks: new Map() })

  const p1 = drain.processDeferredArchives(agent, undefined)
  await entered
  const p2 = drain.processDeferredArchives(agent, undefined) // reentrant while p1's fold is in flight
  await p2 // merged and returned, never dropped
  release()
  await p1
  assert.equal(attempts.length, 1, 'the chained pass re-planned a settled row and billed nothing')
  assert.equal(state, null, 'row closed out of the projection')
})
