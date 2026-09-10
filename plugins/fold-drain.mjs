/**
 * Full-deferred archive machinery (v9): the message-gated auto-folder.
 * Since 0.31.3 the gate opens at the FIRST assistant message after the
 * close result — any content counts (the old text-only requirement held
 * folds open through tool-call-only steps), and the successor-anchor
 * defer is gone (unreachable once anchors are begin-message seqs; see
 * the history note in task-marks.mjs).
 *
 * settledArchives: per-session Set of begin-anchor seqs whose archive is
 * DONE without a fold (too-small at fold time, or dropped by the plan).
 * Process-local bookkeeping only — on replay the entries retry once, hit
 * the same outcome, settle again; no persisted state involved.
 *
 * autoFoldFailures: per-session Map(name → reason bucket) rendered as a
 * HOLD warning line by compact-region's context callback while the
 * condition stands.
 */
import { sessionEvents } from './events.mjs'
import { deferredArchivePlan, archivesOf } from './task-marks.mjs'

function errText(err) {
  return err !== null && typeof err === 'object' && err.message ? String(err.message) : String(err)
}

function classifyCategory(err) {
  const message = errText(err)
  const code = err !== null && typeof err === 'object' && typeof err.code === 'string' ? err.code : null
  const known = ['busy', 'cancelled', 'changed', 'summary', 'commit', 'persistence']
  if (known.indexOf(code) !== -1) return { category: code, message }
  if (/not smaller/i.test(message)) return { category: 'summary', message }
  return { category: 'other', message }
}

function failureBucket(category) {
  if (category === 'busy') return 'compaction lock busy'
  if (category === 'engine') return 'engine unavailable'
  if (category === 'changed') return 'surface changed during fold'
  if (category === 'commit') return 'fold failed to commit'
  return 'fold failed'
}

// Turn-signal guard: bound the summarization call so a lost abort signal
// can never wedge a pre-step. Degrades to the raw signal when the newer
// AbortSignal combinators are unavailable.
function guardedSignal(signal) {
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function' && typeof AbortSignal.timeout === 'function' && signal !== undefined) {
      return AbortSignal.any([signal, AbortSignal.timeout(120000)])
    }
  } catch (err) { /* fall through */ }
  return signal
}

/**
 * Shared fold core: run engine.compactRegion over [startSeq..endSeq] with
 * the balanced-boundary node-by-node fallback (a rejected compactRegion
 * commits nothing, so retries are side-effect free). Returns
 * { tokens } on commit, null when nothing foldable sits in the span
 * (tooSmall semantics). Throws classified errors. The caller owns the
 * closingTasks declaration.
 */
async function foldRegion(session, agent, engine, name, startSeq, endSeq, signal) {
  let result = null
  for (let end = endSeq; end >= startSeq; ) {
    try {
      result = await engine.compactRegion(startSeq, end, agent, signal)
      break
    } catch (err) {
      if (err !== null && typeof err === 'object' && typeof err.message === 'string'
        && err.message.includes('balanced boundary')) {
        // Shrinking the END can never fix an unbalanced START boundary —
        // retrying would walk the whole span pointlessly and end in the
        // silent null-settle path. Fail loud instead: the drain records
        // a failure bucket and the runtime context surfaces it.
        if (err.message.includes('start seq')) throw err
        let prev = -1
        for (const s of session.surface.nodes) {
          if (typeof s === 'number' && s < end && s >= startSeq && s > prev) prev = s
        }
        if (prev === -1) break
        end = prev
        continue
      }
      throw err
    }
  }
  if (result === null) return null
  // Fold number / artifact / preview now live INSIDE the committed
  // summary node (embedded by our summarize override before commit);
  // this core only reports the token count.
  return { tokens: result.shadowedTokenCount }
}

/**
 * The drain factory. `engineFor` comes from createFoldEngine; the returned
 * processDeferredArchives(agent, signal) is wired into BOTH 'agent/pre-step'
 * and 'agent/turn-stopping' (compact-region.mjs): pre-step keeps every queued
 * archive moving; turn-stopping folds turn-final deliverables while the
 * provider prefix cache is still hot. Same-session dispatch order is
 * serialized by the host loop; the running guard below covers cross-session
 * reentry (subagent sessions share this process).
 *
 * At every agent step boundary, drain queue entries whose post-close
 * assistant message has landed (deferredArchivePlan gate), innermost
 * (highest seq) first. Serial
 * by construction; the projection state is re-read before EACH entry
 * because a committed fold rewrites the surface (the previous entry's
 * summary may shadow the next entry's anchor — the reducer then drops it
 * and the re-read no longer lists it). A 'wait' verdict skips that
 * entry for the REST of the pass instead of aborting the drain: one blocked
 * newest entry must not starve the older entries that are already
 * foldable. The skip set dies with the pass — the next boundary retries
 * everything from scratch.
 */
export function createArchiveDrain({ ctx, engineFor, closingTasks }) {
  const settledArchives = new Map() // session.id → Set<seq>
  const autoFoldFailures = new Map() // session.id → Map<name, bucket>
  let drainRunning = false

  function isSettledArchive(session, seq) {
    const set = settledArchives.get(session.id)
    return set !== undefined && set.has(seq)
  }

  function markArchiveSettled(session, seq) {
    let set = settledArchives.get(session.id)
    if (set === undefined) { set = new Set(); settledArchives.set(session.id, set) }
    set.add(seq)
  }

  function clearArchiveFailure(session, name) {
    const fails = autoFoldFailures.get(session.id)
    if (fails !== undefined) fails.delete(name)
  }

  function recordArchiveFailure(session, name, bucket) {
    let fails = autoFoldFailures.get(session.id)
    if (fails === undefined) { fails = new Map(); autoFoldFailures.set(session.id, fails) }
    fails.set(name, bucket)
  }

  async function processDeferredArchives(agent, signal) {
    if (drainRunning) return
    drainRunning = true
    try {
      const session = agent.session
      // Entries passed over this pass ('wait'): skipped, not fatal.
      // Reset when the pass ends so the next boundary re-tries them.
      const skipped = new Set()
      for (;;) {
        const entries = archivesOf(ctx, session)
          .filter((e) => !isSettledArchive(session, e.seq) && !skipped.has(e.seq))
        if (entries.length === 0) return
        entries.sort((a, b) => b.seq - a.seq)
        const entry = entries[0]
        // Successor-anchor machinery is gone (0.31.3): the region is
        // [begin result + 1 .. close result] and successors' begin anchors
        // sit after the close by construction, so no region can cross one,
        // and with anchors being begin-message seqs the first post-close
        // assistant message can never sit after the earliest successor
        // anchor anyway — the old defer branch was unreachable.
        const plan = deferredArchivePlan(entry, session.surface.nodes, sessionEvents(session))
        if (plan.action === 'wait') {
          skipped.add(entry.seq)
          continue
        }
        if (plan.action === 'drop') {
          markArchiveSettled(session, entry.seq)
          clearArchiveFailure(session, entry.name)
          continue
        }
        const engine = await engineFor()
        if (engine === undefined) {
          recordArchiveFailure(session, entry.name, 'engine unavailable')
          return
        }
        try {
          closingTasks.set(session.id, { name: entry.name, startSeq: plan.startSeq, endSeq: plan.endSeq })
          const result = await foldRegion(session, agent, engine, entry.name, plan.startSeq, plan.endSeq, guardedSignal(signal))
          if (result === null) markArchiveSettled(session, entry.seq)
          // No notice message is injected: the committed summary node
          // itself carries the fold number and artifact path (embedded by
          // the summarize override before commit).
          clearArchiveFailure(session, entry.name)
          // A committed fold does NOT drop this entry via the reducer:
          // the region starts AFTER the "Task begun" result, so the begin
          // anchor (entry.seq) sits BEFORE the shadowed range and stays
          // on the surface. Cleanup is the NEXT drain round: the plan
          // re-runs against the rewritten surface, the close result is
          // gone (shadowed by this fold) → 'drop', settled in memory.
          // After a restart the same one-shot re-plan happens again —
          // harmless, no state involved.
        } catch (err) {
          const classified = classifyCategory(err)
          if (classified.category === 'summary') {
            markArchiveSettled(session, entry.seq)
            clearArchiveFailure(session, entry.name)
            continue
          }
          recordArchiveFailure(session, entry.name, failureBucket(classified.category))
          return
        } finally {
          closingTasks.delete(session.id)
        }
      }
    } finally {
      drainRunning = false
    }
  }

  return { processDeferredArchives, isSettledArchive, autoFoldFailures }
}
