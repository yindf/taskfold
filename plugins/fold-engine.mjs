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
 * The '# <task>' title line is CONSTRUCTED: the engine prepends it to
 * the model's output (prependFoldHeading), the model is instructed to
 * write no title and open with '## What happened', and a structural
 * check (opensWithSectionHeading) rejects output that does not.
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

import { renderArchiveFooter, renderSpanPreview, writeSpanArtifact, sessionArtifactDir } from './span-preview.mjs'
import { assembleFoldInstruction } from './fold-instruction.mjs'
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
 * Resolve @deepseek-ai/dsh-llm's BlockAssembler, failing at BUILD time
 * when dsh-llm is unresolvable or malformed. The old path installed a
 * no-op stand-in whose summarize() failed only AFTER a full, billed LLM
 * call ('no text summary content'); a broken install then re-billed a
 * call on every retry. Throwing here makes engineFor() return undefined,
 * and the drain takes its zero-LLM path (HOLD line: engine unavailable).
 */
export async function resolveBlockAssembler(importFn) {
  let llmMod
  try {
    llmMod = await importFn('@deepseek-ai/dsh-llm')
  } catch (err) {
    const why = err !== null && typeof err === 'object' && err.message !== undefined ? String(err.message) : String(err)
    throw new Error('dsh-llm BlockAssembler unavailable: ' + why)
  }
  if (llmMod === null || typeof llmMod !== 'object' || typeof llmMod.BlockAssembler !== 'function') {
    throw new Error('dsh-llm BlockAssembler unavailable: BlockAssembler export missing')
  }
  return llmMod.BlockAssembler
}

/**
 * Heading CONSTRUCTION, not heading COMPLIANCE (live-data ruling): the
 * fold engine itself prepends the exact '# <closingName>' title line to
 * the model's summary, and the model is instructed to write NO title —
 * open directly with the '## What happened' section. Demanding the model
 * reproduce the heading proved unreliable across languages: in Chinese
 * conversations it translated the title 11 of 12 times under the
 * byte-exact guard and 9+ times straight under a verbatim-copy
 * instruction, each rejection re-summarizing the whole span (30–70 s).
 * Construction makes the heading byte-exact by definition; the residual
 * receipt is structural — the first non-empty output line must be a
 * '## ' section heading, modulo a SHORT bounded preamble
 * (stripBoundedPreamble); drift beyond that bound fails loud.
 */
export function prependFoldHeading(blocks, name) {
  if (typeof name !== 'string' || name.length === 0 || !Array.isArray(blocks)) return blocks
  const idx = blocks.findIndex((b) => b !== null && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0)
  if (idx === -1) return blocks
  const out = blocks.slice()
  out[idx] = { ...blocks[idx], text: '# ' + name + '\n\n' + blocks[idx].text }
  return out
}

export function opensWithSectionHeading(blocks) {
  if (!Array.isArray(blocks)) return false
  const first = blocks.find((b) => b !== null && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0)
  if (first === undefined) return false
  return first.text.trim().split('\n')[0].trim().indexOf('## ') === 0
}

/**
 * Bounded preamble tolerance for the structure receipt (review-found
 * live failure): models summarizing dense CJK spans sometimes open with
 * one to three lead-in lines before the first '## ' section heading.
 * The zero-tolerance receipt rejected that, the retry re-billed a full
 * summarization call, and the run could go to give-up with the span
 * stranded on the surface forever. Strip a leading run of NON-heading
 * lines from the first non-empty text block when it is short — at most
 * MAX_PREAMBLE_LINES non-empty lines and MAX_PREAMBLE_CHARS characters
 * in total, blank lines free — with the first '## ' heading inside that
 * window. Returns the cleaned block array, the input unchanged when it
 * already opens with a heading, or undefined when the bound is exceeded
 * or no heading is reachable (the caller fails loud: that is drift).
 */
const MAX_PREAMBLE_LINES = 3
const MAX_PREAMBLE_CHARS = 400

export function stripBoundedPreamble(blocks) {
  if (!Array.isArray(blocks)) return undefined
  const idx = blocks.findIndex((b) => b !== null && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0)
  if (idx === -1) return undefined
  const lines = blocks[idx].text.split('\n')
  let nonEmpty = 0
  let chars = 0
  let cut = 0
  let found = false
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim()
    if (trimmed.length === 0) { cut = i + 1; continue }
    if (trimmed.indexOf('## ') === 0) { found = true; break }
    nonEmpty += 1
    chars += trimmed.length
    if (nonEmpty > MAX_PREAMBLE_LINES || chars > MAX_PREAMBLE_CHARS) return undefined
    cut = i + 1
  }
  if (!found) return undefined
  if (cut === 0) return blocks
  const kept = lines.slice(cut).join('\n')
  if (kept.trim().length === 0) return undefined
  const out = blocks.slice()
  out[idx] = { ...blocks[idx], text: kept }
  return out
}

/**
 * Drop the host's duplicated leading system message when the prefix envelope
 * already replays it. dsh >= 0.1.5-alpha.1's buildSummarizationInput moved the
 * surface-node-0 system prompt OUT of the separate `system` field and INTO
 * `messages[0]`; the prefix envelope below already prepends that same derived
 * node, so both together inserted a second system message immediately before
 * the span — exactly where the provider's prefix cache then broke, re-billing
 * the whole span at full price (measured on 0.1.5-alpha.1: cacheRead == the
 * pre-span prefix on all five folds of one session, ~112k tokens re-billed;
 * 0.1.2-rc.1 kept system in its own field and never hit this). Detection is
 * structural, never a version check: the head is dropped only when a
 * byte-identical system message already appears earlier in the request, so a
 * host sending a system prompt we do NOT replay keeps it.
 */
export function dropDuplicateLeadingSystem(prefixMessages, regionMessages) {
  if (!Array.isArray(prefixMessages) || prefixMessages.length === 0) return regionMessages
  if (!Array.isArray(regionMessages) || regionMessages.length === 0) return regionMessages
  const head = regionMessages[0]
  if (head === null || typeof head !== 'object' || head.role !== 'system') return regionMessages
  const serialized = JSON.stringify(head)
  const duplicated = prefixMessages.some((m) => m !== null && typeof m === 'object' && m.role === 'system' && JSON.stringify(m) === serialized)
  return duplicated ? regionMessages.slice(1) : regionMessages
}

/**
 * The SPAN coordinate — the messages a fold ARCHIVES, NUMBERS and FOOTERS.
 *
 * It is NOT always `input.messages`. The host prepends the surface-head
 * system prompt into `messages[0]` (dsh >= 0.1.5-alpha.1), so that array is
 * the ROUTED REQUEST's span, one message longer than the span the commit
 * shadows. `fold_recall` rebuilds a fold from `data.shadowedSeqs` alone
 * (`spanNodes.map(deriveEventMessage)`), so writing the artifact from
 * `input.messages` put every artifact, span index and footer exactly ONE
 * LINE off recall's coordinates (measured live: 36/5/14 lines against 35/4/13
 * shadowed seqs, artifact line 1 always `role: system`) — the model copied
 * `L<N>` numbers that address neither the request it was sent nor the
 * originals recall returns ("preview line N = artifact line N" held only on
 * the artifact side). Recomputing the region from the closing declaration
 * reproduces the commit's own `shadowedSeqs` slice — the host validates
 * exactly `nodes.slice(startIdx, endIdx + 1)` — so the fold-time artifact,
 * the fold-time index, and a later `fold_recall({ fold })` are one
 * coordinate by construction, with no version check and no head detection.
 * Falls back to the deduped request span for a call with no closing
 * declaration (the stock AUTO path) or when the seqs are no longer
 * locatable.
 */
export function spanMessagesFor(session, closingInfo, fallback) {
  try {
    if (closingInfo === null || typeof closingInfo !== 'object') return fallback
    if (!Number.isInteger(closingInfo.startSeq) || !Number.isInteger(closingInfo.endSeq)) return fallback
    if (session === null || typeof session !== 'object') return fallback
    if (typeof session.deriveEventMessage !== 'function' || typeof session.eventAt !== 'function') return fallback
    const nodes = session.surface !== null && typeof session.surface === 'object' && Array.isArray(session.surface.nodes)
      ? session.surface.nodes
      : null
    if (nodes === null) return fallback
    const startIdx = nodes.indexOf(closingInfo.startSeq)
    const endIdx = nodes.indexOf(closingInfo.endSeq)
    if (startIdx === -1 || endIdx < startIdx) return fallback
    const picked = []
    for (let i = startIdx; i <= endIdx; i += 1) {
      const m = session.deriveEventMessage(session.eventAt(nodes[i]))
      if (m !== null && m !== undefined) picked.push(m)
    }
    return picked.length > 0 ? picked : fallback
  } catch (err) {
    return fallback
  }
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
  // Fail at BUILD time when dsh-llm is unresolvable: the old no-op
  // stand-in billed the full summarization call and only then failed
  // ('no text summary content'). Throwing here routes engineFor() to
  // undefined and the drain takes its zero-LLM path instead.
  const Assembler = await resolveBlockAssembler(importHostPackage)

  class ScopedEngine extends Base {
    async summarize(input, agent, signal) {
      // requestHeader() is a host API, not a guaranteed one: an unguarded
      // call that throws here turns into a DETERMINISTIC fold failure that
      // the drain re-attempts at every step boundary (each attempt a full
      // summarization call). Degrade to the configured / agent targets.
      let header
      try { header = agent.session.requestHeader() } catch (err) { header = undefined }
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
          + '- Write NO title heading: the engine adds the title line itself. Open the summary directly with the "## What happened" section — nothing before it; section headings stay as instructed, the content may use any language.\n'
          + '- This fold CLOSES the task: no further work belongs to it, so do not report anything as unfinished or pending merely because of how the span ends — this very fold is the task\u0027s ending. Closed is not the same as succeeded: if the work ended in a genuine failure or dead end, report that honestly in Outcomes.\n'
          + '- Do NOT summarize task_begin / task_end calls, their results, or any narration that merely announces starting or finishing the task — that is lifecycle bookkeeping, not content. Summarize the WORK itself.'
        : ''
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
      // Instruction tail carries the SPAN MESSAGE INDEX (renderSpanPreview
      // of the span, fenced, appended after the closing rules): the model
      // copies line numbers from it instead of counting messages (three-arm
      // controlled experiment: 100% citation accuracy with a visible index;
      // mechanism = copy-the-visible-number). The index rides in the
      // always-fresh instruction message — the span bytes stay untouched,
      // so the prefix-cache anchor is preserved.
      // The host may prepend the surface-node-0 system prompt into
      // input.messages (dsh >= 0.1.5-alpha.1); the prefix envelope already
      // replays it, so the REQUEST keeps exactly one copy
      // (dropDuplicateLeadingSystem). The SPAN coordinate is a different
      // thing — see spanMessagesFor: the artifact, the span index and the
      // footer describe what the commit shadows, which is what fold_recall
      // rebuilds, never the routed request's extra head.
      const regionMessages = dropDuplicateLeadingSystem(prefixMessages, input.messages)
      const spanMessages = spanMessagesFor(agent.session, closingInfo, regionMessages)
      const messages = [...prefixMessages, ...regionMessages, {
        role: 'user',
        content: [{
          type: 'text',
          text: assembleFoldInstruction({
            opts: { prefix: prefixMessages.length > 0, name: closingName },
            closing,
            indexLines: renderSpanPreview(spanMessages)
          })
        }]
      }]
      const options = {
        provider: target.provider,
        model: target.model,
        messages,
        ...(input.system === undefined ? {} : { system: input.system }),
        ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
        // NO maxTokens cap on the fold call (product ruling: the mechanism
        // imposes no length limit on summaries — accuracy governs length,
        // bounded only by the provider default and the host's
        // not-smaller-than-span rejection).
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
      // STRUCTURE RECEIPT + HEADING CONSTRUCTION: the model is told to
      // write no title and open with '## What happened'; the engine then
      // PREPENDS the exact '# <closingName>' heading itself. Construction
      // beats compliance — demanding the model reproduce the heading
      // verbatim proved unreliable across languages (translated titles
      // scored 0.00 and re-summarized the whole span 9+ times). The
      // residual check is structural, with bounded preamble tolerance: a
      // short lead-in (stripBoundedPreamble: ≤3 non-empty lines, ≤400
      // chars — dense CJK spans produce them) is stripped first; drift
      // beyond that bound fails loud → retried on a later boundary; never
      // commit a malformed summary.
      let withHeading = summary
      if (closingName.length > 0) {
        let sanitized = opensWithSectionHeading(summary) ? summary : stripBoundedPreamble(summary)
        if (sanitized === undefined || !opensWithSectionHeading(sanitized)) {
          const firstText = summary.find((b) => b.text.trim().length > 0)
          const firstLine = firstText === undefined ? '' : firstText.text.trim().split('\n')[0].trim()
          throw new Error('summary structure failure: expected the summary to open with a "## " section heading (## What happened), got: ' + firstLine.slice(0, 80))
        }
        withHeading = prependFoldHeading(sanitized, closingName)
      }
      // FOLD ARCHIVE SECTION EMBEDDED IN THE SUMMARY NODE (product
      // ruling): this hook is the last stop before the engine commits,
      // and it owns the summary text — so the fold number (existing
      // summaries in THIS session + 1; per-session counters, the
      // event-log lock makes the fold serial) and the artifact
      // (spanMessages IS the exact span the commit shadows, and the exact
      // coordinate fold_recall regenerates from shadowedSeqs) are computed
      // HERE and appended as a section formatted like the summary's own
      // five:
      //   ## Fold archive
      //   - fold #N · M messages · originals (JSONL, one message per
      //     line): <path>
      //   + a resident footer — head+tail window of the span preview
      //     with TRUE line numbers (renderArchiveFooter; the complete
      //     index stays one fold_recall away). The committed node then
      //     carries its own recall handles; no separate notice message
      //     is injected at all. If the engine later rejects the commit,
      //     the pre-written artifact becomes an orphan temp file —
      //     harmless.
      const withFooter = [...withHeading]
      if (withFooter.length > 0) {
        let foldNo = 0
        for (const e of sessionEvents(agent.session)) {
          if (e !== null && typeof e === 'object' && e.type === 'compaction/summary') foldNo += 1
        }
        foldNo += 1
        const name = typeof closingName === 'string' && closingName.length > 0 ? closingName : 'fold'
        const file = writeSpanArtifact(spanMessages, name, { sessionDir: sessionArtifactDir(ctx, agent.session), sessionKey: agent.session.id })
        if (file !== undefined) {
          // Markdown-safe formatting: single newlines collapse into one
          // paragraph in every markdown renderer, which mashed the
          // preview into a blob. A fenced code block preserves the
          // per-line layout; a blank line separates the metadata bullet.
          const section = '\n\n## Fold archive\n\n- fold #' + foldNo + ' · ' + spanMessages.length + ' messages · originals (JSONL, one message per line): ' + file + '\n\n```\n'
            + renderArchiveFooter(spanMessages).join('\n') + '\n```'
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
