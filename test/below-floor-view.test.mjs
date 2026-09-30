// Below-floor display plumbing, host side: the wire view PRUNES settled rows
// (they never fold — showing them as 'folding…' was the 0.37.2-era bug) and
// the settle-aware apply wrapper converts a drain-registry version bump into
// a state-reference move so the pruned view is recomputed and pushed without
// waiting for the next task-mark event (the projection registry only re-runs
// a wire view when apply produced a NEW state reference).
import test from 'node:test'
import assert from 'node:assert/strict'
import { pruneBelowFloorView, makeSettleAwareApply } from '../plugins/compact-region.mjs'

/** One well-formed pendingArchives row. */
const row = (seq, name, foldResultSeq) => ({ seq, name, foldResultSeq })
const stateOf = (rows) => ({ pending: {}, marks: [], pendingArchives: rows })

/** A benign event applyTaskMarks ignores (unknown type → same reference). */
const IGNORED = { seq: 99, type: 'agent/inbox/spliced', data: {} }

test('pruneBelowFloorView: settled rows are removed from the wire value, others kept', () => {
  const registry = new Set()
  registry.version = 0
  const view = pruneBelowFloorView(registry)
  const state = stateOf([row(5, 'small', 9), row(20, 'big', 25)])
  // empty registry: reference-stable passthrough (change feed stays quiet)
  assert.equal(view(state), state)
  // the drain settles 'small': its row is pruned, 'big' stays
  registry.add('5:small:9')
  registry.version += 1
  const pruned = view(state)
  assert.notEqual(pruned, state)
  assert.deepEqual(pruned.pendingArchives, [row(20, 'big', 25)])
  // memoized: same state + same version → same output reference
  assert.equal(view(state), pruned)
  // a withdrawn key restores the row on the very same state object —
  // defensive only since 0.37.5 (settles are permanent and the drain never
  // withdraws), but the view stays correct if a future drain ever does.
  registry.delete('5:small:9')
  registry.version += 1
  assert.equal(view(state), state)
})

test('pruneBelowFloorView: null state and rows without pendingArchives pass through', () => {
  const registry = new Set(['5:small:9'])
  registry.version = 3
  const view = pruneBelowFloorView(registry)
  assert.equal(view(null), null)
  const noArchives = { pending: {}, marks: [{ seq: 1, name: 'a' }] }
  assert.equal(view(noArchives), noArchives)
})

test('makeSettleAwareApply: a registry bump turns the next apply into a fresh reference', () => {
  const registry = new Set()
  registry.version = 0
  const apply = makeSettleAwareApply(registry)
  const state = stateOf([row(5, 'small', 9)])
  // no bump: apply is applyTaskMarks verbatim (ignored event → same reference)
  const untouched = apply(state, IGNORED)
  assert.equal(untouched, state)
  // the drain settles between events: the next apply returns a shallow copy
  registry.add('5:small:9')
  registry.version += 1
  const cloned = apply(state, IGNORED)
  assert.notEqual(cloned, state)
  assert.deepEqual(cloned, state)
  // exactly one clone per bump — the following apply is untouched again
  assert.equal(apply(cloned, IGNORED), cloned)
})

test('makeSettleAwareApply: null states (the projection init) stay null', () => {
  const registry = new Set()
  registry.version = 0
  const apply = makeSettleAwareApply(registry)
  registry.version += 1
  assert.equal(apply(null, IGNORED), null)
})
