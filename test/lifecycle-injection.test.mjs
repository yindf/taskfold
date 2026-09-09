// The standalone lifecycle-notice channel: one state message per change,
// superseded by the next one. These tests pin the two properties the channel
// must never lose — a notice is published ONLY when the rendered state
// changes (otherwise the agent loop appends a message every step), and the
// empty state is itself publishable (otherwise the last notice would stay in
// context and keep commanding the model).
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  LIFECYCLE_SOURCE_KIND,
  EMPTY_LIFECYCLE_BODY,
  renderLifecycleBody,
  lifecycleNoticeText,
  publishedLifecycleNotice,
  planLifecycleInjection,
  lifecycleMessage
} from '../plugins/lifecycle-injection.mjs'

const injected = (seq, message) => ({ seq, type: 'user/message', data: message })
const userText = (seq, text) => injected(seq, { id: 'u' + seq, role: 'user', content: [{ type: 'text', text }] })
const assistant = (seq) => ({ seq, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'step' }] } } })

test('renderLifecycleBody: lines join, blanks drop, nothing becomes the empty state', () => {
  assert.equal(renderLifecycleBody(['a', 'b']), 'a\nb')
  assert.equal(renderLifecycleBody(['a', '', '   ', 'b']), 'a\nb')
  assert.equal(renderLifecycleBody([]), EMPTY_LIFECYCLE_BODY)
  assert.equal(renderLifecycleBody(null), EMPTY_LIFECYCLE_BODY)
})

test('lifecycleNoticeText: supersession header, framed body, empty state included', () => {
  const text = lifecycleNoticeText('Task lifecycle: close it.')
  assert.ok(text.startsWith('<system-reminder>\n'))
  assert.ok(text.includes('This notice replaces every earlier task-lifecycle notice in this session:'))
  assert.ok(text.includes('<task_lifecycle>\nTask lifecycle: close it.\n</task_lifecycle>'))
  assert.ok(text.endsWith('</system-reminder>'))
  const empty = lifecycleNoticeText('')
  assert.ok(empty.includes(EMPTY_LIFECYCLE_BODY))
})

test('publishedLifecycleNotice: reads the newest injected notice, ignores everything else', () => {
  const first = lifecycleMessage('first state')
  const second = lifecycleMessage('second state')
  const events = [
    assistant(1),
    userText(2, 'a plain user message'),
    injected(3, { ...first, source: { kind: 'skill-catalog', form: 'catalog' } }),
    injected(4, first),
    assistant(5),
    injected(6, second)
  ]
  assert.equal(publishedLifecycleNotice(events), lifecycleNoticeText('second state'))
  assert.equal(publishedLifecycleNotice([]), null)
  assert.equal(publishedLifecycleNotice([assistant(1), userText(2, 'x')]), null)
})

test('publishedLifecycleNotice: tolerates the nested data.message shape too', () => {
  const text = lifecycleNoticeText('nested shape')
  const events = [{ seq: 1, type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text }] }, source: { kind: LIFECYCLE_SOURCE_KIND } } }]
  assert.equal(publishedLifecycleNotice(events), text)
})

test('planLifecycleInjection: publish only on change — the every-step guard', () => {
  const text = lifecycleNoticeText('state')
  assert.equal(planLifecycleInjection(text, text), 'none')
  assert.equal(planLifecycleInjection(text, null), 'publish')
  assert.equal(planLifecycleInjection(text, lifecycleNoticeText('other')), 'publish')
  // Clearing a notice IS a change: the empty state supersedes it.
  assert.equal(planLifecycleInjection(lifecycleNoticeText(''), text), 'publish')
  assert.equal(planLifecycleInjection(lifecycleNoticeText(''), lifecycleNoticeText('')), 'none')
})

test('lifecycleMessage: user role, framed text, and the task-marks source kind', () => {
  const message = lifecycleMessage('body')
  assert.equal(message.role, 'user')
  assert.equal(message.content[0].type, 'text')
  assert.equal(message.content[0].text, lifecycleNoticeText('body'))
  assert.equal(message.source.kind, LIFECYCLE_SOURCE_KIND)
  assert.equal(message.source.form, 'state')
  assert.equal(typeof message.id, 'string')
  assert.ok(message.id.length > 0)
})

test('round trip: a published message is read back byte-identically', () => {
  const body = renderLifecycleBody(['Task lifecycle: one', 'Task lifecycle: two'])
  const text = lifecycleNoticeText(body)
  const events = [injected(9, lifecycleMessage(body))]
  assert.equal(publishedLifecycleNotice(events), text)
  assert.equal(planLifecycleInjection(text, publishedLifecycleNotice(events)), 'none')
})
