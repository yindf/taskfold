// The standalone lifecycle hint channel: an EVENT, not a state display.
// These tests pin the three properties the channel must never lose — a hint
// publishes ONLY when its text changes (otherwise the agent loop appends a
// message every step), nothing is published when no condition holds (no empty
// state, no expiry notice), and the latch resets on clearing so the same hint
// can legitimately reappear later.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  LIFECYCLE_SOURCE_KIND,
  renderLifecycleBody,
  planLifecycleInjection,
  lifecycleMessage
} from '../plugins/lifecycle-injection.mjs'

test('renderLifecycleBody: lines join, blanks drop, nothing is null', () => {
  assert.equal(renderLifecycleBody(['a', 'b']), 'a\nb')
  assert.equal(renderLifecycleBody(['a', '', '   ', 'b']), 'a\nb')
  assert.equal(renderLifecycleBody([]), null)
  assert.equal(renderLifecycleBody(null), null)
  assert.equal(renderLifecycleBody(['', '  ']), null)
})

test('planLifecycleInjection: publish on change, nothing on no-hint', () => {
  assert.deepEqual(planLifecycleInjection('hint', undefined), { publish: true, last: 'hint' })
  assert.deepEqual(planLifecycleInjection('hint', 'hint'), { publish: false, last: 'hint' })
  assert.deepEqual(planLifecycleInjection('other', 'hint'), { publish: true, last: 'other' })
  // No condition holds: publish NOTHING, and clear the latch.
  assert.deepEqual(planLifecycleInjection(null, 'hint'), { publish: false, last: null })
})

test('planLifecycleInjection: a spent hint can reappear after the condition clears', () => {
  // hint -> model complies (no hint) -> the same condition returns later.
  const first = planLifecycleInjection('Task lifecycle: open one.', undefined)
  assert.equal(first.publish, true)
  const cleared = planLifecycleInjection(null, first.last)
  assert.equal(cleared.publish, false)
  assert.equal(cleared.last, null)
  const again = planLifecycleInjection('Task lifecycle: open one.', cleared.last)
  assert.equal(again.publish, true)
})

test('lifecycleMessage: the hint text is the body, with no wrapper at all', () => {
  const body = 'Task lifecycle: no open task during tool work — call task_begin({ name: "…" }).'
  const message = lifecycleMessage(body)
  assert.equal(message.role, 'user')
  assert.equal(message.content.length, 1)
  assert.equal(message.content[0].type, 'text')
  assert.equal(message.content[0].text, body)
  assert.equal(message.content[0].text.includes('<system-reminder>'), false)
  assert.equal(message.content[0].text.includes('<task_lifecycle>'), false)
  assert.equal(message.source.kind, LIFECYCLE_SOURCE_KIND)
  assert.equal(message.source.form, 'hint')
  assert.equal(typeof message.id, 'string')
  assert.ok(message.id.length > 0)
})

test('lifecycleMessage: multi-line hints keep their own lines only', () => {
  const body = renderLifecycleBody(['Task lifecycle: one', 'Task lifecycle: two'])
  const message = lifecycleMessage(body)
  assert.equal(message.content[0].text, 'Task lifecycle: one\nTask lifecycle: two')
})

test('the channel as a whole: a simulated session publishes exactly the changes', () => {
  const latch = new Map()
  const published = []
  const step = (lines) => {
    const body = renderLifecycleBody(lines)
    if (body === null) { latch.delete('s'); return }
    const plan = planLifecycleInjection(body, latch.get('s'))
    if (plan.last === null) latch.delete('s')
    else latch.set('s', plan.last)
    if (plan.publish) published.push(lifecycleMessage(plan.last))
  }
  const hint = 'Task lifecycle: task "x" is 20+ rounds old — close it or split it.'
  step([hint])          // condition appears -> publish
  step([hint])          // still holding     -> nothing
  step([hint])          // still holding     -> nothing
  step([])              // complied          -> nothing (no empty state)
  step([hint])          // recurs            -> publish again
  step(['Task lifecycle: no open task during tool work.'])
  assert.equal(published.length, 3)
  assert.equal(published[0].content[0].text, hint)
  assert.equal(published[1].content[0].text, hint)
  assert.ok(published[2].content[0].text.startsWith('Task lifecycle: no open task'))
  assert.ok(published.every((m) => m.source.kind === LIFECYCLE_SOURCE_KIND))
  assert.ok(published.every((m) => !m.content[0].text.includes('system-reminder')))
})
