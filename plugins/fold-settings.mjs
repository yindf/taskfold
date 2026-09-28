/**
 * User-configurable lower bounds for folding (issue #2): spans below the
 * configured floor close UNFOLDED — the drain settles them without ever
 * building the scoped engine, so no summarization call is billed for a
 * span too small to pay for itself. The floor counts SURFACE NODES in
 * the planned region (assistant/user messages plus tool results — the
 * same units the span preview numbers), because that is the only size
 * measurable BEFORE any LLM work; a token-based bound would need the
 * very call it is trying to avoid.
 *
 * Settings arrive through the HOST SETTINGS PAGE, not environment
 * variables: the mounted row exports a Config schema (compact-region.mjs)
 * whose volatile `minSpanNodes` field the dsh-settings service renders as
 * a form keyed by the profile entry id, validates, and persists through
 * the active profile's Cordis patch — a live edit applies at the next
 * drain pass with no restart. The runtime hands `apply(ctx, config)` an
 * object whose volatile fields are reactive refs (`.get()`); the floor
 * is therefore re-read per pass, never cached at factory time.
 */

/** Default floor: 0 — every planned region folds (legacy behavior). */
export const DEFAULT_MIN_SPAN_NODES = 0

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
 * invalid value (non-integer, negative) all yield the default — a bad
 * edit must never disable folding outright or throw at a step boundary.
 * Volatile refs are unwrapped via .get() so live settings edits apply
 * without a plugin reload.
 */
export function foldFloorFromConfig(config) {
  const value = readField(config !== null && typeof config === 'object' ? config.minSpanNodes : undefined)
  if (Number.isInteger(value) && value >= 0 && value <= 100000) return value
  return DEFAULT_MIN_SPAN_NODES
}

/**
 * Surface nodes covered by a planned [startSeq..endSeq] region, by
 * POSITION (the surface is not seq-ordered — see deferredArchivePlan).
 * Returns -1 when either bound is not locatable: an unmeasurable span is
 * never skipped (the caller folds it), because the floor protects
 * against WASTED calls, not against folds themselves.
 */
export function spanNodeCount(nodes, startSeq, endSeq) {
  const list = Array.isArray(nodes) ? nodes : []
  const startPos = list.indexOf(startSeq)
  const endPos = list.indexOf(endSeq)
  if (startPos === -1 || endPos === -1 || endPos < startPos) return -1
  return endPos - startPos + 1
}

/**
 * Verdict for a planned fold: true when the region sits below the
 * configured floor and must close unfolded (settle, zero LLM). False for
 * every other shape — floor 0, unmeasurable span, or a big-enough region.
 */
export function belowFoldFloor(plan, nodes, settings) {
  if (plan === null || typeof plan !== 'object' || plan.action !== 'fold') return false
  const min = settings !== null && typeof settings === 'object' && Number.isInteger(settings.minSpanNodes)
    ? settings.minSpanNodes
    : DEFAULT_MIN_SPAN_NODES
  if (min <= 0) return false
  const count = spanNodeCount(nodes, plan.startSeq, plan.endSeq)
  if (count < 0) return false
  return count < min
}
