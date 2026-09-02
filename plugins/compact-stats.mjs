/**
 * list_folds / compact_recall — fold index and artifact regeneration tools
 * (preset plugin).
 *
 * Read-only companion to compact-region: reports what compaction did for THIS
 * session by scanning the live event log (exec.agent.session.events), and
 * recalls the ORIGINAL content of folded entries on demand. Events survive
 * folds — the surface is a projection — so nothing is ever lost, only
 * projected away. Seqs are stable archive ids (surface positions shift).
 * `save: true` materializes an artifact as a FILE under the session
 * workspace (.cmpct-artifacts/) so the model can read/grep/edit it with any
 * tool — recall stops being the only interface to folded history.
 */
import nodeFs from 'node:fs'
import nodePath from 'node:path'
import nodeOs from 'node:os'

/**
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
  const folds = collectFolds(events)
  const shadowedTokens = folds.reduce((sum, f) => sum + f.shadowedTokenCount, 0)
  return {
    surfaceLength,
    eventCount: Array.isArray(events) ? events.length : 0,
    folds,
    totals: { folds: folds.length, shadowedTokens }
  }
}

/** Fold list (oldest first) with titles — shared by stats and recall. */
export function collectFolds(events) {
  const list = Array.isArray(events) ? events : []
  const folds = []
  for (const event of list) {
    if (event === null || typeof event !== 'object' || typeof event.type !== 'string') continue
    if (event.type === 'compaction/summary') folds.push(foldOf(event))
  }
  attachFoldTitles(folds, list)
  return folds
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
 * Extract the fold label a task_fold result carries: 'Task folded: NAME — …'.
 * Older folds fall back to a 'Title: <name>' line. Returns undefined for
 * every other result.
 */
export function taskEndTitleOf(event) {
  if (event === null || typeof event !== 'object' || event.type !== 'tool/result') return undefined
  const text = resultTextOf(event)
  if (!text.startsWith('Task folded')) return undefined
  // name immediately after the prefix, terminated by ' —'.
  const named = /^Task folded: (.+?)(?: —|$)/.exec(text)
  if (named !== null) {
    const name = named[1].replace(/\s+/g, ' ').trim()
    if (name.length > 0) return name
  }
  // legacy: explicit 'Title: <name>' line.
  const titled = /^Title: (.+)$/m.exec(text)
  return titled === null ? undefined : titled[1].replace(/\s+/g, ' ').trim()
}

/**
 * Attach task_fold titles to their folds: the titled fold result labels the
 * most recent `compaction/summary` before it. Folds without a titled result
 * stay untitled. Mutates and returns `folds`.
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

export default {
  name: 'compact-stats',
  inject: ['tools'],
  apply(ctx) {
    ctx.tools.register({
      name: 'list_folds',
      description: 'List every committed fold in THIS session: fold number, estimated shadowed tokens, summary preview or task title, plus surface/event totals. Fold numbers are what compact_recall({ fold: N }) consumes; call this when you need to regenerate an artifact or audit what compaction saved.',
      parameters: { type: 'object', properties: {} },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(args, value) {
          if (value.ok !== true) {
            return [{ type: 'text', text: 'list_folds failed: ' + String(value.error === undefined ? 'unknown error' : value.error) }]
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
        if (agent === undefined) return { ok: false, error: 'list_folds requires an agent context' }
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
      description: 'Regenerate the artifact FILE for one fold: the span\u0027s EXACT original request context (the same messages the model was sent), written as JSON to the OS temp dir. Fold outputs carry the artifact path when the fold commits — this tool exists for when that temp file has been cleaned: pass the fold number, get a fresh file path, then read/grep it with any file tool. Use list_folds for the fold index. Read-only against the session; one file write to tmp.',
      parameters: {
        type: 'object',
        properties: {
          fold: { type: 'integer', description: 'Fold number (1-based, chronological) from list_folds.' }
        },
        required: ['fold']
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(args, value) {
          if (value.ok !== true) {
            return [{ type: 'text', text: 'compact_recall failed: ' + String(value.error === undefined ? 'unknown error' : value.error) }]
          }
          return [{ type: 'text', text: 'Artifact regenerated (' + value.entries + ' messages): ' + value.file + '\nRead or grep it with any file tool.' }]
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
        const foldNo = args !== null && typeof args === 'object' ? args.fold : undefined
        if (!Number.isInteger(foldNo)) return { ok: false, error: 'pass fold: N (1-based; see list_folds for the index)' }
        try {
          const folds = collectFolds(sessionEvents(session))
          if (foldNo < 1 || foldNo > folds.length) return { ok: false, error: 'invalid fold ' + foldNo + ' (valid: 1..' + folds.length + ')' }
          const f = folds[foldNo - 1]
          if (f.shadowedSeqs === undefined) return { ok: false, error: 'fold #' + foldNo + ' carries no shadowedSeqs; regeneration unavailable for it' }
          if (typeof session.deriveEventMessage !== 'function' || typeof session.eventAt !== 'function') {
            return { ok: false, error: 'this dsh version does not expose deriveEventMessage/eventAt; cannot regenerate exact context' }
          }
          const messages = []
          for (const seq of f.shadowedSeqs) {
            const message = session.deriveEventMessage(session.eventAt(seq))
            if (message !== null && message !== undefined) messages.push(message)
          }
          const nameKey = f.title !== undefined ? f.title : 'fold-' + foldNo
          const slug = String(nameKey).replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60)
          const dir = nodePath.join(nodeOs.tmpdir(), 'cmpct-artifacts')
          nodeFs.mkdirSync(dir, { recursive: true })
          const file = nodePath.join(dir, (slug.length > 0 ? slug : 'artifact') + '-' + Date.now().toString(36) + '.json')
          nodeFs.writeFileSync(file, JSON.stringify(messages, null, 2) + '\n', 'utf8')
          return { ok: true, fold: foldNo, entries: messages.length, file }
        } catch (err) {
          return { ok: false, error: 'failed to regenerate: ' + (err !== null && typeof err === 'object' && err.message ? String(err.message) : String(err)) }
        }
      }
    })
  }
}