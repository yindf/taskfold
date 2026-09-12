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
//
// Since the unsettled-commit backoff the pass SPLITS in two: the commit that
// stops below the close result ends pass 1 immediately (the old free re-plan
// in the SAME pass was the live cascade — one task re-summarized 5 times),
// and the residual close pair is walked on the next scheduled boundary.
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

  // Pass 1: the walk commits at the summary node's position and stops there.
  await h.drain.processDeferredArchives(h.agent, undefined)
  assert.deepEqual(h.attempts.slice(0, 3), [[226, 216], [226, 214], [226, 220]], 'the END walks back one surface POSITION at a time')
  assert.deepEqual(h.folds, [[226, 220]], 'the first acceptable boundary commits')
  // The commit stopped BELOW the close result, so the row survived the
  // reducer: the entry joins the backoff schedule instead of re-planning
  // for free — that re-plan is a whole summarization call.
  assert.equal(h.attempts.length, 3, 'an unsettled commit ends the pass: no free re-plan')
  const attempt = h.drain.autoFoldAttempts.get(h.session.id).get(177)
  assert.equal(attempt.attempts, 1)
  assert.equal(attempt.nextPass, 2, 'attempt 1 backs off one boundary')
  assert.match(h.drain.autoFoldFailures.get(h.session.id).get('gamma'), /^fold committed below the close result, attempt 1/)
  assert.deepEqual(h.state().pendingArchives.map((p) => p.name), ['gamma'], 'the entry stays queued (its close result was never shadowed)')

  // Pass 2 (the scheduled retry): the residual close pair cannot be cut at
  // either node (its CALL is unbalanced too), so the walk stops at the
  // minimal region — two more attempts, nothing commits, and the null
  // result settles the entry.
  await h.drain.processDeferredArchives(h.agent, undefined)
  assert.deepEqual(h.attempts.slice(3), [[214, 216], [214, 214]], 'the walk stops when the END reaches the START')
  assert.equal(h.folds.length, 1, 'the retry commits nothing more')
  assert.ok(h.drain.isSettledArchive(h.session, 177), 'the null result settles the entry in memory')
  assert.equal(h.drain.autoFoldFailures.get(h.session.id).get('gamma'), undefined, 'settling clears the HOLD line')
  assert.deepEqual(h.state().pendingArchives.map((p) => p.name), ['gamma'], 'the projection row persists (anchor never shadowed) — settle is in-memory only')
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

// Cross-session starvation (live on dsh 0.1.5): the drain guard is
// process-global, and subagent sessions share the process. Session A's turn
// stop fired while session B's re-fold cascade was mid-flight; the guard
// returned silently, A never saw another step boundary, and its closed task
// sat queued forever (the wechatide-skill session that never folded). A
// starved call must QUEUE its agent: the running pass chains one more pass
// in its finally, so the fold happens even with no further boundary.
test('a starved cross-session drain call is chained, not dropped', async () => {
  // Two sessions, one projection state each; ctx.stateOf dispatches by
  // session object the way the host's sessionProjections does.
  function mini(id) {
    const events = [
      assistantCall(10, [{ id: 'a1', name: 'task_begin' }]),
      toolResult(11, 'a1', BEGUN(id + ' task', '1 open.')),
      assistantCall(20, [{ id: 'a2', name: 'task_end' }]),
      toolResult(21, 'a2', ENDED(id + ' task', 'all closed. Archival queued.')),
      assistantText(25, id + ' deliverable')
    ]
    let state = null
    for (const e of events) state = applyTaskMarks(state, e)
    return {
      agent: { session: { id, events, surface: { nodes: [10, 11, 20, 21, 25] } } },
      state: () => state,
      setState(s) { state = s }
    }
  }
  const a = mini('session-a')
  const b = mini('session-b')
  const states = new Map([[a.agent.session.id, a], [b.agent.session.id, b]])
  const ctx = { sessionProjections: { stateOf: (session) => states.get(session.id).state() } }

  // Session A's fold awaits a gate while session B's turn-stop hook fires.
  const folds = []
  let releaseA
  const gate = new Promise((resolve) => { releaseA = resolve })
  const engine = {
    async compactRegion(startSeq, endSeq, agent) {
      const m = states.get(agent.session.id)
      if (agent.session.id === 'session-a') { const g = gate; await g }
      folds.push([agent.session.id, startSeq, endSeq])
      const nodes = agent.session.surface.nodes
      const startIdx = nodes.indexOf(startSeq)
      const endIdx = nodes.indexOf(endSeq)
      m.setState(applyTaskMarks(m.state(), { type: 'compaction/summary', data: { shadowedSeqs: nodes.slice(startIdx, endIdx + 1) } }))
      agent.session.surface.nodes = nodes.slice(0, startIdx).concat(nodes.slice(endIdx + 1))
      return { shadowedTokenCount: 500 }
    }
  }
  const drain = createArchiveDrain({ ctx, engineFor: async () => engine, closingTasks: new Map() })

  // B's pass is mid-flight when A's turn-stop hook dispatches: A must return
  // immediately (never block the hook) but its agent is queued behind B.
  const passB = drain.processDeferredArchives(b.agent, undefined)
  const starvedA = drain.processDeferredArchives(a.agent, undefined)
  await starvedA
  assert.deepEqual(folds, [['session-b', 20, 21]], 'B folds while A waits in the queue')

  releaseA()
  await passB
  // The chained pass folded A with no further boundary of its own.
  assert.deepEqual(folds, [['session-b', 20, 21], ['session-a', 20, 21]], 'the running pass chains the starved session')
  assert.ok(drain.isSettledArchive(a.agent.session, 10) && drain.isSettledArchive(b.agent.session, 10), 'both rows settled')
  assert.equal(a.state(), null, 'A row closed out of its projection')
  assert.equal(b.state(), null, 'B row closed out of its projection')
})

// P1 review-found: a 'summary' rejection (the host's 'not smaller', or a
// structure failure) used to settle the entry on its FIRST occurrence —
// one unlucky generation permanently abandoned the archive. The first
// occurrence now joins the backoff schedule with a HOLD line and re-bills
// exactly once; only the SECOND consecutive rejection settles.
test('a summary rejection settles only on the second consecutive occurrence', async () => {
  const h = harness([
    assistantCall(10, [{ id: 'a1', name: 'task_begin' }]),
    toolResult(11, 'a1', BEGUN('lump', '1 open.')),
    assistantCall(20, [{ id: 'a2', name: 'task_end' }]),
    toolResult(21, 'a2', ENDED('lump', 'all closed. Archival queued.')),
    assistantText(25, 'deliverable')
  ], { failWith: 'summary is not smaller than the region it replaces' })

  // Pass 1: one billed attempt, no settle, a HOLD line naming the cause.
  await h.drain.processDeferredArchives(h.agent, undefined)
  assert.equal(h.attempts.length, 1, 'the first rejection bills one summarization call')
  assert.ok(!h.drain.isSettledArchive(h.session, 10), 'the first rejection does NOT settle the archive')
  assert.match(h.drain.autoFoldFailures.get(h.session.id).get('lump'), /^fold failed, attempt 1: summary is not smaller/, 'the HOLD line names the classified cause')
  assert.deepEqual(h.state().pendingArchives.map((p) => p.name), ['lump'], 'the entry stays queued')

  // Pass 2 (the scheduled retry): the second consecutive rejection settles.
  await h.drain.processDeferredArchives(h.agent, undefined)
  assert.equal(h.attempts.length, 2, 'the retry bills exactly one more call, then gives up')
  assert.ok(h.drain.isSettledArchive(h.session, 10), 'two consecutive rejections settle the archive')
  assert.equal(h.drain.autoFoldFailures.get(h.session.id).get('lump'), undefined, 'settling clears the HOLD line')
  assert.deepEqual(h.state().pendingArchives.map((p) => p.name), ['lump'], 'settle is in-memory: the projection row persists (anchor never shadowed)')
})
