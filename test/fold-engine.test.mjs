// Offline tests for the pure helpers exported from plugins/fold-engine.mjs:
// prependFoldHeading and opensWithSectionHeading (heading construction), plus
// dropDuplicateLeadingSystem (the prefix-envelope / host system-message
// dedup).
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
import { prependFoldHeading, opensWithSectionHeading, dropDuplicateLeadingSystem } from '../plugins/fold-engine.mjs'

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

// --- dropDuplicateLeadingSystem (prefix-cache envelope integrity) ---------
// dsh >= 0.1.5-alpha.1 moved the surface-node-0 system prompt from the
// separate `system` field into messages[0]; the prefix envelope already
// replays that node, so keeping both inserted a second system message right
// before the span — the exact byte where the provider's prefix cache broke
// (every fold re-billed its whole span; measured cacheRead == pre-span
// prefix). These tests pin the structural detection, not a version string.
const sys = (s) => ({ role: 'system', content: [text(s)] })
const user = (s) => ({ role: 'user', content: [text(s)] })

test('dropDuplicateLeadingSystem: removes the host head the prefix already replays', () => {
  const prompt = sys('You are an AI agent…')
  const prefix = [prompt, user('earlier 1'), user('earlier 2')]
  const region = [sys('You are an AI agent…'), user('span 1'), user('span 2')]
  const out = dropDuplicateLeadingSystem(prefix, region)
  assert.deepEqual(out, [user('span 1'), user('span 2')])
  assert.equal(region.length, 3, 'input array untouched')
})

test('dropDuplicateLeadingSystem: the deduped request is a strict prefix of the main conversation', () => {
  const prompt = sys('You are an AI agent…')
  const main = [prompt, user('earlier 1'), user('span 1'), user('span 2'), user('later')]
  const prefix = [prompt, user('earlier 1')]
  const hostRegion = [sys('You are an AI agent…'), user('span 1'), user('span 2')]
  const request = [...prefix, ...dropDuplicateLeadingSystem(prefix, hostRegion)]
  assert.deepEqual(request, main.slice(0, 4), 'request replays the conversation prefix byte-for-byte')
})

test('dropDuplicateLeadingSystem: keeps a system message the prefix does not replay', () => {
  const region = [sys('a prompt we never saw'), user('span 1')]
  const out = dropDuplicateLeadingSystem([user('earlier 1')], region)
  assert.deepEqual(out, region, 'no proven duplicate → keep the head (fail-open, never lose the prompt)')
})

test('dropDuplicateLeadingSystem: keeps a DIFFERENT system message (in-history prompt update)', () => {
  const region = [sys('updated prompt'), user('span 1')]
  const out = dropDuplicateLeadingSystem([sys('older prompt'), user('earlier 1')], region)
  assert.deepEqual(out, region, 'byte-identical match required')
})

test('dropDuplicateLeadingSystem: old-host shape (no system head in messages) is a no-op', () => {
  const region = [user('span 1'), user('span 2')]
  assert.deepEqual(dropDuplicateLeadingSystem([sys('p'), user('earlier')], region), region)
  assert.equal(dropDuplicateLeadingSystem([sys('p')], region), region, 'same array identity when nothing is dropped')
})

test('dropDuplicateLeadingSystem: empty or malformed inputs are total', () => {
  const region = [sys('p'), user('s')]
  assert.equal(dropDuplicateLeadingSystem([], region), region)
  assert.equal(dropDuplicateLeadingSystem(null, region), region)
  const empty = []
  assert.equal(dropDuplicateLeadingSystem([sys('p')], empty), empty)
  assert.equal(dropDuplicateLeadingSystem([sys('p')], null), null)
  const odd = [null, user('s')]
  assert.equal(dropDuplicateLeadingSystem([sys('p')], odd), odd, 'non-object head is left alone')
})
