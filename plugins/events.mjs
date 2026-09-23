// Shared native-event helpers for the taskfold bundle.
//
// Every consumer of the harness event log — the taskMarks projection, the
// fold engine's bookkeeping, the lifecycle nudges, the recall tools — reads
// the same shapes (`event.data.message.content` blocks) and every reader
// must stay defensive against malformed or legacy rows. One home for those
// extractions, so the defensive idioms can never drift apart between
// consumers.
//
// Kept dependency-free (node builtins only) so both bundle plugins can
// import it without touching the bundle patch — it is a plain module, not
// a row (same contract as span-preview.mjs).

/**
 * Cross-version event-log accessor: dsh ≤0.1.2-alpha.3 exposed the whole log
 * as session.events (array); alpha.4 replaced it with on-demand APIs —
 * session.snapshotEvents() returns a full array snapshot. Support both.
 *
 * Callers that need the snapshot more than once should call this ONE time
 * and pass the array around: snapshotting is O(n) per call.
 */
export function sessionEvents(session) {
  if (session === undefined || session === null) return []
  if (Array.isArray(session.events)) return session.events
  if (typeof session.snapshotEvents === 'function') {
    try { return session.snapshotEvents() } catch (err) { return [] }
  }
  return []
}

/** The event's `data.message` object, or null — never throws, never partial. */
export function messageOf(event) {
  const data = event !== null && typeof event === 'object' && event.data !== null && typeof event.data === 'object' ? event.data : null
  return data !== null && data.message !== null && typeof data.message === 'object' ? data.message : null
}

/** A message's content blocks as an array (empty when absent or malformed). */
export function blocksOf(message) {
  return message !== null && Array.isArray(message.content) ? message.content : []
}

function isTextBlock(block) {
  return block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string'
}

/** Joined text ('\n' between fragments) of a message's plain text blocks. */
function textBlocksText(message) {
  return Array.isArray(message.content) ? message.content.filter(isTextBlock).map((b) => b.text).join('\n') : ''
}

/**
 * Joined text ('\n' between fragments) of a tool-result block's inner text
 * blocks. This is the exact extraction every lifecycle-text reader uses —
 * the reducer's 'Task begun: '/'Task ended: ' prefix matches, the deferred
 * plan's begun-result scan, the fold-aging nudge — so render→parse stays
 * byte-identical across all of them.
 */
export function toolResultText(block) {
  if (block === null || typeof block !== 'object' || block.type !== 'tool-result') return ''
  return Array.isArray(block.content) ? block.content.filter(isTextBlock).map((b) => b.text).join('\n') : ''
}

/**
 * The results one 'tool/result' event carries, in EVERY event grammar:
 *  - v4 (dsh 0.1.7-alpha.1, SESSION_FORMAT_VERSION 4): the message itself is
 *    tool-role — linkage is a MESSAGE-LEVEL `toolCallId` (+ `isError`) and
 *    `content` holds plain text blocks. One result per event.
 *  - v3 and older (and any pre-migration log): linkage lives in
 *    `tool-result` BLOCKS, one `toolCallId` each, nested text inside.
 * The host migrates v3 logs to the flattened shape when a session resumes,
 * so a live host only ever produces v4 — but replaying a captured v3 log
 * (offline tests, verify-cache fixtures) must keep parsing.
 *  - RESUME-DERIVED events (0.35.1, live on dsh 0.1.7-alpha.2): a session
 *    re-opened after a restart feeds its projections events re-derived
 *    through the resume path, and there the tool-role message can lose the
 *    message-level `toolCallId` flatten while KEEPING `source.callId` (the
 *    linkage the flatten was generated FROM). Without the fallback every
 *    mark call/result pair failed to pair on resume — the task dock then
 *    showed one stuck 'opening…'/'closing…' row per call ever made (live:
 *    19 rows on one session, 40 on another; the poisoned state also
 *    checkpointed itself back into the projection cache). `source.callId`
 *    is accepted only for `source.kind === 'tool'`, so an unrelated
 *    source-bearing message can never masquerade as a result.
 * Returns [{ callId, text, isError }]; defensive against malformed rows.
 */
export function toolResultEntries(event) {
  if (event === null || typeof event !== 'object' || event.type !== 'tool/result') return []
  const message = messageOf(event)
  if (message === null) return []
  if (typeof message.toolCallId === 'string') {
    return [{ callId: message.toolCallId, text: textBlocksText(message), isError: message.isError === true }]
  }
  if (message.source !== null && typeof message.source === 'object' && message.source.kind === 'tool' && typeof message.source.callId === 'string') {
    return [{ callId: message.source.callId, text: textBlocksText(message), isError: message.isError === true }]
  }
  const out = []
  for (const block of blocksOf(message)) {
    if (block === null || typeof block !== 'object' || block.type !== 'tool-result') continue
    if (typeof block.toolCallId !== 'string') continue
    out.push({ callId: block.toolCallId, text: toolResultText(block), isError: block.isError === true })
  }
  return out
}

/**
 * Joined text of every result in a 'tool/result' event — the event-level
 * view of toolResultText (entries joined with '\n', empty fragments
 * skipped). Shape-independent through toolResultEntries.
 */
export function taskResultEventText(event) {
  let out = ''
  for (const entry of toolResultEntries(event)) {
    if (entry.text.length > 0) out += (out.length > 0 ? '\n' : '') + entry.text
  }
  return out
}
