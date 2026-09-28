/**
 * User-configurable lower bounds for folding (issue #2): spans below the
 * configured floor close UNFOLDED — the drain settles them without ever
 * building the scoped engine, so no summarization call is billed for a
 * span too small to pay for itself. The floor counts TOKENS: a summary
 * call's cost scales with the span's token mass (input) against its
 * summary's token mass (output), so tokens — not node counts — are the
 * unit the pay-off question lives in. The count is a CJK-aware character
 * heuristic taken BEFORE any LLM work (a measured count would need the
 * very call it is trying to avoid); the engine's post-hoc
 * shadowedTokenCount stays the exact figure in fold bookkeeping.
 *
 * Settings arrive through the HOST SETTINGS PAGE, not environment
 * variables: the mounted row exports a Config schema (compact-region.mjs)
 * whose volatile `minSpanTokens` field the dsh-settings service renders as
 * a form keyed by the profile entry id, validates, and persists through
 * the active profile's Cordis patch — a live edit applies at the next
 * drain pass with no restart. The runtime hands `apply(ctx, config)` an
 * object whose volatile fields are reactive refs (`.get()`); the floor
 * is therefore re-read per pass, never cached at factory time.
 */

import { messageOf } from './events.mjs'

/**
 * Default floor: 2000 tokens — measured break-even (docs/fold-floor.md):
 * a summary call's fixed overhead (~800 output tokens for the title,
 * sections, and Fold archive footer) plus the output/input price ratio
 * makes smaller spans cost more than the context they save. Below the
 * floor a fold is a net loss; at the observed 1–8% compression the
 * 2000-token floor keeps every fold profitable with ~2x margin.
 */
export const DEFAULT_MIN_SPAN_TOKENS = 2000

/** Inclusive Config-schema bounds, mirrored by the Settings-card field spec. */
export const MIN_SPAN_TOKENS_MAX = 1000000

/**
 * CJK-weight code-unit ranges, checked by char code (a regex test per
 * character costs an order more on the 100 KB tool outputs this scans at
 * every pass). Covers CJK radicals through Hangul syllables and fullwidth
 * forms. Supplementary-plane Han (U+20000+) is NOT matched: its surrogate
 * pairs count as two "other" units, so rare ext-B text underestimates —
 * the safe direction (undercount settles unfolded: no wasted call, and
 * the content stays on the surface). The two rates below approximate
 * subword tokenizers' observed behavior on mixed coding-session text
 * (~0.75 token per CJK char, ~4 chars per token otherwise); calibration
 * against measured shadowedTokenCount values is free to revisit the
 * constants — the shape of the estimator does not change.
 */
const CJK_RANGES = [
  [0x2E80, 0x9FFF], // CJK radicals, kana, CJK unified ideographs
  [0xAC00, 0xD7AF], // Hangul syllables
  [0xF900, 0xFAFF], // CJK compatibility ideographs
  [0xFF00, 0xFFEF] // fullwidth forms, halfwidth kana
]
const CJK_TOKENS_PER_CHAR = 0.75
const OTHER_CHARS_PER_TOKEN = 4

/** True when one UTF-16 code unit falls in a CJK-weight range. */
function isCjkUnit(code) {
  for (const [lo, hi] of CJK_RANGES) {
    if (code >= lo && code <= hi) return true
  }
  return false
}

/**
 * Estimated token count of one text string. Pure, total, and cheap
 * (single pass, O(n)): this runs at every drain pass over every planned
 * region. Empty/absent text is 0 tokens.
 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  let cjk = 0
  for (let i = 0; i < text.length; i += 1) {
    if (isCjkUnit(text.charCodeAt(i))) cjk += 1
  }
  const other = text.length - cjk
  return Math.max(1, Math.round(cjk * CJK_TOKENS_PER_CHAR + other / OTHER_CHARS_PER_TOKEN))
}

/** The joined text of a tool-result block's nested text blocks ('' when none). */
function toolResultBlockText(block) {
  return Array.isArray(block.content)
    ? block.content.filter((b) => b !== null && typeof b === 'object' && typeof b.text === 'string').map((b) => b.text).join('\n')
    : ''
}

/** The estimated tokens carried by one message's content blocks. */
function messageTokenText(message) {
  if (message === null || typeof message !== 'object') return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (typeof block.text === 'string') {
      out += (out.length > 0 ? '\n' : '') + block.text
    } else if (block.type === 'tool-call') {
      let args = block.arguments
      if (typeof args === 'string') { /* keep as-is */ } else if (args !== null && typeof args === 'object') {
        try { args = JSON.stringify(args) } catch (err) { args = '' }
      } else { args = '' }
      if (typeof args === 'string' && args.length > 0) out += (out.length > 0 ? '\n' : '') + args
    } else if (block.type === 'tool-result') {
      // Legacy (v3) shape: the result's text nests INSIDE the block. The
      // flattened v4 shape (tool-role message, plain text blocks) is
      // covered by the branch above.
      const nested = toolResultBlockText(block)
      if (nested.length > 0) out += (out.length > 0 ? '\n' : '') + nested
    }
  }
  return out
}

/** The estimated tokens carried by one native event's message ('' events → 0). */
function eventTokens(event) {
  return estimateTokens(messageTokenText(messageOf(event)))
}

/** Read one config field that may be a reactive volatile ref or a plain value. */
function readField(field) {
  if (field !== null && typeof field === 'object' && typeof field.get === 'function') {
    try { return field.get() } catch (err) { return undefined }
  }
  return field
}

/**
 * The fold floor from the plugin's runtime config object (second apply()
 * argument). Pure and total: undefined config, a missing field, or an
 * invalid value (non-integer, negative, over the schema bound) all yield
 * the default — a bad edit must never disable folding outright or throw
 * at a step boundary. Volatile refs are unwrapped via .get() so live
 * settings edits apply without a plugin reload.
 */
export function foldFloorFromConfig(config) {
  const value = readField(config !== null && typeof config === 'object' ? config.minSpanTokens : undefined)
  if (Number.isInteger(value) && value >= 0 && value <= MIN_SPAN_TOKENS_MAX) return value
  return DEFAULT_MIN_SPAN_TOKENS
}

/**
 * Estimated tokens covered by a planned [startSeq..endSeq] region, by
 * POSITION (the surface is not seq-ordered — see deferredArchivePlan).
 * Every surface node in the inclusive range contributes its event
 * message's estimated tokens; events whose seq is unknown contribute 0
 * (the node exists — its size just cannot be read). Returns -1 when
 * either bound is not locatable: an unmeasurable span is never skipped
 * (the caller folds it), because the floor protects against WASTED
 * calls, not against folds themselves.
 */
export function spanTokenEstimate(nodes, events, startSeq, endSeq) {
  const list = Array.isArray(nodes) ? nodes : []
  const startPos = list.indexOf(startSeq)
  const endPos = list.indexOf(endSeq)
  if (startPos === -1 || endPos === -1 || endPos < startPos) return -1
  const bySeq = new Map()
  const log = Array.isArray(events) ? events : []
  for (const event of log) {
    if (event !== null && typeof event === 'object' && Number.isInteger(event.seq)) {
      bySeq.set(event.seq, event)
    }
  }
  let total = 0
  for (let i = startPos; i <= endPos; i += 1) {
    const event = bySeq.get(list[i])
    if (event !== undefined) total += eventTokens(event)
  }
  return total
}

/**
 * Verdict for a planned fold: true when the region sits below the
 * configured floor and must close unfolded (settle, zero LLM). False for
 * every other shape — floor 0, unmeasurable span, or a big-enough region.
 */
export function belowFoldFloor(plan, nodes, settings, events) {
  if (plan === null || typeof plan !== 'object' || plan.action !== 'fold') return false
  const min = settings !== null && typeof settings === 'object' && Number.isInteger(settings.minSpanTokens)
    ? settings.minSpanTokens
    : DEFAULT_MIN_SPAN_TOKENS
  if (min <= 0) return false
  const tokens = spanTokenEstimate(nodes, events, plan.startSeq, plan.endSeq)
  if (tokens < 0) return false
  return tokens < min
}
