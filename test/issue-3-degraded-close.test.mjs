// E2E regression for taskfold issue #3 (github.com/yindf/taskfold/issues/3):
// a task whose `task_begin` anchor was shadowed by AUTO compaction BEFORE the
// close takes the DEGRADED close path — its result reads
//   'Task ended: <name> — Mark no longer on the surface; task closed without folding.'
// (or 'Engine unavailable; task closed without folding.'). The tool layer
// queues nothing, so the close must leave NOTHING behind: no pendingArchives
// row, no permanent 'folding…' dock row, no stuck 'N folding' counter.
//
// The synthetic session replays that exact shape through the REAL public
// seams — no re-implementation of the logic under test:
//   applyTaskMarks       (plugins/task-marks.mjs)        projection reducer
//   createArchiveDrain   (plugins/fold-drain.mjs)        deferred auto-folder
//   pruneBelowFloorView  (plugins/taskfold.mjs)          host-side wire view
//   taskStackView        (plugins/task-stack-ui.mjs)     dock display model
//   taskStackLine        (plugins/lifecycle-nudges.mjs)  lifecycle stack hint
//
// The plugin root comes from TASKFOLD_ROOT (default: this checkout's own
// plugins/), so the SAME file proves the repro against a pre-fix worktree and
// the fix against the patched tree:
//   node test/issue-3-degraded-close.test.mjs
//   $env:TASKFOLD_ROOT='<pre-fix>\plugins'; node test/issue-3-degraded-close.test.mjs
//
// Frozen pre-fix / post-fix expectation table (contract:
// .scratch/taskfold-issue3-contract.md) — assertion → pre-fix → post-fix:
//   1 the close pops the mark                                yes     yes
//   2 no pendingArchives row for that close                 FAILS   passes
//   3 deferredArchivePlan(row, …).action                    'drop'  n/a (no row)
//   4 the drain publishes no display key for a dead row     FAILS   passes
//   5 taskStackView(view): closing [] and visible false     FAILS   passes
//   6 taskStackLine(…): no counted 'N folding'              FAILS   passes
//   7 a genuinely queued, foldable task still folds         passes  passes
//
// Test → contract rows:
//   'F1: a degraded close pops the mark …'            → 1, 2 (+7 at replay seam)
//   'E2E: … no folding… dock row'                     → 5, 7, 4 (pruned view)
//   'E2E: the lifecycle hint reports no folding …'    → 6
//   'F2/F3: an already-stuck drop row …'              → 3, 4, 5, 6 / F2, F3
//   'F1: degraded close texts queue nothing …'        → 1, 2 both texts + regressions
//   'frozen API surface …'                            → F1/F3 export contract
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ── plugin root (TASKFOLD_ROOT selects the tree under test) ────────────────
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.TASKFOLD_ROOT !== undefined && process.env.TASKFOLD_ROOT !== ''
  ? path.resolve(process.env.TASKFOLD_ROOT)
  : path.resolve(HERE, '..', 'plugins')

async function loadPlugin(file) {
  return import(pathToFileURL(path.join(ROOT, file)).href)
}

const marksMod = await loadPlugin('task-marks.mjs')
const drainMod = await loadPlugin('fold-drain.mjs')
const taskfoldMod = await loadPlugin('taskfold.mjs')
const stackUiMod = await loadPlugin('task-stack-ui.mjs')
const nudgesMod = await loadPlugin('lifecycle-nudges.mjs')

const {
  applyTaskMarks, archivesOf, marksOf, pendingOf, pendingArchiveKey,
  belowFloorArchiveKeys, deferredArchivePlan, taskMarksStateSchema
} = marksMod
const { createArchiveDrain } = drainMod
const { pruneBelowFloorView } = taskfoldMod
const { taskStackView } = stackUiMod
const { taskStackLine } = nudgesMod

// Evidence for the captured pre-fix / post-fix outputs: which tree ran, and
// whether the frozen fix symbols are present in it.
console.log('[issue-3] plugin root: ' + ROOT)
console.log('[issue-3] F1 UNFOLDED_CLOSE_MARKER=' + String(marksMod.UNFOLDED_CLOSE_MARKER)
  + ' F3 terminalArchiveKeys=' + typeof marksMod.terminalArchiveKeys)

// ── event builders (the persisted shapes every reader accepts) ─────────────

/** assistant/message carrying tool-call blocks (shape per dsh-agent-loop). */
function assistantCall(seq, calls) {
  return { seq, type: 'assistant/message', data: { message: { content: calls.map((c) => ({ type: 'tool-call', id: c.id, name: c.name })) } } }
}

/** assistant/message carrying one plain text block (a deliverable). */
function assistantText(seq, text) {
  return { seq, type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } }
}

/** tool/result in the block-linkage grammar ('tool-result' blocks). */
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

const BEGUN = (name) => 'Task begun: ' + name + ' — 1 open.'
const ENDED = (name, tail) => 'Task ended: ' + name + ' — ' + tail
const NORMAL_CLOSE = 'all closed. Archival queued.'
/** The two degraded closes the issue reports (both carry the same phrase). */
const DEGRADED_CLOSES = [
  'Mark no longer on the surface; task closed without folding.',
  'Engine unavailable; task closed without folding.'
]

// ── the synthetic session (issue #3's exact shape) ─────────────────────────
const ANCHOR_SEQ = 10
const BEGUN_SEQ = 11
const WORK_SEQ = 12
const AUTO_SUMMARY_SEQ = 40 // the AUTO compaction that SHADOWS [10, 11]
const CLOSE_CALL_SEQ = 50
const CLOSE_RESULT_SEQ = 51
const POST_CLOSE_SEQ = 60 // first assistant message after the close: the gate
const OK_ANCHOR_SEQ = 70
const OK_BEGUN_SEQ = 71
const OK_WORK_SEQ = 72
const OK_CLOSE_CALL_SEQ = 80
const OK_CLOSE_RESULT_SEQ = 81
const OK_GATE_SEQ = 90
const DEGRADED = 'degraded'
const HEALTHY = 'healthy'

/**
 * begin anchor (10) + 'Task begun' result (11) → work (12) → AUTO
 * compaction/summary (40) shadowing the anchor pair → task_end close
 * message (50) + degraded close result (51) → later assistant message (60)
 * that opens the drain's deliverable gate. The SAME log carries a
 * genuinely queued, foldable task (70..81, gate 90): the no-regression case.
 */
function issueLog() {
  const events = [
    assistantCall(ANCHOR_SEQ, [{ id: 'a1', name: 'task_begin' }]),
    toolResult(BEGUN_SEQ, 'a1', BEGUN(DEGRADED)),
    assistantText(WORK_SEQ, 'work inside the degraded task'),
    {
      seq: AUTO_SUMMARY_SEQ,
      type: 'compaction/summary',
      data: { shadowedSeqs: [ANCHOR_SEQ, BEGUN_SEQ] }
    },
    assistantCall(CLOSE_CALL_SEQ, [{ id: 'a2', name: 'task_end' }]),
    toolResult(CLOSE_RESULT_SEQ, 'a2', ENDED(DEGRADED, DEGRADED_CLOSES[0])),
    assistantText(POST_CLOSE_SEQ, 'deliverable after the degraded close (opens the drain gate)'),
    assistantCall(OK_ANCHOR_SEQ, [{ id: 'c1', name: 'task_begin' }]),
    toolResult(OK_BEGUN_SEQ, 'c1', BEGUN(HEALTHY)),
    assistantText(OK_WORK_SEQ, 'work inside the healthy task'),
    assistantCall(OK_CLOSE_CALL_SEQ, [{ id: 'c2', name: 'task_end' }]),
    toolResult(OK_CLOSE_RESULT_SEQ, 'c2', ENDED(HEALTHY, NORMAL_CLOSE)),
    assistantText(OK_GATE_SEQ, 'final deliverable')
  ]
  // The surface the host holds AFTER that AUTO compaction committed: the
  // shadowed begin pair is gone and its summary node (40) sits in its place.
  const surface = [
    AUTO_SUMMARY_SEQ, WORK_SEQ, CLOSE_CALL_SEQ, CLOSE_RESULT_SEQ, POST_CLOSE_SEQ,
    OK_ANCHOR_SEQ, OK_BEGUN_SEQ, OK_WORK_SEQ, OK_CLOSE_CALL_SEQ, OK_CLOSE_RESULT_SEQ, OK_GATE_SEQ
  ]
  return { events, surface }
}

// ── harness ────────────────────────────────────────────────────────────────

/** Fold the real reducer over a log, exactly the way the projection replays it. */
function replayLog(events) {
  let state = null
  for (const e of events) state = applyTaskMarks(state, e)
  return state
}

/**
 * One synthetic session around the real seams: the projection state the
 * drain/accessors read through ctx, a surface the engine double rewrites,
 * and an engine double that mirrors a committed fold (slice the region by
 * surface POSITION, replace it with ONE summary node, commit the
 * compaction/summary event through the reducer). opts.state overrides the
 * replayed projection — used to hand the drain a state a PRE-FIX build left
 * behind.
 */
function makeHarness(events, surface, opts) {
  const o = opts === undefined ? {} : opts
  const session = { id: 'issue-3-' + Math.random().toString(36).slice(2, 8), events, surface: { nodes: surface.slice() } }
  let current = o.state !== undefined ? o.state : replayLog(events)
  const ctx = { sessionProjections: { stateOf: () => current } }
  const registry = new Set()
  registry.version = 0
  const folds = []
  const attempts = []

  function appendEvent(e) {
    session.events.push(e)
    current = applyTaskMarks(current, e)
  }

  function nextSeq() {
    let max = 0
    for (const e of session.events) if (Number.isInteger(e.seq) && e.seq > max) max = e.seq
    for (const n of session.surface.nodes) if (n > max) max = n
    return max + 1
  }

  const engine = {
    async compactRegion(startSeq, endSeq) {
      attempts.push([startSeq, endSeq])
      const nodes = session.surface.nodes
      const startIdx = nodes.indexOf(startSeq)
      const endIdx = nodes.indexOf(endSeq)
      if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
        throw new Error('compactRegion: start seq ' + startSeq + ' is after end seq ' + endSeq + ' on the surface')
      }
      const shadowed = nodes.slice(startIdx, endIdx + 1)
      const summarySeq = nextSeq()
      session.surface.nodes = nodes.slice(0, startIdx).concat([summarySeq], nodes.slice(endIdx + 1))
      appendEvent({ seq: summarySeq, type: 'compaction/summary', data: { shadowedSeqs: shadowed } })
      folds.push([startSeq, endSeq])
      return { shadowedTokenCount: 1000 }
    }
  }

  const drain = createArchiveDrain({
    ctx,
    engineFor: async () => engine,
    closingTasks: new Map(),
    settings: { minSpanTokens: 0 },
    belowFloorKeys: registry
  })
  return {
    session,
    agent: { session },
    ctx,
    registry,
    drain,
    folds,
    attempts,
    pruneView: pruneBelowFloorView(registry),
    rawState: () => current
  }
}

/** pendingArchives rows carrying `name` ([] for a null/foreign state). */
function rowsNamed(state, name) {
  const base = state !== null && typeof state === 'object' && !Array.isArray(state) ? state : null
  const rows = base !== null && Array.isArray(base.pendingArchives) ? base.pendingArchives : []
  return rows.filter((r) => r !== null && typeof r === 'object' && r.name === name)
}

/**
 * The two TERMINAL buckets the lifecycle hint subtracts from 'folding'
 * (contract F3, terminalArchiveKeys). On a pre-fix tree that export does not
 * exist yet, so the fallback reproduces exactly what taskfold.mjs passed
 * before the fix — belowFloor only, no dropped bucket. That fallback IS the
 * defect the counter assertion pins: a row that can never fold has no bucket
 * and is reported as 'N folding' forever.
 */
function counterCounts(ctx, session, floor) {
  if (typeof marksMod.terminalArchiveKeys === 'function') {
    const out = marksMod.terminalArchiveKeys(ctx, session, floor)
    assert.ok(out !== null && typeof out === 'object', 'F3: terminalArchiveKeys must return an object')
    assert.ok(out.belowFloor instanceof Set, 'F3: terminalArchiveKeys().belowFloor must be a Set')
    assert.ok(out.dropped instanceof Set, 'F3: terminalArchiveKeys().dropped must be a Set')
    return { belowFloor: out.belowFloor, dropped: out.dropped }
  }
  return { belowFloor: belowFloorArchiveKeys(ctx, session, floor), dropped: new Set() }
}

/** The lifecycle stack line exactly as taskfold.mjs lifecycleLines builds it. */
function lifecycleStackLine(h, floor) {
  const counts = counterCounts(h.ctx, h.session, floor)
  return taskStackLine(
    marksOf(h.ctx, h.session),
    archivesOf(h.ctx, h.session),
    pendingOf(h.ctx, h.session),
    counts.belowFloor.size,
    counts.dropped.size
  )
}

// ── tests ──────────────────────────────────────────────────────────────────

// Contract rows 1 and 2 at the reducer seam.
test('#3 F1: a degraded close pops the mark and queues no archive row', () => {
  const { events } = issueLog()
  const state = replayLog(events)
  assert.deepEqual(state.marks, [], 'the degraded close pops the mark')
  const deadRows = rowsNamed(state, DEGRADED)
  assert.deepEqual(
    deadRows,
    [],
    'F1: a degraded close must queue NO pendingArchives row — its anchor is already off the surface, so the row can never fold. Got: ' + JSON.stringify(deadRows)
  )
  assert.deepEqual(
    rowsNamed(state, HEALTHY).map((r) => r.name),
    [HEALTHY],
    'the genuinely queued task in the SAME log is still queued'
  )
})

// Contract rows 5 and 7, end to end: the drain over the deliverable gate,
// then the dock's own display model over the pruned wire view. Pre-fix the
// dead row survives (its plan is 'drop': settled in memory, never removed
// from the projection), so the dock renders the permanent 'folding…' row.
test('#3 E2E: the degraded close leaves no folding… dock row', async () => {
  const { events, surface } = issueLog()
  const h = makeHarness(events, surface)
  await h.drain.processDeferredArchives(h.agent, undefined)

  // Row 7 — no regression: the foldable task folded, exactly once, and the
  // degraded close billed no summarization call.
  assert.deepEqual(h.folds, [[OK_WORK_SEQ, OK_CLOSE_RESULT_SEQ]], 'the genuinely queued task still folds in the same pass')
  assert.deepEqual(h.attempts, [[OK_WORK_SEQ, OK_CLOSE_RESULT_SEQ]], 'exactly one region was compacted')

  // Rows 5/4 — the dock's own display model over the pruned wire view, then
  // the wire view itself (the row the dock must never see again).
  const wire = h.pruneView(h.rawState())
  const view = taskStackView(wire)
  assert.equal(
    view.closing.length,
    0,
    'the dock must not render a permanent folding… row for a task closed without folding. Got closing: ' + JSON.stringify(view.closing)
  )
  assert.equal(view.visible, false, 'nothing is left to render. Got view: ' + JSON.stringify(view))
  assert.deepEqual(rowsNamed(wire, DEGRADED), [], 'the wire view lists no archive row for the degraded close')

  // Permanence: a second boundary changes nothing at all.
  await h.drain.processDeferredArchives(h.agent, undefined)
  assert.deepEqual(h.folds, [[OK_WORK_SEQ, OK_CLOSE_RESULT_SEQ]], 'no re-fold on the next boundary')
  const view2 = taskStackView(h.pruneView(h.rawState()))
  assert.equal(view2.closing.length, 0, 'still no folding… row after a second boundary. Got closing: ' + JSON.stringify(view2.closing))
  assert.equal(view2.visible, false, 'still nothing to render after a second boundary')
})

// Contract row 6: the lifecycle hint line, built exactly as taskfold.mjs
// lifecycleLines builds it. Pre-fix the dead row has no terminal bucket
// (belowFloorArchiveKeys only classifies FOLD plans), so the hint keeps
// reporting '1 folding' forever — the issue's second symptom.
test('#3 E2E: the lifecycle hint reports no folding task after a degraded close', async () => {
  const { events, surface } = issueLog()
  const h = makeHarness(events, surface)
  await h.drain.processDeferredArchives(h.agent, undefined)
  // The benign empty tail ('nothing folding or pending') also contains the
  // WORD folding, so the assertion keys on the counted form the issue
  // reports: '<n> folding'.
  const line = lifecycleStackLine(h, 0)
  assert.equal(/\d+\s+folding/.test(line), false, 'the lifecycle hint must not report a folding task. Got: ' + line)
})

// Rows 3-6 for a row that IS queued: the projection a PRE-FIX build left
// behind (the user's actual stuck state after upgrading). F1 stops NEW rows;
// F2/F3 must still clean up the rows already in a session. The fixture is
// exactly the row applyTaskMarks pushed for this close before F1 — verified
// against the real state schema.
test('#3 F2/F3: an already-stuck drop row is settled, unpublished and counted apart', async () => {
  const row = { seq: ANCHOR_SEQ, name: DEGRADED, foldResultSeq: CLOSE_RESULT_SEQ }
  const fixture = { pending: Object.create(null), marks: [], pendingArchives: [row] }
  assert.equal(taskMarksStateSchema.parse(fixture), fixture, 'the fixture is a legal persisted projection state')

  const { events, surface } = issueLog()
  const h = makeHarness(events, surface, { state: fixture })
  const key = pendingArchiveKey(row)

  // Row 3 — the row's own verdict: it can never fold (its begin anchor left
  // the surface with the AUTO compaction, which is already in the past, so no
  // future compaction event will ever list it again).
  assert.equal(deferredArchivePlan(row, surface, events).action, 'drop', 'a row whose anchor is off the surface plans as drop')
  // ...and the pre-fix counter's only terminal bucket cannot see it: floor 0
  // folds everything and belowFloorArchiveKeys only classifies FOLD plans.
  // That is why the hint reported it as 'folding' forever.
  assert.equal(belowFloorArchiveKeys(h.ctx, h.session, 0).size, 0, 'a drop row is not a below-floor row')

  await h.drain.processDeferredArchives(h.agent, undefined)
  assert.deepEqual(h.attempts, [], 'a drop verdict bills no summarization call')

  // Row 4 — F2: a terminal verdict publishes its display key so the dock can
  // stop drawing the row, and the wire view prunes it.
  assert.equal(h.registry.has(key), true, 'F2: the drop verdict must publish the row display key into the shared settle registry')
  const wire = h.pruneView(h.rawState())
  assert.deepEqual(rowsNamed(wire, DEGRADED), [], 'the wire view drops the settled row')
  assert.equal(wire === null ? 0 : wire.pendingArchives.length, 0, 'no archive row survives in the wire view')

  // Row 5 — the dock.
  const view = taskStackView(wire)
  assert.equal(view.closing.length, 0, 'the dock must not render a permanent folding… row. Got closing: ' + JSON.stringify(view.closing))
  assert.equal(view.visible, false, 'nothing is left to render. Got view: ' + JSON.stringify(view))

  // Row 6 — F3: the hint counts the row apart, never as folding.
  const counts = counterCounts(h.ctx, h.session, 0)
  assert.equal(counts.dropped.has(key), true, 'F3: terminalArchiveKeys must put a drop row in the dropped bucket')
  assert.equal(counts.belowFloor.size, 0, 'F3: the dropped row is not a below-floor row')
  const line = lifecycleStackLine(h, 0)
  assert.equal(/\d+\s+folding/.test(line), false, 'the lifecycle hint must not report a folding task. Got: ' + line)
  assert.match(line, /1 closed unfolded/, 'the hint reports the terminal row in its own bucket. Got: ' + line)
  assert.equal(/\d+\s+closed below floor/.test(line), false, 'a dropped row must not be mislabeled below-floor. Got: ' + line)
})

// F1 for BOTH degraded closes the issue reports, plus the regressions the
// same reducer branch must keep: an ordinary close still queues its row, and
// a below-floor close (0.37.6 marker) still queues nothing.
test('#3 F1: degraded close texts queue nothing; normal and below-floor closes are unchanged', () => {
  for (const tail of DEGRADED_CLOSES) {
    const state = replayLog([
      assistantCall(ANCHOR_SEQ, [{ id: 'a1', name: 'task_begin' }]),
      toolResult(BEGUN_SEQ, 'a1', BEGUN('t')),
      assistantCall(CLOSE_CALL_SEQ, [{ id: 'a2', name: 'task_end' }]),
      toolResult(CLOSE_RESULT_SEQ, 'a2', ENDED('t', tail))
    ])
    const marksLeft = state === null || state === undefined ? [] : state.marks
    assert.deepEqual(marksLeft, [], 'the degraded close pops the mark: ' + tail)
    const rows = state === null || state === undefined ? [] : state.pendingArchives
    assert.deepEqual(rows, [], 'F1: the degraded close queues no archive row: ' + tail)
    assert.equal(state, null, 'and nothing else is left: the projection normalizes to null')
  }

  const normal = replayLog([
    assistantCall(ANCHOR_SEQ, [{ id: 'a1', name: 'task_begin' }]),
    toolResult(BEGUN_SEQ, 'a1', BEGUN('t')),
    assistantCall(CLOSE_CALL_SEQ, [{ id: 'a2', name: 'task_end' }]),
    toolResult(CLOSE_RESULT_SEQ, 'a2', ENDED('t', NORMAL_CLOSE))
  ])
  assert.deepEqual(normal.pendingArchives, [{ seq: ANCHOR_SEQ, name: 't', foldResultSeq: CLOSE_RESULT_SEQ }], 'a normal close still queues its archive')

  const floored = replayLog([
    assistantCall(ANCHOR_SEQ, [{ id: 'a1', name: 'task_begin' }]),
    toolResult(BEGUN_SEQ, 'a1', BEGUN('t')),
    assistantCall(CLOSE_CALL_SEQ, [{ id: 'a2', name: 'task_end' }]),
    toolResult(CLOSE_RESULT_SEQ, 'a2', ENDED('t', 'Closed below the fold floor (12 tokens < 2000).'))
  ])
  assert.equal(floored, null, 'a below-floor close still queues nothing (0.37.6 marker contract)')
})

// The frozen API surface F1/F3 add, and the identical semantics F3 promises
// for the accessor it reimplements.
test('#3 frozen API surface: UNFOLDED_CLOSE_MARKER and terminalArchiveKeys', () => {
  assert.equal(marksMod.UNFOLDED_CLOSE_MARKER, 'task closed without folding', 'F1 freezes this export value (the phrase both degraded closes carry)')
  assert.equal(typeof marksMod.terminalArchiveKeys, 'function', 'F3 freezes this export: terminalArchiveKeys(ctx, session, minSpanTokens)')
  assert.equal(typeof belowFloorArchiveKeys, 'function', 'F3 keeps belowFloorArchiveKeys exported')

  // Identical semantics on a real below-floor row: one ordinary close whose
  // tiny region sits under a huge floor.
  const events = [
    assistantCall(ANCHOR_SEQ, [{ id: 'a1', name: 'task_begin' }]),
    toolResult(BEGUN_SEQ, 'a1', BEGUN('tiny')),
    assistantText(WORK_SEQ, 'tiny work'),
    assistantCall(CLOSE_CALL_SEQ, [{ id: 'a2', name: 'task_end' }]),
    toolResult(CLOSE_RESULT_SEQ, 'a2', ENDED('tiny', NORMAL_CLOSE)),
    assistantText(POST_CLOSE_SEQ, 'deliverable')
  ]
  const h = makeHarness(events, [ANCHOR_SEQ, BEGUN_SEQ, WORK_SEQ, CLOSE_CALL_SEQ, CLOSE_RESULT_SEQ, POST_CLOSE_SEQ])
  const key = pendingArchiveKey({ seq: ANCHOR_SEQ, name: 'tiny', foldResultSeq: CLOSE_RESULT_SEQ })
  assert.deepEqual([...belowFloorArchiveKeys(h.ctx, h.session, 100000)], [key], 'belowFloorArchiveKeys still classifies a tiny region as below floor')
  const both = counterCounts(h.ctx, h.session, 100000)
  assert.deepEqual([...both.belowFloor], [key], 'F3 reimplements the SAME belowFloor semantics')
  assert.equal(both.dropped.size, 0, 'a foldable (if tiny) row is not a dropped row')
  assert.equal(counterCounts(h.ctx, h.session, 0).belowFloor.size, 0, 'floor 0 folds everything — nothing is below it')
})
