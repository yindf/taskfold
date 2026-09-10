// Offline tests for the pure helpers exported from plugins/fold-engine.mjs:
// prependFoldHeading and opensWithSectionHeading (heading construction),
// dropDuplicateLeadingSystem (the prefix-envelope / host system-message
// dedup), and spanMessagesFor (the span coordinate the artifact, the span
// index and the footer share with fold_recall).
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
import { prependFoldHeading, opensWithSectionHeading, dropDuplicateLeadingSystem, spanMessagesFor } from '../plugins/fold-engine.mjs'

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

// --- spanMessagesFor (the span coordinate) --------------------------------
// Live divergence this pins: the host prepends the surface-head system prompt
// into input.messages (dsh >= 0.1.5-alpha.1) while fold_recall rebuilds a fold
// from data.shadowedSeqs alone. Writing the artifact / span index / footer
// from input.messages therefore put them all exactly one line off recall
// (measured: 36/5/14 artifact lines against 35/4/13 shadowed seqs). The fold
// side must recompute the commit's own positional slice.
const msg = (s) => ({ role: 'user', content: [text(s)] })

/** Session stand-in: surface positions + per-seq event lookup. */
function sessionStub(nodes, bySeq) {
  return {
    surface: { nodes },
    eventAt: (seq) => (Object.prototype.hasOwnProperty.call(bySeq, seq) ? bySeq[seq] : null),
    deriveEventMessage: (ev) => (ev === null || ev === undefined ? null : ev.message)
  }
}
const node = (label) => ({ message: msg(label) })

test('spanMessagesFor: rebuilds the shadowed positional slice, dropping the routed request head', () => {
  const session = sessionStub([1, 5, 9, 12, 20], { 9: node('span 1'), 12: node('span 2'), 20: node('span 3') })
  // The routed request carries the host-prepended surface head — exactly the
  // shape that made artifact/recall disagree.
  const hostRegion = [sys('You are an AI agent…'), msg('span 1'), msg('span 2'), msg('span 3')]
  const out = spanMessagesFor(session, { startSeq: 9, endSeq: 20 }, hostRegion)
  assert.equal(out.length, 3, 'the request head is not span content')
  assert.deepEqual(out, [msg('span 1'), msg('span 2'), msg('span 3')], 'coordinate is the commit\'s own shadowed slice')
})

test('spanMessagesFor: slices by SURFACE POSITION, never by seq magnitude', () => {
  // Post-fold surface: a summary node (183) and a later-committed node (220)
  // sit at earlier positions than the span while carrying higher seqs, and
  // 150 — numerically BELOW the start — is genuine span content.
  const session = sessionStub([183, 177, 179, 187, 150, 216, 220], { 187: node('a'), 150: node('b'), 216: node('c') })
  const out = spanMessagesFor(session, { startSeq: 187, endSeq: 216 }, [])
  assert.deepEqual(out, [msg('a'), msg('b'), msg('c')], 'positional slice includes 150 and stops at 216')
})

test('spanMessagesFor: null projections inside the slice are skipped, like the host', () => {
  const session = sessionStub([1, 2, 3], { 2: node('only') })
  assert.deepEqual(spanMessagesFor(session, { startSeq: 1, endSeq: 3 }, []), [msg('only')])
})

test('spanMessagesFor: falls back whenever the declaration cannot be honored', () => {
  const fallback = [sys('head'), msg('x')]
  const session = sessionStub([1, 2, 3], { 2: node('m') })
  assert.equal(spanMessagesFor(session, null, fallback), fallback, 'no closing declaration (stock AUTO path)')
  assert.equal(spanMessagesFor(session, {}, fallback), fallback, 'declaration without seqs')
  assert.equal(spanMessagesFor(session, { startSeq: '1', endSeq: 3 }, fallback), fallback, 'non-integer seqs')
  assert.equal(spanMessagesFor(session, { startSeq: 99, endSeq: 3 }, fallback), fallback, 'start not on the surface')
  assert.equal(spanMessagesFor(session, { startSeq: 3, endSeq: 1 }, fallback), fallback, 'end before start')
  assert.equal(spanMessagesFor({ surface: { nodes: [1, 2] } }, { startSeq: 1, endSeq: 2 }, fallback), fallback, 'no per-node projection API')
  const empty = { surface: { nodes: [1, 2] }, eventAt: () => null, deriveEventMessage: (ev) => (ev === null ? null : ev.message) }
  assert.equal(spanMessagesFor(empty, { startSeq: 1, endSeq: 2 }, fallback), fallback, 'nothing derivable → fallback')
  const throwing = { surface: { nodes: [1] }, eventAt: () => { throw new Error('boom') }, deriveEventMessage: (x) => x }
  assert.equal(spanMessagesFor(throwing, { startSeq: 1, endSeq: 1 }, fallback), fallback, 'a throwing host API never breaks the fold')
})
