// Standalone lifecycle-notice injection for the taskfold bundle.
//
// The nudges USED to ride the host's runtime-context snapshot as a
// `ctx.systemPrompt.context()` contribution. That worked, but the snapshot
// is assembled as ONE message from ALL active contributions, so every nudge
// change re-emitted `sandbox:policy` + `approval:policy` (≈1.2k tokens) with
// it — and the section was misnamed `todo-bridge` for what is really the
// whole task-lifecycle channel.
//
// This module publishes the same notices through the channel the host's own
// `dsh-tool-skill` uses: a plugin-authored `user/message` appended by the
// agent loop, carrying `source.kind = 'task-marks:lifecycle'`. One message
// type only — the CURRENT state, prefixed with a supersession line — so
// there is no separate "retraction" kind: the next notice voids the previous
// one, exactly like `This complete catalog replaces every earlier
// available-skills list in this session`, including its empty variant
// ("No skills are currently available … Do not use names from earlier skill
// catalogs"). The empty state is therefore a REAL state and is published
// once when every condition clears; without it the last notice would stay
// in context and keep commanding the model.
//
// Kept dependency-free apart from events.mjs (plain module, no bundle row).
import { randomUUID } from 'node:crypto'
import { messageOf, blocksOf } from './events.mjs'

/** Source kind stamped on every notice this module publishes. */
export const LIFECYCLE_SOURCE_KIND = 'task-marks:lifecycle'

/**
 * The published form of "no condition holds". It is a state, not a
 * retraction: it says what is true now and tells the model not to act on
 * earlier notices.
 */
export const EMPTY_LIFECYCLE_BODY = 'No task-lifecycle notices apply right now. Do not act on earlier task-lifecycle notices.'

/** Join the live nudge lines into the notice body (empty → empty state). */
export function renderLifecycleBody(lines) {
  const kept = (Array.isArray(lines) ? lines : []).filter((line) => typeof line === 'string' && line.trim().length > 0)
  return kept.length === 0 ? EMPTY_LIFECYCLE_BODY : kept.join('\n')
}

/**
 * Frame one state body as the model-facing message text. The header states
 * the supersession rule once, so the message is self-contained: the model
 * never has to remember which earlier notices are still live.
 */
export function lifecycleNoticeText(body) {
  return [
    '<system-reminder>',
    'Task lifecycle notices changed. This notice replaces every earlier task-lifecycle notice in this session:',
    '',
    '<task_lifecycle>',
    typeof body === 'string' && body.trim().length > 0 ? body : EMPTY_LIFECYCLE_BODY,
    '</task_lifecycle>',
    '</system-reminder>'
  ].join('\n')
}

/**
 * The text of the newest already-published notice, or null. Reads the same
 * defensive shapes every other reader uses, plus the injected-message shape
 * (`event.data` IS the message: {id, role, content, source}) that the agent
 * loop appends for plugin-authored messages.
 */
export function publishedLifecycleNotice(events) {
  const list = Array.isArray(events) ? events : []
  for (let i = list.length - 1; i >= 0; i--) {
    const event = list[i]
    if (event === null || typeof event !== 'object' || event.type !== 'user/message') continue
    const data = event.data !== null && typeof event.data === 'object' ? event.data : null
    if (data === null) continue
    const source = data.source !== null && typeof data.source === 'object' ? data.source : null
    if (source === null || source.kind !== LIFECYCLE_SOURCE_KIND) continue
    const message = messageOf(event) !== null ? messageOf(event) : data
    const text = blocksOf(message)
      .filter((b) => b !== null && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
    return text.length > 0 ? text : null
  }
  return null
}

/**
 * Two-state plan: publish iff the rendered text differs from what is already
 * on the surface. The digest is the WHOLE text, so a restart (or a fold that
 * removed the notice) republishes correctly, and an unchanged render emits
 * nothing — the guard that keeps this channel from appending a message every
 * single step.
 */
export function planLifecycleInjection(text, published) {
  return text === published ? 'none' : 'publish'
}

/**
 * The user/message the agent loop will append for this state BODY. Framing
 * happens here so a caller cannot publish an unframed body by mistake; the
 * framed text is what `lifecycleNoticeText()` produces for the digest check.
 */
export function lifecycleMessage(body) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: lifecycleNoticeText(body) }],
    source: { kind: LIFECYCLE_SOURCE_KIND, form: 'state' }
  }
}
