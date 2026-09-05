/**
 * Compact Region tools — plugin-bundle form (installed via `dsh plugin add`
 * at the profile level; cordis.patch.yml mounts this file at the host plane,
 * so the tools land in the global registry for every session of every
 * preset). No realm/isolate-group assumptions are made.
 *
 * Registers the task-lifecycle tools plus prompt guidance:
 *   task_begin / task_end — named tasks; task_end pops the mark and QUEUES an
 *   archive (v9 full-deferred): the span folds AUTOMATICALLY at the next
 *   agent step boundary after the task's deliverable text lands.
 *
 * Zero module dependencies: every capability arrives through `inject`; the
 * compaction engine is self-hosted (fold-engine.mjs).
 *
 * Close semantics (v3): LIFO — only the INNERMOST open task can be closed;
 * closing a blocked or unknown name fails atomically. Degraded closes: a
 * shadowed anchor still CLOSES the task, unfolded. The deferredArchivePlan()
 * pure function (task-marks.mjs) carries the deliverable gate; the pre-step
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
 * Todo bridge: detects todo_write calls in the event log (stateless) and
 * renders ONE transient runtime-context line on the round right after the
 * model updated its todo list — it reports the change plus the open task
 * roster and asks the model to keep task marks in sync (task_begin for new
 * work, task_end for finished work). No conditional nagging: the decision
 * stays with the model. The todo tool itself is never wrapped or replaced.
 *
 * Module map (plain modules imported by this mounted row — they add no
 * bundle rows of their own, exactly like span-preview.mjs):
 *   events.mjs           shared native-event extractions (sessionEvents…)
 *   task-marks.mjs       the taskMarks projection + pure close/fold decisions
 *   fold-instruction.mjs the two swapped-in summarization instructions
 *   fold-engine.mjs      self-hosted ScopedEngine + lazy resolution
 *   fold-drain.mjs       the deliverable-gated pre-step auto-folder
 *   lifecycle-nudges.mjs pure nudge predicates over an events snapshot
 */
import { sessionEvents } from './events.mjs'
import { TASK_MARKS_KEY, taskMarksStateSchema, applyTaskMarks, validTaskName, closeTarget, normalizeName, marksOf, archivesOf, lastSurfaceAssistantSeq } from './task-marks.mjs'
import { DETAILED_CHECKPOINT_INSTRUCTION } from './fold-instruction.mjs'
import { createFoldEngine } from './fold-engine.mjs'
import { createArchiveDrain } from './fold-drain.mjs'
import { todoBridgeLine, recentWorkCallCount, lastAssistantHasTodoWrite, roundsSinceFoldOutcome, countAssistantSince, shouldSuggestDecomposition, decomposeHintLine } from './lifecycle-nudges.mjs'

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
        return pass()
      })
    } catch (err) {
      // Hook unavailable in this host build: queued archives stay unfolded
      // until a manual supplement; closes still work.
    }

    const taskBegin = {
      name: 'task_begin',
      description: 'Begin a NAMED task. The name is the identity; when the work is done, one task_end({ name }) call ends it and queues archival — the span folds automatically at the next step boundary after your deliverable. A name already open is rejected; names must not contain " —" (a space followed by an em dash). Tasks can nest: task_begin while a task is open opens a subtask (innermost closes first). The call message (with its opening reasoning) stays live in the transcript as the task\'s bookmark; the eventual fold\'s archive starts just after the \'Task begun\' result — the result itself stays live beside the call. Call alone in a step.',
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
      description: 'End the INNERMOST open task by name: it closes the task and QUEUES archival — the span folds AUTOMATICALLY at the next step boundary after the task\u0027s deliverable/report text lands (possibly mid-turn). So: finish the work, call task_end, then deliver the report in the same turn with full context — the report is text that lands AFTER the task_end result (text in the same assistant message as the call does not count as the deliverable); folding never precedes a deliverable. Folds are system-executed: the committed summary node ends with a Fold archive section (same format as the summary sections) carrying the fold number, the artifact path (JSONL, one message per line — the span runs from just after the \u0027Task begun\u0027 result through the \u0027Task ended\u0027 result, so the task_begin call, its opening reasoning, and the \u0027Task begun\u0027 result itself stay live in the transcript), and a complete span preview of the archived messages — one line per message, no elision (inline when the summary budget allows). LIFO: newer open tasks block older ones; a blocked or unknown name fails and changes nothing (close the newer task first). Too-small spans close without folding; failed auto-folds retry at every step boundary. Failure outcomes are explained in the result; follow it. Call alone in a step.',
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
      text: 'MANDATORY task lifecycle discipline: every discrete task MUST be wrapped in task marks. A task is work that produces a verifiable outcome (a fix, a module, an analysis, a delegated review); a single read/grep/probe is a step, not a task — never open a mark for a step, and when in doubt, treat the work as a task (a small fold costs one summary node; an unfolded task costs a degraded context). Before a task, call task_begin({ name }) alone in a step. The moment its work is done, call task_end({ name }) alone in a step: it ends the task and QUEUES archival — then deliver the task\u0027s report or deliverable (to the user, or a subagent\u0027s report to its parent) in the SAME turn, as text AFTER the task_end result and written with FULL context while every detail is still on the surface. The fold itself happens AUTOMATICALLY at the next step boundary after your deliverable lands — possibly mid-turn — so folding never precedes a deliverable and the details you deliver from are never compressed. The mark is a bookmark, not a deadline: while waiting on a background job or user reply, leave it open and do other work; fold when the wait resolves. Multi-part work MUST be split into NESTED SUBTASKS: while the outer task stays open, task_begin each distinct part as you start it and task_end it the moment that part\u0027s outcome is verifiable — innermost closes first and each part folds at its own close, so the surface stays lean during long work instead of one giant fold at the end. A long detour or dead-end exploration inside a task is one such part. Shape example: task_begin "review week 47" → task_begin "review PR #98" … task_end "review PR #98" → task_begin "review PR #99" … task_end "review PR #99" → task_end "review week 47". Folded details are never lost: list_folds → fold_recall({ fold }) → read/grep the artifact. Recall on demand — when a summary\u0027s anchors fail to answer a concrete question the work or the report needs, or when a new task genuinely depends on an earlier folded task\u0027s details (recall that fold, list_folds → fold_recall → read/grep, before starting it); never guess, never ask the user\u0027s permission to recall, never recall without such a need. Never restate a folded span from memory; never track message positions yourself. Each fold summary node ends with a Fold archive section (fold number, artifact path, and the complete span preview — one line per archived message; fold_recall\u0027s line overload returns any numbered line verbatim). A fold\u0027s archive spans just after the \u0027Task begun\u0027 result through the \u0027Task ended\u0027 result, so the task_begin call, its opening reasoning, and the \u0027Task begun\u0027 result itself stay live. Runtime context carries lifecycle nudges — treat them as directives and act on them.'
    })

    // HOLD semantics for lifecycle nudges: each nudge line renders for as
    // long as its condition holds — no fire/cooldown cycle, so a nudge never
    // "fires then stops nagging". The snapshot engine is diff-driven: an
    // unchanged context render produces NO new snapshot, and a condition
    // clearing produces exactly one retraction snapshot. This only works
    // while the line text is BYTE-STABLE, so nudge wording past its
    // threshold is deliberately number-free ("20+ rounds", never "~23").
    ctx.systemPrompt.context({
      name: 'todo-bridge',
      order: 130,
      text: (context) => {
        // Per-session state: the context callback receives { agent, scope,
        // signal }, so marks and todos are keyed to THIS session.
        const agent = context !== null && typeof context === 'object' ? context.agent : undefined
        if (agent === undefined) return ''
        let session
        try { session = agent.session } catch (err) { session = undefined }
        if (session === null || session === undefined) return ''
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

        // ── Nudge 2: a task left open for a long time ──────────────────
        // Scans ALL open marks and holds on the OLDEST one aged 20+ rounds
        // (one task per line, byte-stable). Tie-break: first hit wins —
        // equal (cap-saturated) ages mean both are ≥20 rounds old and seqs
        // ascend with push order, so the earlier mark is the older task.
        // This only holds while cap ≥ threshold; revisit if either changes.
        if (ownDepth > 0) {
          let oldest = null
          let oldestAge = -1
          for (const m of marks) {
            const age = countAssistantSince(events, m.seq, 21)
            if (age > oldestAge) { oldestAge = age; oldest = m }
          }
          if (oldestAge >= 20) {
            lines.push('Task lifecycle: task "' + oldest.name + '" is 20+ rounds old — if done, call task_end({ name: "' + oldest.name + '" }); if a newer task blocks it, close that first; if it is genuinely waiting on a job or reply, leave it open.')
          }
          // ── Nudge 3: decomposition while a big task is actively worked ──
          // Covers the GAP between "just began" (nothing to decompose) and
          // Nudge 2's close pressure (20+): a mark aged 8–19 rounds with
          // ongoing work gets a HOLD hint to wrap remaining distinct parts
          // as nested subtasks — without it, the only live signal after the
          // first task_begin is Nudge 2 pushing to CLOSE, and long jobs run
          // as one flat mark (observed in the wild: a 14-minute 4-PR review
          // folded as a single blob). Retracts when the age leaves the
          // window, the work stops, or the roster changes (a nested begin
          // reshapes oldest/depth). Wording is byte-stable past threshold.
          if (shouldSuggestDecomposition(ownDepth, oldestAge, recentWorkCallCount(events))) {
            lines.push(decomposeHintLine(oldest.name))
          }
        }

        // ── Auto-fold failure warning (HOLD) ─────────────────────────────
        // Renders for as long as a queued archive's auto-fold keeps failing
        // (engine busy etc.); retracts when the fold finally commits or the
        // entry settles. Bucket wording is byte-stable per failure cause.
        const fails = drain.autoFoldFailures.get(session.id)
        if (fails !== undefined) {
          for (const [failName, bucket] of fails) {
            lines.push('Task lifecycle: auto-fold for "' + failName.replace(/"/g, "'") + '" is failing (' + bucket + ') — it retries automatically at every step boundary; no action needed.')
          }
        }

        // ── Todo bridge: transient change report ──────────────────────
        // Renders ONLY on the request right after the model called
        // todo_write (detected statelessly in the most recent assistant
        // message); the diff-driven snapshot engine retracts the line on
        // the next unchanged render — one appearance per todo_write. The
        // line reports the change plus the open task roster; whether to
        // task_begin or task_end is the MODEL's call — a status report,
        // not a conditional nag.
        if (lastAssistantHasTodoWrite(events)) {
          lines.push(todoBridgeLine(marks.map((m) => m.name)))
        }
        return lines.join('\n')
      }
    })
  }
}
