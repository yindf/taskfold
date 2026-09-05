/**
 * Full-deferred archive machinery (v9): the deliverable-gated auto-folder.
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
import { deferredArchivePlan, marksOf, archivesOf } from './task-marks.mjs'

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
 * processDeferredArchives(agent, signal) is wired into 'agent/pre-step'.
 *
 * At every agent step boundary, drain queue entries whose deliverable has
 * landed (deferredArchivePlan gate), innermost (highest seq) first. Serial
 * by construction; the projection state is re-read before EACH entry
 * because a committed fold rewrites the surface (the previous entry's
 * summary may shadow the next entry's anchor — the reducer then drops it
 * and the re-read no longer lists it).
 */
export function createArchiveDrain({ ctx, engineFor, closingTasks }) {
  const settledArchives = new Map() // session.id → Set<seq>
  const autoFoldFailures = new Map() // session.id → Map<name, bucket>
  let preStepRunning = false

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
    if (preStepRunning) return
    preStepRunning = true
    try {
      const session = agent.session
      for (;;) {
        const entries = archivesOf(ctx, session).filter((e) => !isSettledArchive(session, e.seq))
        if (entries.length === 0) return
        entries.sort((a, b) => b.seq - a.seq)
        const entry = entries[0]
        // Successor anchors: every begin anchor that is still OPEN or still
        // QUEUED and sits after this entry's close — the region must end
        // before the first of them.
        const anchors = marksOf(ctx, session).map((m) => m.seq)
          .concat(archivesOf(ctx, session).filter((q) => q.seq !== entry.seq).map((q) => q.seq))
        const plan = deferredArchivePlan(entry, session.surface.nodes, sessionEvents(session), anchors)
        if (plan.action === 'wait' || plan.action === 'defer') return
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
      preStepRunning = false
    }
  }

  return { processDeferredArchives, isSettledArchive, autoFoldFailures }
}
