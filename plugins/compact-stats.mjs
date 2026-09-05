/**
 * list_folds / fold_recall — fold index and artifact regeneration tools
 * (plugin-bundle form, sibling of compact-region).
 *
 * Read-only companion to compact-region: reports what compaction did for THIS
 * session by scanning the live event log (sessionEvents accessor), and
 * recalls the ORIGINAL content of folded entries on demand. Events survive
 * folds — the surface is a projection — so nothing is ever lost, only
 * projected away. Seqs are stable archive ids (surface positions shift).
 *
 * Fold NUMBERING is chronological (1-based, order of collectFolds): the
 * number list_folds prints is exactly the number fold_recall({ fold: N })
 * consumes and exactly what task_fold's "Folded #N" counts. The event-log
 * seq is shown as a secondary annotation only — never pass it to fold_recall.
 */
// Shared span-preview/JSONL helpers: regenerated artifacts keep the exact
// format (JSONL, one message per line) and numbering that task_fold's
// preview lines use.
import { renderSpanPreview, writeSpanArtifact, sessionArtifactDir } from './span-preview.mjs'

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
  // v9 deferred folds commit OUTSIDE the task_fold call/result window, so
  // the in-flight-call correlation misses them. Fallback title source: the
  // summary's own first heading line ('# <task name>') — the scoped
  // summarizer's closing instruction forces exactly that heading.
  const heading = firstHeadingLine(data.summary)
  if (heading !== '') record.titleFallback = heading
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

/** '# <name>' heading from a summary's first text block, '' when absent. */
function firstHeadingLine(summary) {
  if (!Array.isArray(summary)) return ''
  for (const block of summary) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      const line = block.text.split('\n').map((l) => l.trim()).find((l) => l.length > 0)
      if (line === undefined) return ''
      if (line.startsWith('# ') && !line.startsWith('## ')) return line.slice(2).trim()
      return ''
    }
  }
  return ''
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

/**
 * The `name` argument of one task_fold tool-call block, normalized — the
 * structured home of the fold title. Arguments may be a JSON string or an
 * already-parsed object depending on log provenance; both are accepted.
 */
function foldNameOfCall(block) {
  let args = block.arguments
  if (typeof args === 'string') { try { args = JSON.parse(args) } catch (err) { return '' } }
  if (args === null || typeof args !== 'object') return ''
  return typeof args.name === 'string' ? args.name.replace(/\s+/g, ' ').trim() : ''
}

/**
 * Attach task_fold titles to their folds, single linear pass. Correlation is
 * temporal and exact: an INLINE fold's compaction/summary is appended between
 * its task_fold CALL and its RESULT (the engine commits during execute), so
 * the in-flight task_fold call at summary time is that fold's owner — the
 * name comes straight from its `arguments`, no rendered-text parsing. A
 * failed fold never gets a summary while its call is in flight, so it cannot
 * mislabel; auto-compaction folds between steps see no in-flight call and
 * stay untitled. v9 DEFERRED folds commit at a step boundary, long past the
 * call/result window — the in-flight path misses them, so after the pass
 * every untitled fold falls back to its summary's '# <name>' heading line
 * (titleFallback, forced by the scoped summarizer's closing instruction).
 * Mutates and returns `folds`.
 */
export function attachFoldTitles(folds, events) {
  const list = Array.isArray(events) ? events : []
  const pending = new Map() // callId → name, task_fold calls awaiting their result
  let foldIdx = 0
  for (const event of list) {
    if (event === null || typeof event !== 'object' || typeof event.type !== 'string') continue
    if (event.type === 'compaction/summary') {
      if (foldIdx < folds.length && folds[foldIdx].title === undefined && pending.size > 0) {
        folds[foldIdx].title = [...pending.values()][pending.size - 1]
      }
      foldIdx += 1
      continue
    }
    const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
    const message = data.message !== null && typeof data.message === 'object' ? data.message : null
    const content = message !== null && Array.isArray(message.content) ? message.content : []
    if (event.type === 'assistant/message') {
      for (const block of content) {
        if (block !== null && typeof block === 'object' && block.type === 'tool-call' && block.name === 'task_fold' && typeof block.id === 'string') {
          const name = foldNameOfCall(block)
          if (name.length > 0) pending.set(block.id, name)
        }
      }
    } else if (event.type === 'tool/result') {
      for (const block of content) {
        if (block !== null && typeof block === 'object' && block.type === 'tool-result' && typeof block.toolCallId === 'string') {
          pending.delete(block.toolCallId)
        }
      }
    }
  }
  // Deferred-fold fallback: untitled folds take their summary heading.
  for (const fold of folds) {
    if (fold.title === undefined && typeof fold.titleFallback === 'string' && fold.titleFallback.length > 0) {
      fold.title = fold.titleFallback
    }
  }
  return folds
}

/**
 * list_folds render lines from a collectStats() value — pure, so tests can
 * pin the numbering contract: line i carries '#' + (i+1), the SAME 1-based
 * chronological index fold_recall({ fold }) validates and task_fold counts.
 * The event seq appears only as a parenthesized annotation.
 */
export function renderFoldList(stats) {
  const lines = []
  const surfaceLength = stats !== null && typeof stats === 'object' && Number.isInteger(stats.surfaceLength) ? stats.surfaceLength : 0
  const eventCount = stats !== null && typeof stats === 'object' && Number.isInteger(stats.eventCount) ? stats.eventCount : 0
  const totals = stats !== null && typeof stats === 'object' && stats.totals !== null && typeof stats.totals === 'object' ? stats.totals : { folds: 0, shadowedTokens: 0 }
  const folds = stats !== null && typeof stats === 'object' && Array.isArray(stats.folds) ? stats.folds : []
  lines.push('Surface: ' + surfaceLength + ' live nodes over ' + eventCount + ' events; folds: ' + totals.folds + ', shadowed tokens estimated: ' + totals.shadowedTokens + '.')
  for (let i = 0; i < folds.length; i += 1) {
    const f = folds[i]
    const where = f.shadowedStart !== undefined ? ' range ' + f.shadowedStart + '..' + f.shadowedEnd : ''
    const missing = f.shadowedTokenCountMissing === true ? ' (token count missing on this event)' : ''
    lines.push('#' + (i + 1) + ' (seq ' + f.seq + ')' + where + ' → ' + f.shadowedTokenCount + ' tokens' + missing + ' | ' + (f.title !== undefined ? f.title : f.preview))
  }
  return lines
}

export default {
  name: 'compact-stats',  inject: ['tools'],
  apply(ctx) {
    ctx.tools.register({
      name: 'list_folds',
      description: 'List every committed fold in THIS session: fold number (1-based, chronological — the exact number fold_recall consumes), estimated shadowed tokens, summary preview or task title, plus surface/event totals. The seq shown in parentheses is an archive id, not the fold number. Call this when you need to regenerate an artifact or audit what compaction saved.',
      parameters: { type: 'object', properties: {} },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(args, value) {
          if (value.ok !== true) {
            return [{ type: 'text', text: 'list_folds failed: ' + String(value.error === undefined ? 'unknown error' : value.error) }]
          }
          return [{ type: 'text', text: renderFoldList(value).join('\n') }]
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
      name: 'fold_recall',
      description: 'Regenerate the artifact FILE for one fold: every span message from the \u0027Task begun\u0027 result through the \u0027Task ended\u0027 result — full original content (role + content blocks) — written as JSONL into this session\u0027s own artifact directory (the session\u0027s durable directory; OS tmp as fallback), one message per line, numbered. Each committed fold summary\u0027s trailing Fold archive section carries the artifact path; use this tool when that file has since been removed — pass the fold number, get a fresh file path plus a per-message preview, then read/grep it with any file tool. Use list_folds for the fold index. Changes no session state; the only write is the fresh JSONL file itself.',
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
            return [{ type: 'text', text: 'fold_recall failed: ' + String(value.error === undefined ? 'unknown error' : value.error) }]
          }
          return [{ type: 'text', text: 'Artifact regenerated (' + value.entries + ' messages): ' + value.file + (Array.isArray(value.preview) && value.preview.length > 0 ? '\n' + value.preview.join('\n') : '') + '\nRead or grep it with any file tool.' }]
        }
      },
      async execute(args, exec) {
        const agent = exec.agent
        if (agent === undefined) return { ok: false, error: 'fold_recall requires an agent context' }
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
          const file = writeSpanArtifact(messages, nameKey, { sessionDir: sessionArtifactDir(ctx, session), sessionKey: session.id })
          if (file === undefined) return { ok: false, error: 'failed to write the JSONL artifact (session dir or tmp fallback)' }
          const preview = renderSpanPreview(messages)
          return { ok: true, fold: foldNo, entries: messages.length, file, preview }
        } catch (err) {
          return { ok: false, error: 'failed to regenerate: ' + (err !== null && typeof err === 'object' && err.message ? String(err.message) : String(err)) }
        }
      }
    })
  }
}