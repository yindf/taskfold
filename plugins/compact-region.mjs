/**
 * Compact Region tools — plugin-bundle form (installed via `dsh plugin add`
 * at the profile level; cordis.patch.yml mounts this file at the host plane,
 * so the tools land in the global registry for every session of every
 * preset). No realm/isolate-group assumptions are made.
 *
 * Registers the task-lifecycle tools plus prompt guidance:
 *   task_begin / task_end — named tasks; task_end pops the mark and QUEUES an
 *   archive (v9 full-deferred): the span folds AUTOMATICALLY at the next
 *   agent step boundary after the first assistant message follows the
 *   close (0.32.0 message gate — any content; the report belongs there).
 *
 * Zero module dependencies: every capability arrives through `inject`; the
 * compaction engine is self-hosted (fold-engine.mjs).
 *
 * Close semantics (v3): LIFO — only the INNERMOST open task can be closed;
 * closing a blocked or unknown name fails atomically. Degraded closes: a
 * shadowed anchor still CLOSES the task, unfolded. The deferredArchivePlan()
 * pure function (task-marks.mjs) carries the message gate; the pre-step
 * auto-folder (fold-drain.mjs) is an I/O shell around it.
 *
 * The SYSTEM folds [begin assistant message .. close result] INCLUSIVE —
 * begin..end exactly, nothing after the end. The deliverable (written after
 * the close, with full context) and anything else after the end stay on the
 * surface untouched; a later task's own [begin..end] swallows those
 * leftovers in turn. The span cannot contain its own ending, so the scoped
 * summarizer instruction DECLARES completion ("this fold CLOSES the task
 * <name>") instead of showing it — owning the instruction removed the
 * constraint that once forced the two-phase end→commit split.
 *
 * Lifecycle hints: every nudge line (todo bridge, begin/close/decompose
 * hints, auto-fold failure warnings) is published as a STANDALONE
 * plugin-authored user/message (lifecycle-injection.mjs, source.kind
 * 'task-marks:lifecycle') instead of riding the host's runtime-context
 * snapshot — that snapshot is ONE message assembled from every active
 * contribution, so a nudge change re-emitted sandbox:policy and
 * approval:policy with it. A hint is an event: it publishes when its text
 * changes, never as an empty or expiry notice, and carries no wrapper. The
 * todo tool itself is never wrapped or replaced.
 *
 * Module map (plain modules imported by this mounted row — they add no
 * bundle rows of their own, exactly like span-preview.mjs):
 *   events.mjs           shared native-event extractions (sessionEvents…)
 *   task-marks.mjs       the taskMarks projection + pure close/fold decisions
 *   fold-instruction.mjs the two swapped-in summarization instructions
 *   fold-engine.mjs      self-hosted ScopedEngine + lazy resolution
 *   fold-drain.mjs       the message-gated pre-step auto-folder
 *   fold-settings.mjs    user-configurable fold floor (Settings page field)
 *   lifecycle-nudges.mjs pure nudge predicates over an events snapshot
 *   lifecycle-injection.mjs the event-only lifecycle hint channel
 */
import { sessionEvents } from './events.mjs'
import { TASK_MARKS_KEY, taskMarksStateSchema, applyTaskMarks, validTaskName, closeTarget, normalizeName, marksOf, archivesOf, pendingOf, belowFloorArchiveKeys, pendingArchiveKey, lastSurfaceAssistantSeq, siblingTaskMarkCalls } from './task-marks.mjs'
import { DETAILED_CHECKPOINT_INSTRUCTION } from './fold-instruction.mjs'
import { createFoldEngine } from './fold-engine.mjs'
import { createArchiveDrain } from './fold-drain.mjs'
import { todoBridgeLine, taskStackLine, recentWorkCallCount, lastAssistantHasTodoWrite, roundsSinceFoldOutcome, shouldSuggestDecomposition, decomposeHintLine, innermostMark, taskAgeRounds, closePressureLine, CLOSE_PRESSURE_MIN_ROUNDS } from './lifecycle-nudges.mjs'
import { lifecycleMessage, planLifecycleInjection, renderLifecycleBody } from './lifecycle-injection.mjs'
import { DEFAULT_MIN_SPAN_TOKENS, MIN_SPAN_TOKENS_MAX, foldFloorFromConfig } from './fold-settings.mjs'
import nodePath from 'node:path'
import nodeUrl from 'node:url'
import { createRequire } from 'node:module'

// --- Config (Settings page form) -------------------------------------
// The dsh-settings service renders one form per active profile entry from
// the entry's exported Config schema: every `.volatile()` field becomes a
// live row keyed by this row's id (cmpct-region), edits are validated
// against this schema and persisted through the active profile's Cordis
// patch, and the runtime hands apply(ctx, config) reactive refs that a
// Settings edit re-resolves without a plugin reload. That replaces the
// briefly-drafted TASKFOLD_MIN_SPAN_NODES environment variable — same
// floor, but discoverable, validated, and hot-reloaded.
//
// schemastery cannot be imported statically: the installed copy sits in a
// harness-owned node_modules tree that plain ESM resolution never crosses
// (the same constraint fold-engine.mjs resolves for dsh-compaction-basic).
// A synchronous require from a harness anchor file works instead, because
// @deepseek-ai/schemastery ships a CJS build. When no anchor resolves
// (exotic embedding, stripped harness), Config stays undefined: the plugin
// mounts exactly as before, the form is simply absent, and the floor
// keeps its default of 2000 (docs/fold-floor.md).
function requireHostPackage(pkgName) {
  const anchors = []
  try { anchors.push(nodePath.dirname(nodePath.resolve(process.argv[1]))) } catch (err) { /* ignore */ }
  try { anchors.push(nodePath.resolve(process.cwd())) } catch (err) { /* ignore */ }
  for (const dir of anchors) {
    try {
      const requireFromAnchor = createRequire(nodeUrl.pathToFileURL(nodePath.join(dir, 'taskfold-anchor.js')).href)
      return requireFromAnchor(pkgName)
    } catch (err) { /* next anchor */ }
  }
  return undefined
}

let Config
try {
  const z = requireHostPackage('@deepseek-ai/schemastery')
  if (z !== undefined && typeof z.object === 'function' && typeof z.number === 'function') {
    Config = z.object({
      minSpanTokens: z.number().step(1).min(0).max(MIN_SPAN_TOKENS_MAX).default(DEFAULT_MIN_SPAN_TOKENS).volatile()
        .description('Fold floor (issue #2): the minimum number of estimated tokens a closed task\'s span must carry before a summarization call is billed for it. The count is a CJK-aware heuristic over the span\'s message text, taken before any model call. Spans below the floor close unfolded — their original content stays on the surface. Default 2000: below it a summary\'s fixed overhead outweighs the context saved (docs/fold-floor.md). 0 folds everything (legacy behavior).'),
      showTaskBar: z.boolean().default(true).volatile()
        .description('Show the task-stack dock beside the conversation input. The dock lists the session\'s named tasks and their fold state; hiding it does not affect folding itself. Default true.')
    })
  }
} catch (err) { Config = undefined }

/**
 * Wire-view factory for the taskMarks projection: below-floor settles are
 * PRUNED, not labeled. A span the drain settled under the fold floor will
 * never fold — its close is final and its chip carries nothing worth a
 * dock row — so the view drops those pendingArchives rows from the wire
 * value entirely. The RAW projection state keeps them (the drain re-settles
 * them after every restart; archivesOf reads the state, not this view).
 * Reference-stable — the change feed's Object.is gate must not fire on
 * unrelated commits — unless at least one row is pruned, in which case it
 * returns a shallow copy with those rows removed. Memoized on the state
 * reference AND the registry version, so a settle that lands between commits
 * (no new state object) still re-prunes on the next view computation — which
 * the settle-aware apply wrapper below guarantees happens.
 * Restart semantics: the registry is empty until the drain's first pass
 * re-settles the small rows — one boundary of 'folding…' display at worst.
 */
export function pruneBelowFloorView(belowFloorKeys) {
  let lastState = undefined
  let lastVersion = -1
  let lastOut = undefined
  return (state) => {
    if (state === null || typeof state !== 'object') return state
    const archives = Array.isArray(state.pendingArchives) ? state.pendingArchives : null
    if (archives === null || archives.length === 0 || belowFloorKeys.size === 0) return state
    if (state === lastState && belowFloorKeys.version === lastVersion) return lastOut
    const kept = archives.filter((a) => !(a !== null && typeof a === 'object' && belowFloorKeys.has(pendingArchiveKey(a))))
    lastState = state
    lastVersion = belowFloorKeys.version
    lastOut = kept.length === archives.length ? state : { ...state, pendingArchives: kept }
    return lastOut
  }
}

/**
 * Settle-aware apply wrapper for the taskMarks projection. The projection
 * registry re-runs a wire view (and pushes the result to clients) only when
 * apply produced a NEW state reference — a below-floor settle mutates
 * nothing in the event log, so without help the pruned view would sit
 * unpushed until the next task-mark event. The wrapper watches the drain's
 * registry `version` (bumped on every settle) and returns a
 * content-identical shallow copy on the FIRST event after a bump: exactly
 * one extra state-reference move per mutation, which re-runs the view and
 * ships the pruned row. Replay-safe — the clone
 * changes object identity only, never derived content.
 */
export function makeSettleAwareApply(belowFloorKeys) {
  let seen = belowFloorKeys.version
  return (state, event) => {
    const next = applyTaskMarks(state, event)
    if (belowFloorKeys.version !== seen) {
      seen = belowFloorKeys.version
      if (next !== null && typeof next === 'object') return { ...next }
    }
    return next
  }
}

export default {
  // The Config schema must ride ON the plugin object itself: the loader's
  // unwrapExports() keeps only exports.default, so a named `export { Config }`
  // never reaches runtime.Config and the Settings form never appears.
  Config,
  name: 'compact-region',
  // NOTE: 'compaction' is deliberately NOT injected. The engine is ALWAYS
  // the plugin's own ScopedEngine instance (built lazily by fold-engine.mjs
  // on first use) — never a realm-registered ctx.compaction, which belongs to
  // AUTO compaction and runs the stock checkpoint instruction. Direct
  // property access on an undeclared service throws in cordis ("cannot get
  // property without inject"), so nothing here touches ctx.compaction.
  // All dependencies (tools, systemPrompt, sessionProjections, and — via the
  // engine's own ctx use — tokenMeter/llm) are host-plane services.
  inject: ['tools', 'systemPrompt', 'sessionProjections', 'tokenMeter', 'llm'],
  apply(ctx, config) {
    // Detailed stock checkpoints: swap the host's terse instruction for
    // DETAILED_CHECKPOINT_INSTRUCTION at the one seam every compaction call
    // crosses. Discriminator (from the host's summarizeWithLlm): purpose
    // 'compaction' + the final instruction message carries
    // source.plugin === 'dsh-compaction-basic'. Our own fold calls use the
    // same purpose but their instruction message has NO source, so folds are
    // untouched. Idempotent via marker; any failure leaves the call original.
    try {
      const llm = ctx.llm
      if (llm !== null && typeof llm === 'object' && typeof llm.stream === 'function' && llm.__taskfoldDetailedCheckpoints !== true) {
        const origStream = llm.stream.bind(llm)
        let swapEngagedLogged = false
        llm.__taskfoldDetailedCheckpoints = true
        llm.stream = (options) => {
          let rewritten = options
          try {
            if (options !== null && typeof options === 'object' && options.purpose === 'compaction' && Array.isArray(options.messages) && options.messages.length > 0) {
              const last = options.messages[options.messages.length - 1]
              const src = last !== null && typeof last === 'object' && last.source !== null && typeof last.source === 'object' ? last.source : undefined
              if (src !== undefined && src.kind === 'plugin' && src.plugin === 'dsh-compaction-basic') {
                // One line per process, on the FIRST matching call: proves
                // the discriminator still matches the host's compaction
                // stream. Silence after a host upgrade would mean the swap
                // quietly stopped applying (fail-open) — this makes the
                // drift visible instead of undetectable.
                if (!swapEngagedLogged) {
                  swapEngagedLogged = true
                  console.error('[taskfold] detailed-checkpoint instruction swap engaged (matched a dsh-compaction-basic compaction stream)')
                }
                rewritten = {
                  ...options,
                  messages: [...options.messages.slice(0, -1), {
                    ...last,
                    content: [{ type: 'text', text: DETAILED_CHECKPOINT_INSTRUCTION }]
                  }]
                }
              }
            }
          } catch (err) { /* stream the original call untouched */ }
          return origStream(rewritten)
        }
      }
    } catch (err) { /* llm service absent: nothing to detail */ }
    // Native-event derivation folds into this projection; the registration's
    // disposer rides the plugin fiber, so it unloads with us. stateVersion 11
    // (0.35.1) discards every persisted checkpoint row: rows written by the
    // resume bug carry unconsumed begin/end intents for tasks that closed
    // LONG ago (the dock drew them as eternal 'opening…'/'closing…' rows),
    // and their `ver` still matches — only a version bump forces the clean
    // refold that purges them. It also retires the v9→v10 concern below:
    // v9 keyed archive closure on the BEGIN anchor — a witness a deferred
    // fold never shadows, so terminated sessions could persist 'folding…'
    // rows forever. The host treats a version mismatch as a full replay, not
    // a load failure, so the replay converges those rows through the
    // close-result witness.
    // Below-floor settle registry, shared with the drain (writes) and the
    // wire view below (reads): rows the drain settled below the fold floor
    // are terminal — they never fold, so the projection keeps them listed
    // in pendingArchives forever (no compaction event ever shadows their
    // close result) and the dock would misreport them as perpetually
    // 'folding…'. The view PRUNES exactly those rows from the wire value
    // (the raw state keeps them — the drain re-settles them after every
    // restart). `version` is bumped by the drain on every mutation; the
    // settle-aware apply wrapper below turns that bump into a state-reference
    // move so the pruned view is recomputed and pushed without waiting for
    // the next task-mark event.
    const belowFloorKeys = new Set()
    belowFloorKeys.version = 0
    ctx.sessionProjections.register({
      key: TASK_MARKS_KEY,
      stateSchema: taskMarksStateSchema,
      init: () => null,
      apply: makeSettleAwareApply(belowFloorKeys),
      stateVersion: 11,
      wire: {
        viewSchema: taskMarksStateSchema,
        view: pruneBelowFloorView(belowFloorKeys)
      }
    })

    // Per-session closing declaration: the drain stashes the task name it is
    // closing, keyed by sessionId, so concurrent folds in OTHER sessions of
    // the same process (the engine is a singleton) never cross-contaminate
    // each other's summary titles. Shared by the engine (reads) and the
    // drain (writes); see fold-engine.mjs.
    const closingTasks = new Map()
    const engineFor = createFoldEngine(ctx, closingTasks)
    // Fold floor: resolved per drain pass from the volatile config ref, so
    // a Settings-page edit applies at the next step boundary, no restart.
    const drain = createArchiveDrain({
      ctx,
      engineFor,
      closingTasks,
      settings: () => ({ minSpanTokens: foldFloorFromConfig(config) }),
      belowFloorKeys
    })
    // Per-session latch for the standalone lifecycle hint: the exact text of
    // the last hint published to that session. In-memory on purpose — a
    // restart loses it and may republish one hint that is still live, which is
    // cheaper than a history scan that cannot tell "still live" from "spent".
    const lifecycleLatch = new Map()

    try {
      // WATERFALL contract: a pre-step listener receives ({ agent, signal },
      // next) and MUST return next() — returning undefined makes the host
      // crash reading decision.kind, and skipping next() wedges the step.
      // The engine's own AUTO compaction registers the same way and awaits
      // its work inside the hook; guardedSignal (fold-drain.mjs) bounds our
      // fold attempts.
      ctx.on('agent/pre-step', async (payload, next) => {
        const pass = typeof next === 'function' ? () => next() : () => undefined
        try {
          const agent = payload !== null && typeof payload === 'object' ? payload.agent : undefined
          if (agent !== undefined) {
            const signal = payload !== null && typeof payload === 'object' && payload.signal !== undefined ? payload.signal : undefined
            await drain.processDeferredArchives(agent, signal)
          }
        } catch (err) {
          // retried at the next pre-step; never wedge the step
        }
        const decision = await pass()
        // Standalone lifecycle hint: the agent loop appends every message in
        // decision.messages as a persistent user/message — the same channel
        // the host's own skill catalog uses. A hint is an EVENT: it publishes
        // only when its text differs from the live one, the latch resets the
        // moment the condition clears (so the same hint can reappear later),
        // and nothing at all is published when no condition holds. An
        // unconditional push would append one message per step. A broken hint
        // must never wedge the step.
        try {
          const agent = payload !== null && typeof payload === 'object' ? payload.agent : undefined
          if (agent !== undefined && decision !== null && typeof decision === 'object' && Array.isArray(decision.messages)) {
            const session = agent.session
            const latchKey = session !== null && typeof session === 'object' ? session.id : undefined
            if (latchKey !== undefined) {
              const lines = lifecycleLines({ agent })
              if (lines !== null) {
                const plan = planLifecycleInjection(renderLifecycleBody(lines), lifecycleLatch.get(latchKey))
                if (plan.last === null) lifecycleLatch.delete(latchKey)
                else {
                  lifecycleLatch.set(latchKey, plan.last)
                  // Bound the latch: a long-lived host serves one session per
                  // subagent and this map only ever grew. Evicting an old
                  // session costs at most one re-published hint — the latch is
                  // an anti-repeat cache, never state.
                  if (lifecycleLatch.size > 200) {
                    for (const key of lifecycleLatch.keys()) {
                      if (key !== latchKey) { lifecycleLatch.delete(key); break }
                    }
                  }
                }
                if (plan.publish) {
                  return { ...decision, messages: [...decision.messages, lifecycleMessage(plan.last)] }
                }
              }
            }
          }
        } catch (err) {
          // a broken hint must never wedge the step
        }
        return decision
      })
    } catch (err) {
      // Hook unavailable in this host build: queued archives stay unfolded
      // until a manual supplement; closes still work.
    }

    try {
      // SERIAL contract (NO next()): the host dispatches 'agent/turn-stopping'
      // with { agent, turn, signal } after the turn's final step commits and
      // before the agent idles — the moment the provider prefix cache is
      // hottest. Draining HERE folds turn-final deliverables while the cache
      // is warm, instead of at the NEXT turn's pre-step after the user's
      // idle gap (measured: both all-miss folds billed ~82% fresh input).
      // Same-session concurrency with the pre-step drain is structurally
      // excluded (both dispatch inside the host's single step loop); the
      // drain's running guard is PER-SESSION (0.35.0), so folds in other
      // sessions of this process run concurrently instead of serializing
      // behind whoever was mid-flight (the old process-wide guard starved
      // settled subagents behind a sibling's fold window). Aborted/errored
      // turns never dispatch this hook — the pre-step drain above remains
      // the fallback.
      ctx.on('agent/turn-stopping', async (payload) => {
        try {
          const agent = payload !== null && typeof payload === 'object' ? payload.agent : undefined
          if (agent !== undefined) {
            const signal = payload !== null && typeof payload === 'object' && payload.signal !== undefined ? payload.signal : undefined
            await drain.processDeferredArchives(agent, signal)
          }
        } catch (err) {
          // retried at the next pre-step; never wedge the turn end
        }
      })
    } catch (err) {
      // Hook unavailable in older hosts: behavior degrades to the
      // pre-step-only drain (the previous semantics).
    }

    const taskBegin = {
      name: 'task_begin',
      description: 'Begin a NAMED task. The name is the identity; when the work is done, one task_end({ name }) call ends it and queues archival — the span folds automatically at the next step boundary after the assistant message that follows your task_end result (any content opens the gate — make that message your report). A name already open is rejected; names must not contain " —" (a space followed by an em dash). Tasks can nest: task_begin while a task is open opens a subtask (innermost closes first). The call message (with its opening reasoning) stays live in the transcript as the task\'s bookmark; the eventual fold\'s archive starts just after the last result of this message (the \'Task begun\' result plus any partner results) — all of them stay live beside the call. This MUST be the only task-mark call in its message: a message that also carries another task_begin/task_end call is rejected at execute time — re-issue it in the next message, where "only" constrains task-mark calls alone (text, reasoning and other tools may sit beside it). To continue straight after closing a task, put this task_begin IN THE SAME MESSAGE as the report on the task you just closed — a text-only message ends the turn.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short task name (identity key; recommended ≤80 chars).' }
        },
        required: ['name']
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(args, value) {
          if (value.ok !== true) return [{ type: 'text', text: 'task_begin failed: ' + String(value.error === undefined ? 'unknown error' : value.error) }]
          const openList = value.openNames.length <= 1 ? '' : ': ' + value.openNames.join(', ')
          // depth ≥ 2 means THIS begin opened a nested mark — prime the
          // hierarchy habit exactly there: the result is the one channel
          // guaranteed to be read at the moment a big task gains parts.
          const nest = value.depth >= 2
            ? ' Nested mark: close it before its parent; wrap distinct parts of the remaining work as further nested marks — each part folds at its own close.'
            : ''
          return [{ type: 'text', text: 'Task begun: ' + value.name + ' — ' + value.openNames.length + ' open' + openList + '.' + nest }]
        }
      },
      async execute(args, exec) {
        const agent = exec.agent
        if (agent === undefined) return { ok: false, category: 'invalid', error: 'task_begin requires an agent context' }
        const name = args !== null && typeof args === 'object' ? normalizeName(args.name) : ''
        if (name.length === 0) return { ok: false, category: 'invalid', error: 'task_begin requires a non-empty `name` (the identity key task_end will end by)' }
        if (!validTaskName(name)) return { ok: false, category: 'invalid', error: 'task names must not contain " —" (the result-text delimiter); pick a name without it' }
        const session = agent.session
        const open = marksOf(ctx, session)
        if (open.some((m) => m.name === name)) {
          return { ok: false, category: 'invalid', error: 'a task named "' + name + '" is already open; names are identity keys — close it first or pick another name' }
        }
        // CONTRACT: the mark lands on the LAST assistant message on the
        // surface, which is the assistant message of this very step. That
        // message may carry text and non-mark tools beside the call — the
        // "only" rule constrains task-mark calls, nothing else — so a report
        // for the task just closed can share this message and keep the turn
        // alive. The projection derives
        // the push from that event + the success text; this check only
        // verifies an assistant message exists to anchor on (lastSurface-
        // AssistantSeq walks the surface from the end — O(surface), no
        // full-log scan, no materialized event map).
        if (lastSurfaceAssistantSeq(session) === null) {
          return { ok: false, category: 'invalid', error: 'no assistant message found on the surface' }
        }
        // Sibling guard: this call must be the ONLY task-mark call in its
        // carrying message. A partner task_end here puts this mark's anchor
        // message inside the partner's fold span (the PARALLEL-END relay):
        // the fold would swallow the anchor and this task would close with
        // no archive of its own. Enforced at execute time — the host has no
        // pre-execution tool-call interception — so the model re-issues the
        // call alone in its next message.
        const siblings = siblingTaskMarkCalls(session, 'task_begin')
        if (siblings !== null && siblings.length > 0) {
          return { ok: false, category: 'invalid', error: 'this message also carries ' + siblings.join(', ') + ' — task_begin must be the ONLY task-mark call in its message, else the sibling\'s closing fold swallows this mark\'s anchor message and this task loses its own archive. Re-issue task_begin in your next message, in the same message as the report on the task you just closed ("only" constrains task-mark calls — text is fine beside it).' }
        }
        // No event appended: the projection derives the named push from this
        // step's assistant/message + the success text about to be returned.
        const openNames = open.map((m) => m.name).concat([name])
        const depth = openNames.length
        return { ok: true, name, depth, openNames }
      }
    }

    const taskEnd = {
      name: 'task_end',
      description: 'End the INNERMOST open task by name: it closes the task and QUEUES archival — the span folds AUTOMATICALLY at the next step boundary after the FIRST assistant message that follows the task_end result (possibly mid-turn; any content opens the gate — text, tool calls, reasoning). So: finish the work, call task_end, then deliver the report in the same turn with full context — the report is text that lands AFTER the task_end result (text in the same assistant message as the call arrives before the result, too early); make the next message the report, because the fold fires at the next step boundary after it lands — and if this turn still has work, that report message MUST also carry a tool call (typically the successor task_begin) — a text-only message ends the turn. LIFO: newer open tasks block older ones; a blocked or unknown name fails and changes nothing (close the newer task first). Too-small spans close without folding; failed auto-folds retry automatically with backoff (a task-lifecycle notice names any that keep failing). Failure outcomes are explained in the result; follow it. This MUST be the only task-mark call in its message — a task_end relayed into the next task\'s task_begin within one message is rejected at execute time (both calls fail, so re-issue both); re-issue task_end alone (text beside it is fine — "only" constrains task-mark calls), then send the next task_begin in the following message. To keep working after this close, that following message is the report AND the successor task_begin TOGETHER — a text-only message is a turn END, and the work you just promised never starts.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name of the open task to end (same string given to its task_begin).' }
        },
        required: ['name']
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(args, value) {
          if (value.ok !== true) {
            const category = value.category === undefined ? 'invalid' : String(value.category)
            const error = value.error === undefined ? 'unknown error' : String(value.error)
            const hint = value.hint === undefined ? '' : '\n' + String(value.hint)
            return [{ type: 'text', text: 'task_end failed (' + category + '): ' + error + hint }]
          }
          const open = value.remainingNames.length > 0 ? value.remainingNames.length + ' open: ' + value.remainingNames.join(', ') : 'all closed'
          if (value.unfolded !== undefined) {
            const why = value.unfolded === 'engine'
              ? 'Engine unavailable; task closed without folding.'
              : 'Mark no longer on the surface; task closed without folding.'
            return [{ type: 'text', text: 'Task ended: ' + value.name + ' — ' + open + '. ' + why }]
          }
          // The 'Task ended: ' prefix is LOAD-BEARING — the reducer keys the
          // mark pop AND the pendingArchive registration on it ('Task folded: '
          // from legacy logs still matches).
          return [{ type: 'text', text: 'Task ended: ' + value.name + ' — ' + open + '. Archival queued — the span folds automatically at the step boundary after your NEXT message; deliver your report in that next message, with full context. If this turn still has work, that report message must also carry a tool call (typically the successor task_begin): a message with no tool call at all ends the turn, and the work you just promised never starts.' }]
        }
      },
      async execute(args, exec) {
        const agent = exec.agent
        if (agent === undefined) return { ok: false, category: 'invalid', error: 'task_end requires an agent context' }
        const name = args !== null && typeof args === 'object' ? normalizeName(args.name) : ''
        if (name.length === 0) return { ok: false, category: 'invalid', error: 'task_end requires a non-empty `name`' }
        const session = agent.session
        // Sibling guard (mirror of task_begin's): this close must be the
        // ONLY task-mark call in its carrying message. A batched successor
        // task_begin would have its anchor message swallowed by THIS task's
        // fold (deferredArchivePlan extends over the partner results —
        // correct for the fold, fatal for the successor's own archive).
        // Rejecting here keeps the close itself on a clean boundary; the
        // model re-issues task_end alone, then the begin in the following
        // message, together with the report (a text-only message would end
        // the turn).
        const closeSiblings = siblingTaskMarkCalls(session, 'task_end')
        if (closeSiblings !== null && closeSiblings.length > 0) {
          return {
            ok: false,
            category: 'invalid',
            error: 'this message also carries ' + closeSiblings.join(', ') + ' — task_end must be the ONLY task-mark call in its message so the archive span gets this message\'s results to itself.',
            hint: 'Batching task_end with the successor\'s task_begin forces this task\'s fold to swallow the successor\'s anchor message (it loses its own archive). Send task_end alone (text beside it is fine), then the next task_begin in the following message — together with your report.'
          }
        }
        const marks = marksOf(ctx, session)
        const openNamesNow = marks.map((m) => m.name)
        if (!openNamesNow.some((n) => n === name)) {
          const entries = archivesOf(ctx, session)
          const queuedNames = entries.filter((p) => !drain.isSettledArchive(session, p.seq)).map((p) => p.name)
          const lists = 'open: ' + (openNamesNow.length > 0 ? openNamesNow.join(', ') : '(none)')
            + (queuedNames.length > 0 ? '; queued for archival (folds automatically): ' + queuedNames.join(', ') : '')
          return { ok: false, category: 'invalid', error: 'no open task named "' + name + '". ' + lists }
        }
        // ── Standard close: LIFO check, then queue the archive.
        const target = closeTarget(marks, name)
        if (target.status === 'lifo') {
          return { ok: false, category: 'invalid', error: 'task "' + name + '" is not the innermost open task; close the newer task(s) first: ' + target.blocking.join(', ') }
        }
        // remaining = the stack minus the matched mark — mirrors the pop.
        const remainingNames = []
        let skipped = false
        for (let i = marks.length - 1; i >= 0; i -= 1) {
          if (!skipped && marks[i].name === name) { skipped = true; continue }
          remainingNames.unshift(marks[i].name)
        }
        if (session.surface.nodes.indexOf(target.mark.seq) === -1) {
          // Degraded close: anchor shadowed (AUTO compaction took the span);
          // the task ends unfolded and NOTHING is queued (a queued archive
          // with a shadowed anchor would be dropped by the reducer anyway).
          return { ok: true, name, remainingNames, unfolded: 'anchor' }
        }
        // Success: the rendered 'Task ended: ' text is the ONLY event the
        // reducer needs — it pops the mark and registers the pendingArchive.
        return { ok: true, name, remainingNames, queued: true }
      }
    }

    ctx.tools.register(taskBegin)
    ctx.tools.register(taskEnd)

    ctx.systemPrompt.section({
      name: 'task-marker-compaction',
      order: 650,
      text: 'MANDATORY task lifecycle discipline: every discrete task MUST be wrapped in task marks. A task is work that produces a verifiable outcome (a fix, a module, an analysis, a delegated review); a single read/grep/probe is a step, not a task — never open a mark for a step, and when in doubt, treat the work as a task. Before a task, call task_begin({ name }). ONE task-mark call per message at most — a limit on task-mark CALLS alone: text, reasoning, and any other (non-task-mark) tool call may share the message with the single mark. What execute time rejects is ANY task-mark call whose message carries another (a task_end + task_begin relay: BOTH calls fail — re-issue each in its own message); names can also fail for other reasons (blocked, unknown, duplicate), and each result names its exact cause. Hand off by putting the successor task_begin in the FOLLOWING message, TOGETHER with the report — never as a text-only report: that ends the turn. The moment its work is done, call task_end({ name }): it ends the task and QUEUES archival — then deliver the report in your NEXT message (the first after the task_end result; text in the task_end message itself arrives before the result, too early), written with FULL context while every detail is still on the surface. The fold itself happens AUTOMATICALLY at the next step boundary after that message lands — possibly mid-turn — so make that message the report. TURN-ENDING RULE: an assistant message with NO tool call ends your step and, absent host-injected notices you cannot rely on, the turn — a text-only report is a STOP, never a pause. So put the report in the same message as whatever comes next: if the turn still has work, that message must carry a tool call (typically the successor task_begin beside the report); if you are done or waiting on the user, a text-only report is exactly right. The mark is a bookmark, not a deadline: while waiting on a background job or user reply, leave it open and do other work; fold when the wait resolves. Multi-part work MUST be split into NESTED SUBTASKS: while the outer task stays open, task_begin each distinct part as you start it and task_end it the moment that part\'s outcome is verifiable — innermost closes first, each part folds at its own close. A long detour or dead-end exploration inside a task is one such part. Shape example (no message carries TWO task-mark calls; text never blocks a mark): task_begin "review week 47" → task_begin "review PR #98" … task_end "review PR #98" → [report on PR #98 + task_begin "review PR #99"] … task_end "review PR #99" → [report on PR #99 + task_end "review week 47"] → report on week 47. Folded details are never lost: each fold summary ends with a Fold archive section (fold number, artifact path, and a compact archive footer carrying the span-preview head and tail with true line numbers); list_folds → fold_recall({ fold }) re-renders the full index, then read/grep the artifact. Recall on demand — when a summary\'s anchors fail to answer a concrete question the work or the report needs, or when a new task genuinely depends on an earlier folded task\'s details; never guess, never ask the user\'s permission to recall, never recall without such a need; never restate a folded span or estimate message positions or line numbers from memory — copy them from a visible index or quote a fragment. A fold\'s archive spans from just after the last result of the task_begin message (the \'Task begun\' result plus any parallel partner results) through the last result of the task_end message, so the begin call, its opening reasoning, and those results stay live. Lifecycle notices arrive as injected messages (nudges, task-stack snapshots) — treat them as directives and act on them.'
    })

    // HOLD semantics for lifecycle nudges: a notice renders for as long as
    // its condition holds — no fire/cooldown cycle, so a nudge never "fires
    // then stops nagging". The published text is compared VERBATIM by
    // lifecycle-injection.mjs, so it must stay BYTE-STABLE (wording past a
    // threshold is deliberately number-free: "20+ rounds", never "~23"), and
    // every condition clearing publishes the empty state exactly once.
    // Returns the live lines, or null when no session is available (publish
    // nothing rather than an empty state).
    const lifecycleLines = (context) => {
      // Per-session state: the context callback receives { agent, scope,
      // signal }, so marks and todos are keyed to THIS session.
      const agent = context !== null && typeof context === 'object' ? context.agent : undefined
      if (agent === undefined) return null
      let session
      try { session = agent.session } catch (err) { session = undefined }
      if (session === null || session === undefined) return null
      // ONE event-log snapshot per render, shared by every nudge predicate
      // below — snapshotting is O(n) in the log, and this callback runs on
      // every request of exactly the long sessions taskfold exists for.
      const events = sessionEvents(session)
      const lines = []
      // Only NAMED marks count: nameless entries are unclosable legacy
      // phantoms (self-healed at projection load, but guard here too).
      const marks = marksOf(ctx, session).filter((m) => m.name !== '')
      const ownDepth = marks.length
      // Deliberately NO standing "Open task marks: N" line: depth rides in
      // every task_begin/task_end result text, so echoing it in a snapshot
      // would re-inject after every lifecycle call for no new information.
      // This context exists ONLY for cross-state signals the model cannot
      // read from any single message.

      // ── Nudge 1: no task open but work is happening ─────────────────
      // Renders for as long as the model keeps making non-task tool calls
      // with no open task; retracts the moment a task begins (or the work
      // stops). ≥3 work calls in the last 10 assistant messages, with a
      // 3-round grace after a task close so a fresh close is not
      // immediately answered with "begin another".
      if (ownDepth === 0 && recentWorkCallCount(events) >= 3 && roundsSinceFoldOutcome(events) >= 3) {
        lines.push('Task lifecycle: no open task during tool work — call task_begin({ name: "…" }) if this is a discrete task.')
      }

      // ── Nudge 2: the INNERMOST task left open for a long time ──────
      // The target is the innermost open mark (the one being worked on):
      // an outer mark with an open child cannot be closed (LIFO) and is not
      // idle, so nagging it is noise. Age is measured from the mark's
      // activity anchor, which nested begins/ends advance — a parent that
      // just gained a child is therefore NOT flagged (live bug: parent
      // 'add cache-hit …' was flagged 20+ in the snapshot right after its
      // child 'wire verify:cache …' began). Wording is byte-stable WITHIN
      // each escalation bucket (20+/50+/100+ rounds) — the injection
      // latch fires one fresh event per bucket crossing instead of a
      // single one-shot alarm — and it always offers both exits.
      if (ownDepth > 0) {
        const target = innermostMark(marks)
        const targetAge = taskAgeRounds(events, target)
        if (target !== null && targetAge >= CLOSE_PRESSURE_MIN_ROUNDS) {
          lines.push(closePressureLine(target.name, targetAge))
        }
        // ── Nudge 3: decomposition while a big task is actively worked ──
        // Covers the GAP between "just began" (nothing to decompose) and
        // Nudge 2's close pressure (20+): the innermost mark aged 8–19
        // rounds with ongoing work gets a HOLD hint to wrap remaining
        // distinct parts as nested subtasks — without it, the only live
        // signal after the first task_begin is close pressure, and long
        // jobs run as one flat mark (observed in the wild: a 14-minute
        // 4-PR review folded as a single blob). Retracts when the age
        // leaves the window or the work stops. Byte-stable past threshold.
        if (target !== null && shouldSuggestDecomposition(ownDepth, targetAge, recentWorkCallCount(events))) {
          lines.push(decomposeHintLine(target.name))
        }
      }

      // ── Auto-fold failure warning (HOLD) ─────────────────────────────
      // Renders for as long as a queued archive's auto-fold keeps failing
      // (engine busy etc.); retracts when the fold finally commits or the
      // entry settles. The bucket now carries the classified error's own
      // message plus the attempt count (fold-drain.mjs), so the line names
      // the actual cause instead of a bare category; the text changes only
      // when the attempt or the cause does, and the latch re-publishes
      // exactly then.
      const fails = drain.autoFoldFailures.get(session.id)
      if (fails !== undefined) {
        // Render only names that STILL have a queued archive row: a row
        // can leave the projection through the reducer itself (replay,
        // anchor drop) without the drain's settle path clearing the
        // bucket, and a stale entry would then warn forever. Filter at
        // render; the bucket itself stays the drain's memory.
        const queuedNames = new Set(archivesOf(ctx, session).map((p) => p.name))
        for (const [failName, bucket] of fails) {
          if (!queuedNames.has(failName)) continue
          lines.push('Task lifecycle: auto-fold for "' + failName.replace(/"/g, "'") + '" is failing (' + bucket + ') — it retries automatically with backoff; no action needed.')
        }
      }

      // ── Todo bridge: transient change report ──────────────────────
      // Renders ONLY on the request right after the model called
      // todo_write (detected statelessly in the most recent assistant
      // message). On the standalone channel that is TWO publishes — the
      // line, then the next state (empty or the remaining notices) — which
      // is the same number of messages the snapshot engine emitted before.
      // The line reports the change plus the open task roster; whether to
      // task_begin or task_end is the MODEL's call — a status report,
      // not a conditional nag.
      if (lastAssistantHasTodoWrite(events)) {
        lines.push(todoBridgeLine(marks.map((m) => m.name)))
      }

      // ── Full stack snapshot, appended to any live hint ───────────────
      // The user asked the lifecycle event to carry the WHOLE stack, not just
      // the nagged task. Emitted ONLY alongside a live hint — never as a
      // standing state line, which would re-inject after every
      // task_begin/task_end (the reason this context deliberately has no
      // "open marks: N" line above). It is number-free past the stack SHAPE,
      // so the text stays byte-stable while the stack is unchanged and the
      // latch (planLifecycleInjection) re-publishes only when the stack
      // really moved — which is exactly when the hint's target may have too.
      if (lines.length > 0) {
        // Below-floor rows are counted apart from 'folding': they are
        // terminal (closed, never folding), so the hint must not claim a
        // fold is in flight for them. Freshly measured — unlike the drain's
        // in-memory registry this is restart-accurate immediately.
        const queued = archivesOf(ctx, session)
        const belowFloor = belowFloorArchiveKeys(ctx, session, foldFloorFromConfig(config))
        // Permanent skips (0.37.5) join the fresh measurement: a row the
        // session's ledger already judged below the floor never folds —
        // even after an edit lowered the bound below its span — so it must
        // not be counted as folding either. Intersected with the queued
        // rows so ledger leftovers (a row that left the projection through
        // replay) never skew the count.
        const queuedKeys = new Set(queued.map((p) => pendingArchiveKey(p)))
        for (const skipKey of drain.permanentSkips(session)) {
          if (queuedKeys.has(skipKey)) belowFloor.add(skipKey)
        }
        lines.push(taskStackLine(marks, queued, pendingOf(ctx, session), belowFloor.size))
      }
      return lines
    }
  }
}
