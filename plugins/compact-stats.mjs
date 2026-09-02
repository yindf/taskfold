/**
 * compact_stats / compact_recall — session compaction observability tools
 * (preset plugin).
 *
 * Read-only companion to compact-region: reports what compaction did for THIS
 * session by scanning the live event log (exec.agent.session.events), and
 * recalls the ORIGINAL content of folded entries on demand. Events survive
 * folds — the surface is a projection — so nothing is ever lost, only
 * projected away. Seqs are stable archive ids (surface positions shift).
 *
 * Fold shape (pinned against dsh-compaction-basic's commitCompactionBody):
 *   event.type === 'compaction/summary' with
 *     data.compactionId, data.shadowedRange {start,end},
 *     data.shadowedSeqs (array of archived surface-node seqs),
 *     data.shadowedTokenCount, data.summary (array of {type:'text',text}),
 *     data.provider, data.model
 *
 * Degradation is distinguishable by construction: fold accounting keys on
 * the single native 'compaction/summary' type only — no exhaustive
 * known-type list to maintain (that list coupled this plugin to every
 * harness event type and drifted on every upgrade).
 *
 * Pure helpers are named exports so tests can exercise them without a host.
 */
export const PREVIEW_LIMIT = 60
export const RECALL_FULL_LIMIT = 4000

/**
 * Fold-summary preview. The engine's summarizer forces every summary to open
 * with the SAME markdown structure ("## Primary Request and Intent\n\n- …"),
 * so a naive head-slice would spend the whole 60-char budget on boilerplate
 * and every fold preview would look identical. Skip leading section headers
 * and blank space, preview the first meaningful line, and mark truncation.
 */
function firstTextBlock(summary) {
  if (!Array.isArray(summary)) return ''
  for (const block of summary) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      const body = block.text.split('\n').find((line) => {
        const t = line.trim()
        return t.length > 0 && !t.startsWith('#')
      })
      if (body === undefined) return ''
      const flat = body.replace(/\s+/g, ' ').trim()
      return flat.length > PREVIEW_LIMIT ? flat.slice(0, PREVIEW_LIMIT) + '…' : flat
    }
  }
  return ''
}

/** Fold record from one `compaction/summary` event; defensive on every field. */
export function foldOf(event) {
  const data = event !== null && typeof event === 'object' && event.data !== null && typeof event.data === 'object' ? event.data : {}
  const tokens = typeof data.shadowedTokenCount === 'number' && Number.isFinite(data.shadowedTokenCount) ? data.shadowedTokenCount : 0
  const record = {
    seq: Number.isInteger(event.seq) ? event.seq : -1,
    shadowedTokenCount: tokens,
    preview: firstTextBlock(data.summary)
  }
  if (typeof data.compactionId === 'string') record.compactionId = data.compactionId
  if (data.shadowedRange !== null && typeof data.shadowedRange === 'object') {
    if (Number.isInteger(data.shadowedRange.start)) record.shadowedStart = data.shadowedRange.start
    if (Number.isInteger(data.shadowedRange.end)) record.shadowedEnd = data.shadowedRange.end
  }
  if (typeof data.provider === 'string') record.provider = data.provider
  if (typeof data.model === 'string') record.model = data.model
  if (typeof data.shadowedTokenCount !== 'number') record.shadowedTokenCountMissing = true
  if (Array.isArray(data.shadowedSeqs)) {
    const seqs = data.shadowedSeqs.filter((s) => Number.isInteger(s))
    if (seqs.length > 0) record.shadowedSeqs = seqs
  }
  return record
}

/** Full stats over a live event log. Single linear pass, O(n). */
/**
 * Cross-version event-log accessor: dsh ≤0.1.2-alpha.3 exposed the whole log
 * as session.events (array); alpha.4 replaced it with on-demand APIs —
 * session.snapshotEvents() returns a full array snapshot. Support both.
 * (Local copy: this plugin stays dependency-free of its sibling.)
 */
function sessionEvents(session) {
  if (session === undefined || session === null) return []
  if (Array.isArray(session.events)) return session.events
  if (typeof session.snapshotEvents === 'function') {
    try { return session.snapshotEvents() } catch (err) { return [] }
  }
  return []
}

export function collectStats(events, surfaceLength) {
  const list = Array.isArray(events) ? events : []
  const folds = []
  for (const event of list) {
    if (event === null || typeof event !== 'object' || typeof event.type !== 'string') continue
    if (event.type === 'compaction/summary') folds.push(foldOf(event))
  }
  attachFoldTitles(folds, list)
  const shadowedTokens = folds.reduce((sum, f) => sum + f.shadowedTokenCount, 0)
  return {
    surfaceLength,
    eventCount: list.length,
    folds,
    totals: { folds: folds.length, shadowedTokens }
  }
}

function textOf(content, limit) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  const joined = parts.join('\n').replace(/\s+/g, ' ').trim()
  if (joined.length > limit) return joined.slice(0, limit) + '…'
  return joined
}

/** One archived log entry as a stable digest keyed by its (immutable) seq. */
export function digestOf(event, limit) {
  const lim = Number.isInteger(limit) && limit > 0 ? limit : PREVIEW_LIMIT
  if (event === null || typeof event !== 'object') return { seq: -1, kind: 'other', preview: '' }
  const seq = Number.isInteger(event.seq) ? event.seq : -1
  const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
  const message = data.message !== null && typeof data.message === 'object' ? data.message : null
  const content = message !== null && Array.isArray(message.content) ? message.content : []
  if (event.type === 'assistant/message') {
    const toolCalls = content.filter((b) => b !== null && typeof b === 'object' && b.type === 'tool-call')
    const names = toolCalls.map((b) => (typeof b.name === 'string' ? b.name : '')).filter((n) => n.length > 0)
    // Tool-call ARGUMENTS are the substance of the entry (the command run,
    // the file written) — include them in the digest, each capped at `lim`.
    const parts = []
    const intro = textOf(content, lim)
    if (intro.length > 0) parts.push(intro)
    for (const b of toolCalls) {
      const name = typeof b.name === 'string' && b.name.length > 0 ? b.name : '?'
      const raw = b.arguments !== undefined ? b.arguments : (b.input !== undefined ? b.input : undefined)
      let argText = ''
      if (typeof raw === 'string') argText = raw
      else if (raw !== undefined) { try { argText = JSON.stringify(raw) } catch (err) { argText = '' } }
      argText = argText.replace(/\s+/g, ' ').trim()
      if (argText.length > lim) argText = argText.slice(0, lim) + '…'
      if (argText.length > 0) parts.push('[' + name + '] ' + argText)
    }
    let preview = parts.join(' | ')
    if (preview.length > lim * 2) preview = preview.slice(0, lim * 2) + '…'
    return { seq, kind: toolCalls.length > 0 ? 'assistant/tool_call' : 'assistant/assistant', toolNames: names, preview }
  }
  if (event.type === 'user/message') return { seq, kind: 'user/message', preview: textOf(content, lim) }
  if (event.type === 'tool/result') {
    let preview = ''
    for (const block of content) {
      if (block !== null && typeof block === 'object' && block.type === 'tool-result' && Array.isArray(block.content)) {
        preview = textOf(block.content, lim)
        break
      }
    }
    return { seq, kind: 'user/tool_result', preview }
  }
  return { seq, kind: 'event/' + String(event.type), preview: '' }
}

/**
 * Full text of a `tool/result` event (concatenated tool-result blocks), or ''
 * for anything else. Shared by digest previews and fold-title extraction.
 */
function resultTextOf(event) {
  const data = event !== null && typeof event === 'object' && event.data !== null && typeof event.data === 'object' ? event.data : {}
  const message = data.message !== null && typeof data.message === 'object' ? data.message : null
  if (message === null || !Array.isArray(message.content)) return ''
  const parts = []
  for (const block of message.content) {
    if (block !== null && typeof block === 'object' && block.type === 'tool-result' && Array.isArray(block.content)) {
      for (const inner of block.content) {
        if (inner !== null && typeof inner === 'object' && inner.type === 'text' && typeof inner.text === 'string') parts.push(inner.text)
      }
    }
  }
  return parts.join('\n')
}

/**
 * Extract the fold label a task_end result carries. v5 named-task contract:
 * the success text starts 'Task ended: NAME — …'. Legacy folds fall back to
 * the old 'Title: <name>' line. Returns undefined for every other result.
 */
export function taskEndTitleOf(event) {
  if (event === null || typeof event !== 'object' || event.type !== 'tool/result') return undefined
  const text = resultTextOf(event)
  if (!text.startsWith('Task ended')) return undefined
  // v5: name immediately after the 'Task ended: ' prefix, terminated by ' —'.
  const named = /^Task ended: (.+?)(?: —|$)/.exec(text)
  if (named !== null) {
    const name = named[1].replace(/\s+/g, ' ').trim()
    if (name.length > 0) return name
  }
  // legacy: explicit 'Title: <name>' line.
  const titled = /^Title: (.+)$/m.exec(text)
  return titled === null ? undefined : titled[1].replace(/\s+/g, ' ').trim()
}

/**
 * Attach task_end titles to their folds. Primary path (two-phase task_end):
 * the titled end result sits INSIDE the fold's own shadowed range — scan the
 * fold's archived events directly. Fallback (legacy inline folds): a titled
 * task_end result labels the most recent `compaction/summary` BEFORE it.
 * Manual compact() folds simply stay untitled. Mutates and returns `folds`.
 */
export function attachFoldTitles(folds, events) {
  const list = Array.isArray(events) ? events : []
  const bySeq = new Map()
  for (const event of list) {
    if (event !== null && typeof event === 'object' && Number.isInteger(event.seq)) bySeq.set(event.seq, event)
  }
  for (const fold of folds) {
    if (fold.title !== undefined || fold.shadowedSeqs === undefined) continue
    for (const seq of fold.shadowedSeqs) {
      const title = taskEndTitleOf(bySeq.get(seq))
      if (title !== undefined) { fold.title = title; break }
    }
  }
  let last = -1
  for (const event of list) {
    if (event === null || typeof event !== 'object' || typeof event.type !== 'string') continue
    if (event.type === 'compaction/summary') { last += 1; continue }
    if (last >= 0 && folds[last] !== undefined && folds[last].title === undefined) {
      const title = taskEndTitleOf(event)
      if (title !== undefined) folds[last].title = title
    }
  }
  return folds
}

/**
 * One entry's readable body, newlines PRESERVED (code and file content must
 * stay multi-line to be readable) — the transcript extractor.
 */
function entryBodyOf(event) {
  const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
  const message = data.message !== null && typeof data.message === 'object' ? data.message : null
  const content = message !== null && Array.isArray(message.content) ? message.content : []
  if (event.type === 'assistant/message') {
    const calls = content.filter((b) => b !== null && typeof b === 'object' && b.type === 'tool-call')
    const texts = content.filter((b) => b !== null && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string').map((b) => b.text)
    let text = texts.join('\n')
    for (const b of calls) {
      const raw = b.arguments !== undefined ? b.arguments : (b.input !== undefined ? b.input : undefined)
      let argText = ''
      if (typeof raw === 'string') argText = raw
      else if (raw !== undefined) { try { argText = JSON.stringify(raw) } catch (err) { argText = '' } }
      text += (text.length > 0 ? '\n' : '') + '→ ' + (typeof b.name === 'string' ? b.name : '?') + '(' + argText + ')'
    }
    return { role: 'assistant', name: calls.map((c) => (typeof c.name === 'string' ? c.name : '')).filter(Boolean).join(','), text }
  }
  if (event.type === 'user/message') {
    return { role: 'user', name: '', text: content.filter((b) => b !== null && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n') }
  }
  if (event.type === 'tool/result') {
    for (const b of content) {
      if (b !== null && typeof b === 'object' && b.type === 'tool-result' && Array.isArray(b.content)) {
        const text = b.content.filter((x) => x !== null && typeof x === 'object' && x.type === 'text' && typeof x.text === 'string').map((x) => x.text).join('\n')
        return { role: 'tool_result', name: '', text }
      }
    }
    return { role: 'tool_result', name: '', text: '' }
  }
  return { role: 'other', name: '', text: '' }
}

/**
 * Build the ARTIFACT for a span: the conversation content between two replay
 * points ("context at end minus context at start"), rendered once as a
 * message-granular transcript — an array of lines, newlines preserved, calls
 * with their arguments, results with their text. A pure function of the
 * append-only event log: cacheable in memory, rebuildable after restart,
 * never stored. Only the three message-bearing event types are read — that
 * trio is the harness's LLM-facing message model, far more stable than the
 * event-type universe. Pathological single entries (giant tool output) are
 * capped at 6000 chars with a truncation marker.
 */
export function buildArtifactLines(events, seqs) {
  const list = Array.isArray(events) ? events : []
  const bySeq = new Map()
  for (const event of list) {
    if (event !== null && typeof event === 'object' && Number.isInteger(event.seq)) bySeq.set(event.seq, event)
  }
  const lines = []
  for (const seq of seqs) {
    const ev = bySeq.get(seq)
    if (ev === undefined) continue
    const body = entryBodyOf(ev)
    lines.push('─── ' + body.role + (body.name.length > 0 ? ' → ' + body.name : ''))
    const text = body.text
    if (text.trim().length === 0) continue
    if (text.length > 6000) {
      lines.push(text.slice(0, 6000))
      lines.push('…[' + (text.length - 6000) + ' chars truncated in artifact]')
    } else {
      lines.push(...text.split('\n'))
    }
  }
  return lines
}

/**
 * Resolve a recall query against the log. A span (fold, or an explicit seq
 * range) is rendered ONCE into an artifact — a message-granular transcript
 * cached in memory — and read back like a file. See buildRecall for modes.
 */
/**
 * Resolve a recall query against the log. A span (fold, or an explicit seq
 * range) is rendered ONCE into an artifact — a line-numbered message
 * transcript cached in memory — and read back like a file:
 *   no args            → index of all folds
 *   { fold } [+window] → artifact of that fold: header + first window
 *   { fold, find: "x" }→ search the artifact: matching lines with numbers
 *   { from, to } [..]  → same, for the archived seqs inside a raw range
 *                        (the exact range rides every fold output)
 *   { seq }            → single entry in full detail (escape hatch)
 * Window: fromLine/toLine (1-based); default 1..100, max 400 lines per call.
 * `artifactCache` (optional Map) memoizes built artifacts — artifacts are
 * pure functions of the append-only log, so a cache entry never goes stale.
 */
export const ARTIFACT_WINDOW_DEFAULT = 100
export const ARTIFACT_WINDOW_MAX = 400

export function buildRecall(events, args, artifactCache) {
  const list = Array.isArray(events) ? events : []
  const bySeq = new Map()
  const folds = []
  for (const event of list) {
    if (event === null || typeof event !== 'object' || typeof event.type !== 'string') continue
    if (Number.isInteger(event.seq)) bySeq.set(event.seq, event)
    if (event.type === 'compaction/summary') folds.push(foldOf(event))
  }
  attachFoldTitles(folds, list)
  const q = args !== null && typeof args === 'object' ? args : {}
  const cache = artifactCache instanceof Map ? artifactCache : undefined
  const modes = [q.fold !== undefined, q.seq !== undefined, q.from !== undefined || q.to !== undefined].filter(Boolean).length
  if (modes > 1) return { ok: false, error: 'pick exactly one targeting mode: fold, seq, or from/to' }
  if (modes === 0) {
    return {
      ok: true,
      mode: 'index',
      // Tool results must be lossless JSON: never emit a property whose value
      // is undefined (untitled folds, pre-shadowedSeqs folds have none).
      folds: folds.map((f, i) => {
        const row = { fold: i + 1, summarySeq: f.seq, shadowedTokenCount: f.shadowedTokenCount, preview: f.preview }
        if (f.shadowedSeqs !== undefined) row.entries = f.shadowedSeqs.length
        if (f.shadowedStart !== undefined) row.shadowedStart = f.shadowedStart
        if (f.shadowedEnd !== undefined) row.shadowedEnd = f.shadowedEnd
        if (f.title !== undefined) row.title = f.title
        return row
      })
    }
  }
  if (q.seq !== undefined) {
    if (!Number.isInteger(q.seq)) return { ok: false, error: 'seq must be an integer event seq' }
    let archivedByFold
    for (let i = 0; i < folds.length; i += 1) {
      if (folds[i].shadowedSeqs !== undefined && folds[i].shadowedSeqs.indexOf(q.seq) !== -1) { archivedByFold = i + 1; break }
    }
    const event = bySeq.get(q.seq)
    if (archivedByFold === undefined && event === undefined) {
      return { ok: false, error: 'seq ' + q.seq + ' is neither in the event log nor archived by any fold' }
    }
    const limit = q.full === true ? RECALL_FULL_LIMIT : PREVIEW_LIMIT
    const entry = event === undefined ? { seq: q.seq, kind: 'missing', preview: '' } : digestOf(event, limit)
    const out = { ok: true, mode: 'seq', full: q.full === true, ...entry }
    if (archivedByFold !== undefined) out.archivedByFold = archivedByFold
    return out
  }

  // ── artifact modes: fold N, or an explicit seq range ────────────────────
  let seqs
  let target
  let title
  let cacheKey
  if (q.fold !== undefined) {
    if (!Number.isInteger(q.fold) || q.fold < 1 || q.fold > folds.length) {
      return { ok: false, error: 'invalid fold ' + String(q.fold) + ' (valid: 1..' + folds.length + ')' }
    }
    const f = folds[q.fold - 1]
    if (f.shadowedSeqs === undefined) {
      return { ok: false, error: 'fold #' + q.fold + ' (summary seq ' + f.seq + ') carries no shadowedSeqs; entry recall is unavailable for it' }
    }
    seqs = f.shadowedSeqs
    target = 'fold #' + q.fold
    if (f.title !== undefined) title = f.title
    cacheKey = 'fold:' + f.seq
  } else {
    if (!Number.isInteger(q.from) || !Number.isInteger(q.to) || q.from < 1 || q.to < q.from) {
      return { ok: false, error: 'invalid range: need integers with 1 <= from <= to' }
    }
    seqs = []
    for (let i = 0; i < folds.length; i += 1) {
      const f = folds[i]
      if (f.shadowedSeqs === undefined) continue
      for (const seq of f.shadowedSeqs) {
        if (seq >= q.from && seq <= q.to) seqs.push(seq)
      }
    }
    target = 'seqs ' + q.from + '..' + q.to
    cacheKey = 'range:' + q.from + ':' + q.to
  }

  let lines = cache !== undefined ? cache.get(cacheKey) : undefined
  if (lines === undefined) {
    lines = buildArtifactLines(list, seqs)
    if (cache !== undefined) cache.set(cacheKey, lines)
  }
  const totalLines = lines.length

  if (q.find !== undefined) {
    const needle = String(q.find).toLowerCase()
    const hits = []
    for (let i = 0; i < totalLines && hits.length < 30; i += 1) {
      if (lines[i].toLowerCase().indexOf(needle) !== -1) hits.push({ line: i + 1, text: lines[i].slice(0, 200) })
    }
    const find = { ok: true, mode: 'find', target, totalLines, query: String(q.find), hits, hint: 'read context around a hit with the artifact window (fromLine/toLine)' }
    if (title !== undefined) find.title = title
    return find
  }

  const fromLine = Number.isInteger(q.fromLine) && q.fromLine >= 1 ? q.fromLine : 1
  const span = Number.isInteger(q.toLine) && q.toLine >= fromLine
    ? Math.min(q.toLine - fromLine + 1, ARTIFACT_WINDOW_MAX)
    : ARTIFACT_WINDOW_DEFAULT
  const startIdx = Math.min(fromLine, totalLines + 1) - 1
  const endIdx = Math.min(startIdx + span, totalLines)
  const window = lines.slice(startIdx, endIdx)
  const artifact = {
    ok: true, mode: 'artifact', target, totalLines,
    fromLine: startIdx + 1, toLine: endIdx, lines: window,
    more: endIdx < totalLines
  }
  if (title !== undefined) artifact.title = title
  return artifact
}

export default {
  name: 'compact-stats',
  inject: ['tools'],
  apply(ctx) {
    // In-memory artifact cache (fold/range → line arrays). Artifacts are pure
    // functions of the append-only log — entries never go stale, so no
    // invalidation is needed. Survives restarts by rebuild, never on disk.
    const artifactCache = new Map()

    ctx.tools.register({
      name: 'compact_stats',
      description: 'Read-only compaction observability for THIS session: current surface length, every committed fold (position, estimated shadowed tokens, summary preview), and cumulative totals. Call it after a fold to see what compaction saved, or anytime to audit the fold history.',
      parameters: { type: 'object', properties: {} },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(args, value) {
          if (value.ok !== true) {
            return [{ type: 'text', text: 'compact_stats failed: ' + String(value.error === undefined ? 'unknown error' : value.error) }]
          }
          const lines = []
          lines.push('Surface: ' + value.surfaceLength + ' live nodes over ' + value.eventCount + ' events; folds: ' + value.totals.folds + ', shadowed tokens estimated: ' + value.totals.shadowedTokens + '.')
          for (const f of value.folds) {
            const where = f.shadowedStart !== undefined ? ' range ' + f.shadowedStart + '..' + f.shadowedEnd : ''
            const missing = f.shadowedTokenCountMissing === true ? ' (token count missing on this event)' : ''
            lines.push('#' + f.seq + where + ' → ' + f.shadowedTokenCount + ' tokens' + missing + ' | ' + (f.title !== undefined ? f.title : f.preview))
          }
          return [{ type: 'text', text: lines.join('\n') }]
        }
      },
      async execute(args, exec) {
        const agent = exec.agent
        if (agent === undefined) return { ok: false, error: 'compact_stats requires an agent context' }
        let session
        try {
          session = agent.session
          if (session === null || typeof session !== 'object') return { ok: false, error: 'no session on the agent context' }
        } catch (err) {
          return { ok: false, error: 'failed to read the session: ' + (err !== null && typeof err === 'object' && err.message ? String(err.message) : String(err)) }
        }
        try {
          const stats = collectStats(sessionEvents(session), session.surface.nodes.length)
          return { ok: true, ...stats }
        } catch (err) {
          return { ok: false, error: 'failed to scan the event log: ' + (err !== null && typeof err === 'object' && err.message ? String(err.message) : String(err)) }
        }
      }
    })

    ctx.tools.register({
      name: 'compact_recall',
      description: 'Read folded conversation history back, like a file. Fold summaries are terse by design — when one lacks detail you need, read the span\u0027s ARTIFACT: the original conversation (messages, tool calls with arguments, tool results) rendered as a line-numbered transcript. No args: index of all folds. fold=N (or from/to seqs, the exact range rides every fold output): open the artifact — first window of lines, then seek with fromLine/toLine, or search it with find:"text" (returns matching line numbers). seq=N: one raw entry in full detail. Artifacts live in memory and rebuild from the append-only log after restart — nothing is ever lost. Read-only.',
      parameters: {
        type: 'object',
        properties: {
          fold: { type: 'integer', description: 'Fold number (1-based, chronological) from the index listing.' },
          seq: { type: 'integer', description: 'Exact event seq of one archived entry (full-detail escape hatch).' },
          from: { type: 'integer', description: 'Range mode: first seq, inclusive (as given by fold outputs).' },
          to: { type: 'integer', description: 'Range mode: last seq, inclusive.' },
          fromLine: { type: 'integer', description: 'Artifact window: first line, 1-based (default 1).' },
          toLine: { type: 'integer', description: 'Artifact window: last line (window capped at 400 lines, default 100).' },
          find: { type: 'string', description: 'Search the artifact: returns matching line numbers and text.' },
          full: { type: 'boolean', description: 'seq mode: raise the text cap to 4000 chars (default preview is 60).' }
        }
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(args, value) {
          if (value.ok !== true) {
            return [{ type: 'text', text: 'compact_recall failed: ' + String(value.error === undefined ? 'unknown error' : value.error) }]
          }
          const lines = []
          if (value.mode === 'index') {
            lines.push('Folds: ' + value.folds.length + '. Open one with { fold: N } (artifact: seek fromLine/toLine, search find), or { seq: N } for one raw entry.')
            for (const f of value.folds) {
              const where = f.shadowedStart !== undefined ? ' seqs ' + f.shadowedStart + '..' + f.shadowedEnd : ''
              const entries = f.entries === undefined ? ' (no shadowedSeqs)' : ', ' + f.entries + ' entries'
              lines.push('fold #' + f.fold + ' (summary seq ' + f.summarySeq + '): ' + f.shadowedTokenCount + ' tokens' + where + entries + ' | ' + (f.title !== undefined ? f.title : f.preview))
            }
          } else if (value.mode === 'artifact') {
            const title = value.title === undefined ? '' : ' "' + value.title + '"'
            lines.push('artifact of ' + value.target + title + ' — lines ' + value.fromLine + '..' + value.toLine + ' of ' + value.totalLines + (value.more ? '; more below' : ' (end)') + ':')
            for (let i = 0; i < value.lines.length; i += 1) {
              lines.push('  ' + (value.fromLine + i) + '│ ' + value.lines[i])
            }
            if (value.more) lines.push('  … continue with { fold/from-to, fromLine: ' + (value.toLine + 1) + ' } ; search with { find: "…" }')
          } else if (value.mode === 'find') {
            const title = value.title === undefined ? '' : ' "' + value.title + '"'
            lines.push('search "' + value.query + '" in artifact of ' + value.target + title + ' (' + value.totalLines + ' lines): ' + value.hits.length + ' hit(s)' + (value.hits.length >= 30 ? ', capped at 30' : ''))
            for (const h of value.hits) {
              lines.push('  ' + h.line + '│ ' + h.text)
            }
            lines.push('  read around a hit with { fromLine: N, toLine: M }')
          } else if (value.mode === 'seq') {
            const where = value.archivedByFold === undefined ? 'not archived (live or non-surface event)' : 'archived by fold #' + value.archivedByFold
            const tools = value.toolNames !== undefined && value.toolNames.length > 0 ? ' calls:' + value.toolNames.join(',') : ''
            lines.push('seq ' + value.seq + ' ' + value.kind + tools + ' (' + where + (value.full ? ', full text' : '') + '):')
            lines.push('  ' + value.preview)
          }
          return [{ type: 'text', text: lines.join('\n') }]
        }
      },
      async execute(args, exec) {
        const agent = exec.agent
        if (agent === undefined) return { ok: false, error: 'compact_recall requires an agent context' }
        let session
        try {
          session = agent.session
          if (session === null || typeof session !== 'object') return { ok: false, error: 'no session on the agent context' }
        } catch (err) {
          return { ok: false, error: 'failed to read the session: ' + (err !== null && typeof err === 'object' && err.message ? String(err.message) : String(err)) }
        }
        try {
          return buildRecall(sessionEvents(session), args, artifactCache)
        } catch (err) {
          return { ok: false, error: 'failed to scan the event log: ' + (err !== null && typeof err === 'object' && err.message ? String(err.message) : String(err)) }
        }
      }
    })
  }
}
