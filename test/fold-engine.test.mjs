// Offline tests for the heading-CONSTRUCTION helpers exported from
// plugins/fold-engine.mjs: prependFoldHeading and opensWithSectionHeading.
// The guard itself runs inside the LLM seam (buildScopedEngine); these
// tests pin the construction contract that replaced heading COMPLIANCE
// (byte-exact, then similarity compares both retried whole-span fold
// calls whenever the model translated or retitled the heading — 9+ live
// failures). The engine now prepends the exact title itself; the model
// only has to open with a '## ' section heading.
// Run in-process (the sandbox blocks node --test child processes):
//   node test/fold-engine.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { prependFoldHeading, opensWithSectionHeading } from '../plugins/fold-engine.mjs'

const NAME = 'Investigate settings Models page "off" bug'
const text = (s) => ({ type: 'text', text: s })

test('prependFoldHeading: prefixes the exact heading to the first non-empty text block', () => {
  const blocks = [text('## What happened\n- did things'), text('tail')]
  const out = prependFoldHeading(blocks, NAME)
  assert.equal(out[0].text, '# ' + NAME + '\n\n## What happened\n- did things')
  assert.equal(out[1].text, 'tail', 'other blocks untouched')
})

test('prependFoldHeading: exact regardless of language pressure — a CJK task name stays CJK', () => {
  const out = prependFoldHeading([text('## What happened\n- …')], '诊断每轮折叠退化问题')
  assert.equal(out[0].text.startsWith('# 诊断每轮折叠退化问题\n\n## What happened'), true)
})

test('prependFoldHeading: skips leading blank lines, does not mutate input', () => {
  const blocks = [text('  \n\n## What happened'), text('x')]
  const snapshot = JSON.stringify(blocks)
  const out = prependFoldHeading(blocks, NAME)
  assert.equal(out[0].text.startsWith('# ' + NAME + '\n\n'), true)
  assert.equal(JSON.stringify(blocks), snapshot, 'input array untouched')
  assert.notEqual(out, blocks, 'returns a new array')
})

test('prependFoldHeading: empty name or non-array input is a no-op', () => {
  const blocks = [text('## What happened')]
  assert.equal(prependFoldHeading(blocks, ''), blocks)
  assert.equal(prependFoldHeading(blocks, undefined), blocks)
  assert.equal(prependFoldHeading(null, NAME), null)
})

test('prependFoldHeading: no usable text block is a no-op', () => {
  const blocks = [{ type: 'tool-call', name: 'x' }, text('   ')]
  assert.equal(prependFoldHeading(blocks, NAME), blocks)
})

test('opensWithSectionHeading: accepts the mandated opener and any ## heading', () => {
  assert.equal(opensWithSectionHeading([text('## What happened\n- a')]), true)
  assert.equal(opensWithSectionHeading([text('  \n## 发生了什么\n- 甲')]), true)
  assert.equal(opensWithSectionHeading([text('## Changes')]), true)
})

test('opensWithSectionHeading: rejects titles, preamble, and noise (retry path)', () => {
  assert.equal(opensWithSectionHeading([text('# ' + NAME + '\n## What happened')]), false, 'a # title line is now the engine\u0027s job')
  assert.equal(opensWithSectionHeading([text('Here is the summary of the span.')]), false)
  assert.equal(opensWithSectionHeading([text('总结如下：…')]), false)
  assert.equal(opensWithSectionHeading([text('### What happened')]), false, 'h3 is not the section opener shape')
})

test('opensWithSectionHeading: empty, non-array, or non-text input never passes', () => {
  assert.equal(opensWithSectionHeading([]), false)
  assert.equal(opensWithSectionHeading(null), false)
  assert.equal(opensWithSectionHeading([text('   ')]), false)
  assert.equal(opensWithSectionHeading([{ type: 'tool-call' }]), false)
})
