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
 * Degradation is distinguishable, never silent: event types outside
 * KNOWN_EVENT_TYPES are reported in `unknownEventTypes` with a rendered
 * warning, so "no folds" and "could not look for folds" stay apart.
 *
 * Pure helpers are named exports so tests can exercise them without a host.
 */
export const PREVIEW_LIMIT = 60
export const RECALL_FULL_LIMIT = 4000

// Every event type observed across the DSH packages at the time of writing
// (see docs/design-compact-stats.md). Anything else in a stream is drift and
// gets surfaced, not ignored.
export const KNOWN_EVENT_TYPES = new Set([
  'agent-preset/selected', 'agent/inbox/spliced', 'approval/asked',
  'approval/decided', 'approval/policy', 'assistant/chunk', 'assistant/message',
  'compaction/end', 'compaction/prune', 'compaction/start', 'compaction/summary',
  'feedback/record', 'goal/change', 'hook/invoked', 'hook/result', 'llm/retry',
  'llm/retry-started', 'model/selection', 'permission/preset', 'plan/mode',
  'request/context', 'request/header', 'sandbox/mode', 'schedule/change',
  'session-log-deepseek/delivery-accepted', 'session/end-seed', 'session/title',
  'session/title-llm-request', 'step/end', 'step/start', 'subagent/descriptor',
  'subagent/model-selection-policy', 'task/mark', 'todo/write', 'tool/call',
  'tool/code-dispatch', 'tool/code-dispatch-start', 'tool/result', 'turn/end',
  'turn/start', 'user/message', 'web/deepseek-search-llm-request'
])

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
  const unknown = new Set()
  for (const event of list) {
    if (event === null || typeof event !== 'object' || typeof event.type !== 'string') continue
    if (event.type === 'compaction/summary') folds.push(foldOf(event))
    else if (!KNOWN_EVENT_TYPES.has(event.type)) unknown.add(event.type)
  }
  attachFoldTitles(folds, list)
  const shadowedTokens = folds.reduce((sum, f) => sum + f.shadowedTokenCount, 0)
  return {
    surfaceLength,
    eventCount: list.length,
    folds,
    totals: { folds: folds.length, shadowedTokens },
    unknownEventTypes: [...unknown].sort()
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
    return { seq, kind: toolCalls.length > 0 ? 'assistant/tool_call' : 'assistant/assistant', toolNames: names, preview: textOf(content, lim) }
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
 * Resolve a recall query against the log. Modes (pick exactly one):
 *   no args  → index of all folds
 *   { fold } → full manifest of one fold (seq → digest for every entry)
 *   { seq }  → single entry, wherever it lives
 *   { from, to } → every archived entry whose seq falls in the range
 * full:true raises the preview cap from PREVIEW_LIMIT to RECALL_FULL_LIMIT.
 */
export function buildRecall(events, args) {
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
  const full = q.full === true
  const limit = full ? RECALL_FULL_LIMIT : PREVIEW_LIMIT
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
  if (q.fold !== undefined) {
    if (!Number.isInteger(q.fold) || q.fold < 1 || q.fold > folds.length) {
      return { ok: false, error: 'invalid fold ' + String(q.fold) + ' (valid: 1..' + folds.length + ')' }
    }
    const f = folds[q.fold - 1]
    if (f.shadowedSeqs === undefined) {
      return { ok: false, error: 'fold #' + q.fold + ' (summary seq ' + f.seq + ') carries no shadowedSeqs; entry recall is unavailable for it' }
    }
    const entries = []
    for (const seq of f.shadowedSeqs) {
      const event = bySeq.get(seq)
      entries.push(event === undefined ? { seq, kind: 'missing', preview: '' } : digestOf(event, limit))
    }
    return { ok: true, mode: 'fold', fold: q.fold, summarySeq: f.seq, shadowedTokenCount: f.shadowedTokenCount, full, entries }
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
    const entry = event === undefined ? { seq: q.seq, kind: 'missing', preview: '' } : digestOf(event, limit)
    const out = { ok: true, mode: 'seq', full, ...entry }
    if (archivedByFold !== undefined) out.archivedByFold = archivedByFold
    return out
  }
  if (!Number.isInteger(q.from) || !Number.isInteger(q.to) || q.from < 1 || q.to < q.from) {
    return { ok: false, error: 'invalid range: need integers with 1 <= from <= to' }
  }
  const entries = []
  for (let i = 0; i < folds.length; i += 1) {
    const f = folds[i]
    if (f.shadowedSeqs === undefined) continue
    for (const seq of f.shadowedSeqs) {
      if (seq >= q.from && seq <= q.to) {
        const event = bySeq.get(seq)
        entries.push({ fold: i + 1, ...(event === undefined ? { seq, kind: 'missing', preview: '' } : digestOf(event, limit)) })
      }
    }
  }
  return { ok: true, mode: 'range', from: q.from, to: q.to, full, entries }
}

export default {
  name: 'compact-stats',
  inject: ['tools'],
  apply(ctx) {
    ctx.tools.register({
      name: 'compact_stats',
      description: 'Read-only compaction observability for THIS session: current surface length, every committed fold (position, estimated shadowed tokens, summary preview), cumulative totals, and any unknown event types that could hide folds. Call it after compact/task_end to see what compaction saved, or anytime to audit the fold history.',
      parameters: { type: 'object', properties: {} },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(args, value) {
          if (value.ok !== true) {
            return [{ type: 'text', text: 'compact_stats failed: ' + String(value.error === undefined ? 'unknown error' : value.error) }]
          }
          const lines = []
          lines.push('Surface: ' + value.surfaceLength + ' live nodes over ' + value.eventCount + ' events; folds: ' + value.totals.folds + ', shadowed tokens estimated: ' + value.totals.shadowedTokens + '.')
          if (value.unknownEventTypes !== undefined && value.unknownEventTypes.length > 0) {
            lines.push('WARNING: unknown event types present (' + value.unknownEventTypes.join(', ') + '); fold accounting may be incomplete.')
          }
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
      description: 'Recall the ORIGINAL content of folded conversation entries. Folds remove entries from the surface projection, but the append-only event log keeps them — this tool reads them back. Seqs are stable archive ids (surface positions shift after every fold; get seqs from compact_recall listings or compaction/summary ranges). No args: index of all folds. fold=N: manifest of that fold (seq → digest for every archived entry). seq=N: one entry in full detail. from/to: archived entries whose seq falls in the range. full=true raises the per-entry text cap from 60 to 4000 chars. Read-only.',
      parameters: {
        type: 'object',
        properties: {
          fold: { type: 'integer', description: 'Fold number (1-based, chronological) from the index listing.' },
          seq: { type: 'integer', description: 'Exact event seq of one archived entry.' },
          from: { type: 'integer', description: 'Range mode: first seq, inclusive.' },
          to: { type: 'integer', description: 'Range mode: last seq, inclusive.' },
          full: { type: 'boolean', description: 'Raise the per-entry text cap to 4000 chars (default preview is 60).' }
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
            lines.push('Folds: ' + value.folds.length + '. Use { fold: N } for a manifest, { seq: N } for one entry.')
            for (const f of value.folds) {
              const where = f.shadowedStart !== undefined ? ' seqs ' + f.shadowedStart + '..' + f.shadowedEnd : ''
              const entries = f.entries === undefined ? ' (no shadowedSeqs)' : ', ' + f.entries + ' entries'
              lines.push('fold #' + f.fold + ' (summary seq ' + f.summarySeq + '): ' + f.shadowedTokenCount + ' tokens' + where + entries + ' | ' + (f.title !== undefined ? f.title : f.preview))
            }
          } else if (value.mode === 'fold') {
            lines.push('fold #' + value.fold + ' (summary seq ' + value.summarySeq + ', ' + value.shadowedTokenCount + ' tokens, ' + value.entries.length + ' entries' + (value.full ? ', full text' : '') + '):')
            for (const e of value.entries) {
              const tools = e.toolNames !== undefined && e.toolNames.length > 0 ? ' calls:' + e.toolNames.join(',') : ''
              lines.push('  ' + e.seq + ' ' + e.kind + tools + ' ' + e.preview)
            }
          } else if (value.mode === 'seq') {
            const where = value.archivedByFold === undefined ? 'not archived (live or non-surface event)' : 'archived by fold #' + value.archivedByFold
            const tools = value.toolNames !== undefined && value.toolNames.length > 0 ? ' calls:' + value.toolNames.join(',') : ''
            lines.push('seq ' + value.seq + ' ' + value.kind + tools + ' (' + where + (value.full ? ', full text' : '') + '):')
            lines.push('  ' + value.preview)
          } else if (value.mode === 'range') {
            lines.push('archived entries with seq in ' + value.from + '..' + value.to + ': ' + value.entries.length + ' found' + (value.full ? ', full text' : '') + '.')
            for (const e of value.entries) {
              const tools = e.toolNames !== undefined && e.toolNames.length > 0 ? ' calls:' + e.toolNames.join(',') : ''
              lines.push('  ' + e.seq + ' [fold #' + e.fold + '] ' + e.kind + tools + ' ' + e.preview)
            }
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
          return buildRecall(sessionEvents(session), args)
        } catch (err) {
          return { ok: false, error: 'failed to scan the event log: ' + (err !== null && typeof err === 'object' && err.message ? String(err.message) : String(err)) }
        }
      }
    })
  }
}
