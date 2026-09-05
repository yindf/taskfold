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
 * Joined text of every tool-result block in a 'tool/result' event — the
 * event-level view of toolResultText (blocks joined with '\n', empty
 * fragments skipped).
 */
export function taskResultEventText(event) {
  if (event === null || typeof event !== 'object' || event.type !== 'tool/result') return ''
  let out = ''
  for (const block of blocksOf(messageOf(event))) {
    if (block === null || typeof block !== 'object' || block.type !== 'tool-result') continue
    const text = toolResultText(block)
    if (text.length > 0) out += (out.length > 0 ? '\n' : '') + text
  }
  return out
}
