// Event-only lifecycle hints for the taskfold bundle.
//
// The nudges USED to ride the host's runtime-context snapshot as a
// `ctx.systemPrompt.context()` contribution. That snapshot is ONE message
// assembled from every active contribution, so each nudge change re-emitted
// `sandbox:policy` + `approval:policy` (≈1.2k tokens) with it. This module
// publishes the same hints through the channel the host's own `dsh-tool-skill`
// uses: a plugin-authored `user/message` appended by the agent loop, carrying
// `source.kind = 'task-marks:lifecycle'`.
//
// A hint is an EVENT, not a state display. It carries no frame, no
// supersession header and no "nothing applies right now" counterpart: once the
// model has complied (opened the task, closed the task), it knows the hint is
// spent, so republishing an empty state would only spend tokens restating what
// the model already did. Publication is governed by a per-session latch of the
// last hint text (planLifecycleInjection): a hint publishes when its text
// differs from the live one, and the latch RESETS the moment the condition
// clears, so the same hint can legitimately reappear later.
//
// Kept dependency-free (plain module, no bundle row).
import { randomUUID } from 'node:crypto'

/** Source kind stamped on every hint this module publishes. */
export const LIFECYCLE_SOURCE_KIND = 'task-marks:lifecycle'

/**
 * Join the live hint lines, or null when nothing applies. Null is NOT a
 * publishable body: the absence of a hint is published as nothing at all.
 */
export function renderLifecycleBody(lines) {
  const kept = (Array.isArray(lines) ? lines : []).filter((line) => typeof line === 'string' && line.trim().length > 0)
  return kept.length === 0 ? null : kept.join('\n')
}

/**
 * The whole publication rule, as a pure function of (body, lastPublished).
 * Returns the decision plus the latch value the caller must store:
 *   body === null          -> nothing to say; CLEAR the latch, so a later
 *                             recurrence of the same hint publishes again.
 *   body === lastPublished -> the live hint is already on the surface.
 *   otherwise              -> publish, and remember this exact text.
 */
export function planLifecycleInjection(body, lastPublished) {
  if (body === null) return { publish: false, last: null }
  if (body === lastPublished) return { publish: false, last: lastPublished }
  return { publish: true, last: body }
}

/**
 * The user/message the agent loop appends for one hint. The text IS the hint
 * body — no <system-reminder> wrapper, no <task_lifecycle> tag, no supersession
 * header: the hint lines already say what they are ("Task lifecycle: …").
 */
export function lifecycleMessage(body) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: body }],
    source: { kind: LIFECYCLE_SOURCE_KIND, form: 'hint' }
  }
}
