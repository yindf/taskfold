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
 *   lifecycle-nudges.mjs pure nudge predicates over an events snapshot
 *   lifecycle-injection.mjs the event-only lifecycle hint channel
 */
import { sessionEvents } from './events.mjs'
import { TASK_MARKS_KEY, taskMarksStateSchema, applyTaskMarks, validTaskName, closeTarget, normalizeName, marksOf, archivesOf, lastSurfaceAssistantSeq } from './task-marks.mjs'
import { DETAILED_CHECKPOINT_INSTRUCTION } from './fold-instruction.mjs'
import { createFoldEngine } from './fold-engine.mjs'
import { createArchiveDrain } from './fold-drain.mjs'
import { todoBridgeLine, recentWorkCallCount, lastAssistantHasTodoWrite, roundsSinceFoldOutcome, shouldSuggestDecomposition, decomposeHintLine, innermostMark, taskAgeRounds, closePressureLine, CLOSE_PRESSURE_MIN_ROUNDS } from './lifecycle-nudges.mjs'
import { lifecycleMessage, planLifecycleInjection, renderLifecycleBody } from './lifecycle-injection.mjs'

export default {
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
  apply(ctx) {
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
    // disposer rides the plugin fiber, so it unloads with us. stateVersion 9
    // discards persisted rows from earlier reducer generations (v8 predates
    // pendingArchives; the host treats a version mismatch as a full replay,
    // not a load failure — old logs replay byte-identically through v9).
    ctx.sessionProjections.register({
      key: TASK_MARKS_KEY,
      stateSchema: taskMarksStateSchema,
      init: () => null,
      apply: applyTaskMarks,
      stateVersion: 9
    })

    // Per-session closing declaration: the drain stashes the task name it is
    // closing, keyed by sessionId, so concurrent folds in OTHER sessions of
    // the same process (the engine is a singleton) never cross-contaminate
    // each other's summary titles. Shared by the engine (reads) and the
    // drain (writes); see fold-engine.mjs.
    const closingTasks = new Map()
    const engineFor = createFoldEngine(ctx, closingTasks)
    const drain = createArchiveDrain({ ctx, engineFor, closingTasks })
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
      // drain's own running guard covers cross-session reentry (subagent
      // sessions share this process). Aborted/errored turns never dispatch
      // this hook — the pre-step drain above remains the fallback.
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
      description: 'Begin a NAMED task. The name is the identity; when the work is done, one task_end({ name }) call ends it and queues archival — the span folds automatically at the next step boundary after the assistant message that follows your task_end result (any content opens the gate — make it your report). A name already open is rejected; names must not contain " —" (a space followed by an em dash). Tasks can nest: task_begin while a task is open opens a subtask (innermost closes first). The call message (with its opening reasoning) stays live in the transcript as the task\'s bookmark; the eventual fold\'s archive starts just after the \'Task begun\' result — the result itself stays live beside the call. Call alone in a step.',
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
        // surface, which — because task_begin is called alone in a step — is
        // the assistant message of this very step. The projection derives
        // the push from that event + the success text; this check only
        // verifies an assistant message exists to anchor on (lastSurface-
        // AssistantSeq walks the surface from the end — O(surface), no
        // full-log scan, no materialized event map).
        if (lastSurfaceAssistantSeq(session) === null) {
          return { ok: false, category: 'invalid', error: 'no assistant message found on the surface' }
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
      description: 'End the INNERMOST open task by name: it closes the task and QUEUES archival — the span folds AUTOMATICALLY at the next step boundary after the FIRST assistant message that follows the task_end result (possibly mid-turn; any content opens the gate — text, tool calls, reasoning). So: finish the work, call task_end, then deliver the report in the same turn with full context — the report is text that lands AFTER the task_end result (text in the same assistant message as the call arrives before the result, too early); make the next message the report, because the fold fires as soon as it lands. Folds are system-executed: the committed summary node ends with a Fold archive section (same format as the summary sections) carrying the fold number, the artifact path (JSONL, one message per line — the span runs from just after the \u0027Task begun\u0027 result through the \u0027Task ended\u0027 result, so the task_begin call, its opening reasoning, and the \u0027Task begun\u0027 result itself stay live in the transcript), and a compact archive footer (head and tail of the span preview with true line numbers); fold_recall({ fold }) re-renders the full index on demand. LIFO: newer open tasks block older ones; a blocked or unknown name fails and changes nothing (close the newer task first). Too-small spans close without folding; failed auto-folds retry at every step boundary. Failure outcomes are explained in the result; follow it. Call alone in a step.',
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
          return [{ type: 'text', text: 'Task ended: ' + value.name + ' — ' + open + '. Archival queued — the span folds automatically at your next step boundary; deliver your report now with full context.' }]
        }
      },
      async execute(args, exec) {
        const agent = exec.agent
        if (agent === undefined) return { ok: false, category: 'invalid', error: 'task_end requires an agent context' }
        const name = args !== null && typeof args === 'object' ? normalizeName(args.name) : ''
        if (name.length === 0) return { ok: false, category: 'invalid', error: 'task_end requires a non-empty `name`' }
        const session = agent.session
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
      text: 'MANDATORY task lifecycle discipline: every discrete task MUST be wrapped in task marks. A task is work that produces a verifiable outcome (a fix, a module, an analysis, a delegated review); a single read/grep/probe is a step, not a task — never open a mark for a step, and when in doubt, treat the work as a task (a small fold costs one summary node; an unfolded task costs a degraded context). Before a task, call task_begin({ name }) alone in a step. The moment its work is done, call task_end({ name }) alone in a step: it ends the task and QUEUES archival — then deliver the task\u0027s report or deliverable (to the user, or a subagent\u0027s report to its parent) in the SAME turn, as text AFTER the task_end result and written with FULL context while every detail is still on the surface. The fold itself happens AUTOMATICALLY at the next step boundary after the next assistant message lands — possibly mid-turn — so make that message your report: the details you deliver from are then never compressed. The mark is a bookmark, not a deadline: while waiting on a background job or user reply, leave it open and do other work; fold when the wait resolves. Multi-part work MUST be split into NESTED SUBTASKS: while the outer task stays open, task_begin each distinct part as you start it and task_end it the moment that part\u0027s outcome is verifiable — innermost closes first and each part folds at its own close, so the surface stays lean during long work instead of one giant fold at the end. A long detour or dead-end exploration inside a task is one such part. Shape example: task_begin "review week 47" → task_begin "review PR #98" … task_end "review PR #98" → task_begin "review PR #99" … task_end "review PR #99" → task_end "review week 47". Folded details are never lost: list_folds → fold_recall({ fold }) → read/grep the artifact. Recall on demand — when a summary\u0027s anchors fail to answer a concrete question the work or the report needs, or when a new task genuinely depends on an earlier folded task\u0027s details (recall that fold, list_folds → fold_recall → read/grep, before starting it); never guess, never ask the user\u0027s permission to recall, never recall without such a need. Never restate a folded span from memory; never track message positions yourself. Each fold summary node ends with a Fold archive section (fold number, message count, artifact path, and a compact archive footer — head and tail of the span preview with true line numbers; fold_recall({ fold }) re-renders the full index, and its line overload returns any numbered line verbatim). A fold\u0027s archive spans just after the \u0027Task begun\u0027 result through the \u0027Task ended\u0027 result, so the task_begin call, its opening reasoning, and the \u0027Task begun\u0027 result itself stay live. Runtime context carries lifecycle nudges — treat them as directives and act on them.'
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
        for (const [failName, bucket] of fails) {
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
      return lines
    }
  }
}
