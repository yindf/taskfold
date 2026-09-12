/**
 * Full-deferred archive machinery (v9): the message-gated auto-folder.
 * Since 0.32.0 the gate opens at the FIRST assistant message after the
 * close result — any content counts (the old text-only requirement held
 * folds open through tool-call-only steps), and the successor-anchor
 * defer is gone (unreachable once anchors are begin-message seqs; see
 * the history note in task-marks.mjs).
 *
 * settledArchives: per-session Set of begin-anchor seqs whose archive is
 * DONE — a fold we committed that also removed the row from
 * pendingArchives (the region shadowed the close result, so the reducer's
 * archive closure dropped it in the same pass), the too-small / nothing-
 * committed path, or the plan's 'drop' verdict. A fold whose region had to
 * shrink below the close result does NOT settle: the row stays queued and
 * later passes re-plan it — but on the shared backoff schedule, because
 * every unsettled commit is a whole summarization call (the live cascade
 * re-billed one per boundary: a single task summarized 5 times).
 * Process-local bookkeeping only — on replay the entries retry once, hit
 * the same outcome, settle again; no persisted state involved.
 *
 * autoFoldAttempts: per-session Map(begin-anchor seq → { attempts, nextPass,
 * name }) bounding the retry loop. ONE fold attempt costs a whole
 * summarization call (30–70 s), so a deterministic failure (structure
 * receipt, missing host API, provider refusal) must not be re-billed at every
 * step boundary forever: consecutive failures back off geometrically (1, 2,
 * 4, 8 boundaries), and past MAX_FOLD_ATTEMPTS the entry still retries — it is
 * never abandoned silently — but only once per GIVE_UP_PASSES boundaries, so
 * the cost of a permanently broken fold is bounded.
 *
 * autoFoldFailures: per-session Map(name → reason bucket) rendered as a
 * HOLD warning line by compact-region's context callback while the
 * condition stands. The bucket carries the classified error's own message
 * (clipped) and the attempt count — "fold failed, attempt 3: summary
 * structure failure: …" — because the old bucket dropped the message, so the
 * HOLD line named a cause that appeared nowhere in the log.
 *
 * All three maps are keyed by session id and bounded (MAX_TRACKED_SESSIONS):
 * a long-lived host serves one session per subagent and these were the only
 * per-session structures in the plugin that never shrank.
 */
import { sessionEvents } from './events.mjs'
import { deferredArchivePlan, archivesOf } from './task-marks.mjs'

/** Retry budget for one queued archive (see the header contract). */
export const MAX_FOLD_ATTEMPTS = 5
/** Step boundaries between attempts once the budget is spent (self-healing). */
export const GIVE_UP_PASSES = 200
/** Session entries each bookkeeping map keeps before evicting the oldest. */
export const MAX_TRACKED_SESSIONS = 200
/** Starved drain calls queued while another session's pass runs (see below). */
export const MAX_DRAIN_QUEUE = 8
const REASON_CLIP = 160

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
  if (category === 'cancelled') return 'fold cancelled'
  return 'fold failed'
}

/**
 * Backoff in drain passes for attempt N (1-based): 1, 2, 4, 8 boundaries,
 * capped at 8. A pass is one agent step boundary, so the first retries stay
 * prompt — the common transient causes (lock busy, surface changed) clear
 * within a step or two — while a persistent one stops costing a call per step.
 */
function backoffPasses(attempts) {
  return Math.min(2 ** (attempts - 1), 8)
}

/** The classified error's own message, flattened and clipped for a nudge line. */
function reasonOf(classified) {
  const message = typeof classified.message === 'string' ? classified.message.replace(/\s+/g, ' ').trim() : ''
  if (message.length === 0) return ''
  return message.length > REASON_CLIP ? message.slice(0, REASON_CLIP - 1) + '…' : message
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

// Timeout-only guard for a CHAINED pass (a starved drain call that waited
// out another session's pass): its own hook call already returned, its
// turn's signal is long gone, so only the lost-signal bound applies.
function timeoutSignal() {
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(120000)
  } catch (err) { /* fall through */ }
  return undefined
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
  // The walk is driven by surface INDEX, never by seq magnitude. `surface.
  // nodes` is not seq-ordered (a committed fold re-inserts its summary node
  // at the position of the region it shadowed while the node keeps a seq
  // from the log's end), so both the old guard (`end >= startSeq` as NUMBERS)
  // and the old shrink ("the largest seq below `end`") could stop a walk that
  // still had room — or jump to a node outside the region entirely.
  const nodes = session.surface.nodes
  let endPos = nodes.indexOf(endSeq)
  const startPos = nodes.indexOf(startSeq)
  if (endPos === -1 || startPos === -1 || endPos < startPos) return null
  for (;;) {
    try {
      result = await engine.compactRegion(startSeq, nodes[endPos], agent, signal)
      break
    } catch (err) {
      if (err !== null && typeof err === 'object' && typeof err.message === 'string'
        && err.message.includes('balanced boundary')) {
        // Shrinking the END can never fix an unbalanced START boundary —
        // retrying would walk the whole span pointlessly and end in the
        // silent null-settle path. Fail loud instead: the drain records
        // a failure bucket and the runtime context surfaces it.
        if (err.message.includes('start seq')) throw err
        // One position back; the minimal region (start..start) is still
        // attempted before giving up.
        if (endPos <= startPos) break
        endPos -= 1
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
 * reentry (subagent sessions share this process) — a starved call QUEUES
 * its agent and the running pass chains it, instead of dropping it to a
 * next boundary that may never come.
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
  const autoFoldAttempts = new Map() // session.id → Map<seq, { attempts, nextPass, name }>
  let drainRunning = false
  // Starved drain calls (another session's pass was mid-flight at their hook
  // dispatch), drained chained at the end of the running pass — see
  // processDeferredArchives below.
  const drainQueue = []
  // One drain pass = one agent step boundary of SOME session in this process;
  // a monotone counter is all the backoff clock needs.
  let drainPass = 0

  /**
   * Bound one per-session map. A long-lived host accumulates one entry per
   * session it ever served (subagents included). Evicting an old session only
   * costs it a re-derivation — settled → one re-plan that drops again;
   * attempts → a fresh retry budget — never correctness.
   */
  function capSessions(map, keepKey) {
    if (map.size <= MAX_TRACKED_SESSIONS) return
    for (const key of map.keys()) {
      if (key === keepKey) continue
      map.delete(key)
      if (map.size <= MAX_TRACKED_SESSIONS) return
    }
  }

  function isSettledArchive(session, seq) {
    const set = settledArchives.get(session.id)
    return set !== undefined && set.has(seq)
  }

  function markArchiveSettled(session, seq) {
    let set = settledArchives.get(session.id)
    if (set === undefined) { set = new Set(); settledArchives.set(session.id, set); capSessions(settledArchives, session.id) }
    set.add(seq)
    clearAttempt(session, seq)
  }

  function clearArchiveFailure(session, name) {
    const fails = autoFoldFailures.get(session.id)
    if (fails !== undefined) fails.delete(name)
  }

  function recordArchiveFailure(session, name, bucket) {
    let fails = autoFoldFailures.get(session.id)
    if (fails === undefined) { fails = new Map(); autoFoldFailures.set(session.id, fails); capSessions(autoFoldFailures, session.id) }
    fails.set(name, bucket)
  }

  /** Per-entry retry state, or undefined while the entry has never failed. */
  function attemptsOf(session, seq) {
    const bySeq = autoFoldAttempts.get(session.id)
    return bySeq === undefined ? undefined : bySeq.get(seq)
  }

  function recordAttempt(session, seq, name) {
    let bySeq = autoFoldAttempts.get(session.id)
    if (bySeq === undefined) { bySeq = new Map(); autoFoldAttempts.set(session.id, bySeq); capSessions(autoFoldAttempts, session.id) }
    const prev = bySeq.get(seq)
    const next = { attempts: (prev === undefined ? 0 : prev.attempts) + 1, nextPass: 0, name }
    bySeq.set(seq, next)
    return next
  }

  function clearAttempt(session, seq) {
    const bySeq = autoFoldAttempts.get(session.id)
    if (bySeq !== undefined) bySeq.delete(seq)
  }

  async function runDrainPass(agent, signal) {
    drainRunning = true
    drainPass += 1
    try {
      const session = agent.session
      // Entries passed over this pass ('wait', or a backoff boundary):
      // skipped, not fatal. Reset when the pass ends so the next boundary
      // re-tries them.
      const skipped = new Set()
      for (;;) {
        const entries = archivesOf(ctx, session)
          .filter((e) => !isSettledArchive(session, e.seq) && !skipped.has(e.seq))
        if (entries.length === 0) return
        entries.sort((a, b) => b.seq - a.seq)
        const entry = entries[0]
        // Backoff gate: a failing entry sits out its scheduled boundaries, so
        // a deterministic failure cannot re-bill a full summarization call at
        // every single step boundary.
        const pendingAttempt = attemptsOf(session, entry.seq)
        if (pendingAttempt !== undefined && drainPass < pendingAttempt.nextPass) {
          skipped.add(entry.seq)
          continue
        }
        // Successor-anchor machinery is gone (0.32.0): the region is
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
          // Settle when nothing was committed (result === null) or when the
          // committed fold shadowed this entry's close result: the reducer's
          // archive closure then removed the row IN THIS PASS, so the old
          // "next round re-plans and drops it" cleanup can no longer happen.
          // A fold that had to shrink its region BELOW the close result (to
          // avoid an unbalanced boundary) leaves the row queued — and
          // unsettled — on purpose: a later fold may still shadow the close
          // result and drop it. But that re-plan is no longer free at every
          // boundary: each unsettled commit is a full summarization call
          // (live cascade on dsh 0.1.5: one task re-summarized 5 times), so
          // the entry joins the shared backoff schedule and a HOLD line
          // names the state while it stands.
          if (result === null || !archivesOf(ctx, session).some((p) => p.seq === entry.seq)) {
            markArchiveSettled(session, entry.seq)
            clearArchiveFailure(session, entry.name)
          } else {
            const attempt = recordAttempt(session, entry.seq, entry.name)
            attempt.nextPass = drainPass + (attempt.attempts >= MAX_FOLD_ATTEMPTS ? GIVE_UP_PASSES : backoffPasses(attempt.attempts))
            recordArchiveFailure(session, entry.name,
              'fold committed below the close result, attempt ' + attempt.attempts + ' — re-planned with backoff')
            skipped.add(entry.seq)
          }
        } catch (err) {
          const classified = classifyCategory(err)
          if (classified.category === 'summary') {
            // 'not smaller' and structure failures can be a single bad
            // generation; settling on the FIRST occurrence permanently
            // abandoned archives to a transient. Give up only on the
            // SECOND consecutive summary rejection: the first joins the
            // backoff schedule with a HOLD line and re-bills exactly once.
            const attempt = recordAttempt(session, entry.seq, entry.name)
            if (attempt.attempts >= 2) {
              markArchiveSettled(session, entry.seq)
              clearArchiveFailure(session, entry.name)
              continue
            }
            attempt.nextPass = drainPass + backoffPasses(attempt.attempts)
            recordArchiveFailure(session, entry.name,
              failureBucket(classified.category) + ', attempt ' + attempt.attempts + (reasonOf(classified) === '' ? '' : ': ' + reasonOf(classified)))
            skipped.add(entry.seq)
            continue
          }
          const attempt = recordAttempt(session, entry.seq, entry.name)
          attempt.nextPass = drainPass + (attempt.attempts >= MAX_FOLD_ATTEMPTS ? GIVE_UP_PASSES : backoffPasses(attempt.attempts))
          const reason = reasonOf(classified)
          const detail = failureBucket(classified.category) + ', attempt ' + attempt.attempts + (reason === '' ? '' : ': ' + reason)
          // A cancelled fold is the normal shape of an interrupted turn (the
          // user pressed Esc, or the turn was superseded) and the retry is
          // unconditional anyway — so stay quiet on the first occurrence and
          // surface a HOLD line only if cancellation keeps repeating.
          if (classified.category !== 'cancelled' || attempt.attempts >= 2) {
            recordArchiveFailure(session, entry.name, detail)
          }
          return
        } finally {
          closingTasks.delete(session.id)
        }
      }
    } finally {
      drainRunning = false
    }
  }

  /**
   * Public entry, wired to BOTH 'agent/pre-step' and 'agent/turn-stopping'.
   * Cross-session reentry (subagent sessions share this process) used to
   * return SILENTLY while another session's pass was mid-flight — deferring
   * this session's drain to its next step boundary, which AT TURN STOP may
   * never come: a closed task's archive then sat queued forever (live on
   * dsh 0.1.5: the wechatide-skill session never folded because a sibling
   * session's re-fold cascade held the drain across its turn-stop hook).
   * A starved call now QUEUES its agent; the running pass chains one more
   * pass for it in its finally, so the fold happens without any further
   * boundary. The queued pass cannot reuse the starved call's signal — its
   * turn is already over by then — so it runs under the timeout guard
   * alone. Bounded queue: entries beyond the cap keep the old semantics
   * (retried at their own next boundary).
   */
  async function processDeferredArchives(agent, signal) {
    if (drainRunning) {
      if (drainQueue.length < MAX_DRAIN_QUEUE) drainQueue.push(agent)
      return
    }
    try {
      await runDrainPass(agent, signal)
    } finally {
      while (!drainRunning && drainQueue.length > 0) {
        const next = drainQueue.shift()
        await runDrainPass(next, timeoutSignal())
      }
    }
  }

  return { processDeferredArchives, isSettledArchive, autoFoldFailures, autoFoldAttempts }
}
