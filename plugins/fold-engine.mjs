/**
 * The self-hosted scoped fold engine: resolution + subclassing of the
 * host's BasicCompactionEngine.
 *
 * Scoped summarizer engine: subclasses BasicCompactionEngine so that
 * regionDependencies()' dynamic dispatch reaches OUR summarize(), while
 * compactRegion's locking, validation, stability checks, and commit path
 * stay stock. The LLM call uses the PREFIX-ANCHORED envelope when the
 * closing declaration and surface allow it (surface prefix + span +
 * scoping instruction → strict prefix of the main conversation request →
 * provider prefix-cache reuse), falling back to the span-only envelope.
 * A scope-adherence guard rejects any summary titled other than the
 * closing task.
 *
 * Engine resolution: ALWAYS this ScopedEngine instance — instantiated once
 * and cached on success. auto:false keeps the constructor side-effect-free;
 * the shim ctx never registers the instance as a service, so a realm engine
 * mounted for AUTO compaction is left untouched (the durable event-log lock
 * keeps the two instances mutually exclusive).
 *
 * Module resolution: a bare-specifier import works when this plugin sits
 * inside a node_modules tree (profile npm install) but NOT from a bare
 * preset directory (the package lives in the host's npx cache). Fallback:
 * walk up from host anchors (process.argv[1], cwd) to a node_modules dir
 * containing the engine package, and import its lib entry by file URL.
 * If even that fails, the cache stores null (no retry — the resolution
 * environment does not change within a process lifetime) and task folds
 * degrade to closing tasks unfolded.
 */
import nodePath from 'node:path'
import nodeFs from 'node:fs'
import nodeUrl from 'node:url'

import { renderArchivePreview, writeSpanArtifact, sessionArtifactDir } from './span-preview.mjs'
import { buildFoldInstruction } from './fold-instruction.mjs'
import { sessionEvents } from './events.mjs'

function engineCandidatePaths() {
  const anchors = []
  try {
    if (typeof process === 'object' && process !== null && Array.isArray(process.argv) && typeof process.argv[1] === 'string' && process.argv[1].length > 0) {
      anchors.push(nodePath.dirname(nodePath.resolve(process.argv[1])))
    }
  } catch (err) { /* ignore */ }
  try { anchors.push(nodePath.resolve(process.cwd())) } catch (err) { /* ignore */ }
  const dirs = []
  for (const anchor of anchors) {
    let dir = anchor
    for (let i = 0; i < 10; i++) {
      dirs.push(nodePath.join(dir, 'node_modules'))
      const parent = nodePath.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return dirs
}

async function importHostPackage(pkgName) {
  try { return await import(pkgName) } catch (err) { /* fall through */ }
  for (const dir of engineCandidatePaths()) {
    const pkgDir = nodePath.join(dir, '@deepseek-ai', pkgName.replace(/^@deepseek-ai\//, ''))
    let ok = false
    try { ok = nodeFs.statSync(pkgDir).isDirectory() } catch (err) { ok = false }
    if (!ok) continue
    return await import(nodeUrl.pathToFileURL(nodePath.join(pkgDir, 'lib', 'index.js')).href)
  }
  throw new Error(pkgName + ' is not resolvable from this install')
}

/**
 * Build the scoped engine once. `closingTasks` is the per-session Map the
 * fold drain writes the closing declaration into ({ name, startSeq, endSeq },
 * keyed by sessionId): the name DECLARES the completion (the span's own
 * tail cannot contain its ending yet), sets the TITLE, and scopes the
 * prefix-anchored envelope; startSeq locates the span on the surface for
 * the prefix slice. Passing the Map in (never stashing it on the shared
 * engine instance) keeps concurrent folds in different sessions of one
 * process from cross-contaminating each other's summary titles.
 */
async function buildScopedEngine(ctx, closingTasks) {
  const engineMod = await importHostPackage('@deepseek-ai/dsh-compaction-basic')
  const Base = engineMod.default !== undefined ? engineMod.default : engineMod.BasicCompactionEngine
  if (typeof Base !== 'function') throw new Error('engine export missing')
  // Degradation stand-in when dsh-llm is unresolvable: a finish of
  // { kind: 'stop' } with zero blocks makes our summarize() fail loudly
  // ('no text summary content') instead of crashing on a missing class.
  let Assembler = class { push() {} blocks() { return [] } finish = { kind: 'stop' } }
  try {
    const llmMod = await importHostPackage('@deepseek-ai/dsh-llm')
    if (typeof llmMod.BlockAssembler === 'function') Assembler = llmMod.BlockAssembler
  } catch (err) { /* without the real assembler the summary will fail loudly */ }

  class ScopedEngine extends Base {
    async summarize(input, agent, signal) {
      const header = agent.session.requestHeader()
      const latest = header !== null && typeof header === 'object' && header.config !== undefined ? header.config : undefined
      const cfg = this.config
      const configured = typeof cfg.summarizationProvider === 'string' && cfg.summarizationProvider.length > 0
        ? { provider: cfg.summarizationProvider, model: cfg.summarizationModel }
        : undefined
      const agentTarget = agent.options !== undefined && typeof agent.options.provider === 'string' && agent.options.provider.length > 0
        && typeof agent.options.model === 'string' && agent.options.model.length > 0
        ? { provider: agent.options.provider, model: agent.options.model }
        : undefined
      const target = configured ?? latest ?? agentTarget
      if (target === undefined) throw new Error('no provider/model available for scoped summarization')
      // The fold caller (the drain in fold-drain.mjs) stashed the closing
      // declaration in the per-session closingTasks map.
      const closingInfo = closingTasks.get(agent.session.id)
      const closingName = closingInfo !== null && typeof closingInfo === 'object' && typeof closingInfo.name === 'string' ? closingInfo.name : ''
      const closing = closingName.length > 0
        ? '\nThe task this span belongs to is named "' + closingName + '". Rules for this fold:\n'
          + '- Begin the summary with the heading line "# ' + closingName + '" — nothing before it. That heading prefixes the structure above: follow it with the five sections exactly as instructed.\n'
          + '- This fold CLOSES the task: no further work belongs to it, so do not report anything as unfinished or pending merely because of how the span ends — this very fold is the task\u0027s ending. Closed is not the same as succeeded: if the work ended in a genuine failure or dead end, report that honestly in Outcomes.\n'
          + '- Do NOT summarize task_begin / task_end calls, their results, or any narration that merely announces starting or finishing the task — that is lifecycle bookkeeping, not content. Summarize the WORK itself.'
        : ''
      // Concrete per-fold budget: ~10% of the span's estimated tokens
      // (chars/4 heuristic), floored so tiny spans still get a usable
      // summary, ceilinged to stay inside the summarizer's maxTokens.
      // Budget is computed from the SPAN alone — prefix context never
      // inflates it.
      const estTokens = Math.max(1, Math.floor(JSON.stringify(input.messages).length / 4))
      const wordBudget = Math.min(4000, Math.max(150, Math.floor((estTokens * 0.1) / 1.35)))
      const budgetLine = '\nWord budget for THIS fold: at most ~' + wordBudget + ' words (≈10% of ~' + estTokens + ' estimated span tokens).'
      // PREFIX-ANCHORED ENVELOPE: prepend every surface node before the
      // span so the request is a strict prefix of the main conversation
      // request → provider prefix-cache reuse (~97% hit measured; the
      // span-only envelope can never hit). Falls back to span-only on
      // ANY anomaly: missing declaration, span not on the surface,
      // derivation failure, or a pathological prefix size (a trimmed
      // prefix would forfeit the cache anyway, so it is all-or-nothing).
      let prefixMessages = []
      if (closingInfo !== null && typeof closingInfo === 'object' && Number.isInteger(closingInfo.startSeq)
        && typeof agent.session.deriveEventMessage === 'function' && typeof agent.session.eventAt === 'function') {
        try {
          const nodes = agent.session.surface.nodes
          const startIdx = nodes.indexOf(closingInfo.startSeq)
          if (startIdx > 0) {
            const picked = []
            for (let i = 0; i < startIdx; i += 1) {
              const m = agent.session.deriveEventMessage(agent.session.eventAt(nodes[i]))
              if (m !== null && m !== undefined) picked.push(m)
            }
            if (picked.length > 0 && JSON.stringify(picked).length <= 4000000) prefixMessages = picked
          }
        } catch (err) { prefixMessages = [] }
      }
      const messages = [...prefixMessages, ...input.messages, {
        role: 'user',
        content: [{ type: 'text', text: buildFoldInstruction({ prefix: prefixMessages.length > 0, name: closingName }) + budgetLine + closing }]
      }]
      const options = {
        provider: target.provider,
        model: target.model,
        messages,
        ...(input.system === undefined ? {} : { system: input.system }),
        ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
        maxTokens: cfg.maxTokens,
        sessionId: agent.session.id,
        purpose: 'compaction',
        ...(signal === undefined ? {} : { signal })
      }
      const assembler = new Assembler()
      for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
      const finish = assembler.finish
      if (finish !== undefined && (finish.kind === 'error' || finish.kind === 'aborted')) {
        throw new Error(finish.failure !== undefined && finish.failure.message !== undefined ? String(finish.failure.message) : String(finish.kind))
      }
      const rawOutput = assembler.blocks()
      const summary = rawOutput.filter((b) => b !== null && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
      if (!summary.some((b) => b.text.trim().length > 0)) throw new Error('summarization produced no text summary content')
      // SCOPE ADHERENCE GUARD (prefix envelope): the instruction demands
      // the heading '# <closingName>'; a summary titled anything else
      // means the model folded the wrong region (or drifted into the
      // earlier conversation). Fail loud → failure bucket → retried on a
      // later boundary; never commit a mis-scoped summary.
      if (closingName.length > 0) {
        const firstText = summary.find((b) => b.text.trim().length > 0)
        if (firstText !== undefined && firstText.text.trim().indexOf('# ' + closingName) !== 0) {
          throw new Error('summary scope failure: expected the heading \'# ' + closingName + '\', got: ' + firstText.text.trim().slice(0, 80))
        }
      }
      // FOLD ARCHIVE SECTION EMBEDDED IN THE SUMMARY NODE (product
      // ruling): this hook is the last stop before the engine commits,
      // and it owns the summary text — so the fold number (existing
      // summaries in THIS session + 1; per-session counters, the
      // event-log lock makes the fold serial) and the artifact
      // (input.messages IS the exact span) are computed HERE and
      // appended as a section formatted like the summary's own five:
      //   ## Fold archive
      //   - fold #N · originals (JSONL, one message per line — span
      //     "Task begun" result … "Task ended" result): <path>
      //   + the complete span preview (preview line N = artifact
      //     line N). The committed node then carries its own recall
      //     handles; no separate notice message is injected at all. If
      //     the engine later rejects the commit, the pre-written
      //     artifact becomes an orphan temp file — harmless.
      const withFooter = [...summary]
      if (withFooter.length > 0) {
        let foldNo = 0
        for (const e of sessionEvents(agent.session)) {
          if (e !== null && typeof e === 'object' && e.type === 'compaction/summary') foldNo += 1
        }
        foldNo += 1
        const name = typeof closingName === 'string' && closingName.length > 0 ? closingName : 'fold'
        const file = writeSpanArtifact(input.messages, name, { sessionDir: sessionArtifactDir(ctx, agent.session), sessionKey: agent.session.id })
        if (file !== undefined) {
          // Markdown-safe formatting: single newlines collapse into one
          // paragraph in every markdown renderer, which mashed the
          // preview into a blob. A fenced code block preserves the
          // per-line layout; a blank line separates the metadata bullet.
          const section = '\n\n## Fold archive\n\n- fold #' + foldNo + ' · originals (JSONL, one message per line — span: just after the "Task begun" result … "Task ended" result): ' + file + '\n\n```\n'
            + renderArchivePreview(input.messages).join('\n') + '\n```'
          const last = withFooter[withFooter.length - 1]
          withFooter[withFooter.length - 1] = { ...last, text: last.text.replace(/\s+$/, '') + section }
        }
      }
      return {
        summary: withFooter,
        rawOutput,
        llmStreamCall: true,
        provider: options.provider,
        model: options.model,
        maxTokens: cfg.maxTokens,
        ...(assembler.usage === undefined ? {} : { usage: assembler.usage })
      }
    }
  }

  // Shim ctx: the cordis Service base registers itself via
  // ctx.reflect.provide in the constructor — on a plain shim that is a
  // no-op, so our instance never collides with (or replaces) the realm
  // engine a preset row may have registered for AUTO compaction. The
  // engine's current-turn path touches only these fields.
  const shimCtx = {
    tokenMeter: ctx.tokenMeter,
    llm: ctx.llm,
    get: (name) => (typeof ctx.get === 'function' ? ctx.get(name) : undefined),
    reflect: { provide: () => {} }
  }
  return new ScopedEngine(shimCtx, { auto: false })
}

/**
 * Engine accessor factory: returns an async engineFor() that builds the
 * SCOPED instance once and caches it (or caches null for the process
 * lifetime on failure — the resolution environment never changes
 * mid-process). A realm engine (preset row) is deliberately NOT used by
 * our folds: it runs the stock continuity-checkpoint instruction. The
 * realm instance keeps serving AUTO compaction (pressure/overflow), where
 * checkpoint semantics are exactly right; task folds get span summaries.
 * The durable lock is shared through the event log, so the two instances
 * stay mutually exclusive.
 */
export function createFoldEngine(ctx, closingTasks) {
  let selfEngine = undefined
  return async function engineFor() {
    if (selfEngine !== undefined) return selfEngine === null ? undefined : selfEngine
    try {
      selfEngine = await buildScopedEngine(ctx, closingTasks)
      return selfEngine
    } catch (err) {
      selfEngine = null
      return undefined
    }
  }
}
