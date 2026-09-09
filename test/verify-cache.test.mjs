// Offline tests for the pure helpers exported from scripts/verify-cache.mjs:
// session-log decoding, per-fold usage extraction, and the pass/fail/skip
// classification that gates fold cache reuse.
//
// The fixtures are the real numbers measured on 2026-09-09, on the session
// that found the duplicate-system regression: folds 1-11 broke the prefix
// cache at the span start (uncached >= span), fold 12 — the first fold after
// dsh 0.1.5-alpha.1 with the envelope fix deployed — did not.
// Run in-process (the sandbox blocks node --test child processes):
//   node test/verify-cache.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { zstdCompressSync } from 'node:zlib'
import { decodeSessionLog, parseEvents, foldRows, classifyFold, evaluate, lastResumeSeq } from '../scripts/verify-cache.mjs'

const usage = (inputTokens, cacheReadTokens) => ({ inputTokens, cacheReadTokens })
const fold = (seq, uncached, span, cacheRead) => ({
  type: 'compaction/summary',
  seq,
  data: { usage: usage(uncached, cacheRead), shadowedTokenCount: span },
})

// Measured: fold 11 (broken) and fold 12 (fixed) of the 2026-09-09 session.
const BROKEN = fold(1046, 11192, 5924, 80128)
const BROKEN_SMALL_SPAN = fold(980, 8470, 3581, 88448)
const FIXED = fold(1122, 2199, 7005, 92672)

test('decodeSessionLog: round-trips one zstd frame', () => {
  const text = '{"type":"a","seq":1}\n{"type":"b","seq":2}\n'
  const events = decodeSessionLog(zstdCompressSync(Buffer.from(text, 'utf8')))
  assert.equal(events.length, 2)
  assert.equal(events[0].type, 'a')
  assert.equal(events[1].seq, 2)
})

test('decodeSessionLog: decodes several concatenated frames', () => {
  const frame = (obj) => zstdCompressSync(Buffer.from(JSON.stringify(obj) + '\n', 'utf8'))
  const buf = Buffer.concat([frame({ type: 'a', seq: 1 }), frame({ type: 'b', seq: 2 }), frame({ type: 'c', seq: 3 })])
  const events = decodeSessionLog(buf)
  assert.deepEqual(events.map((e) => e.type), ['a', 'b', 'c'])
})

test('parseEvents: blank lines skipped, undecodable lines become PARSE_ERROR', () => {
  const events = parseEvents('\n{"type":"a"}\nnot json\n')
  assert.equal(events.length, 2)
  assert.equal(events[1].type, 'PARSE_ERROR')
})

test('foldRows: reads data.usage and the data.stream chunk fallback', () => {
  const direct = fold(1, 200, 3000, 1000)
  const streamed = { type: 'compaction/summary', seq: 2, data: { stream: [{ chunk: { usage: usage(300, 4000) } }], shadowedTokenCount: 5000 } }
  const rows = foldRows([direct, streamed])
  assert.equal(rows.length, 2)
  assert.equal(rows[0].prompt, 1200)
  assert.equal(rows[0].uncached, 200)
  assert.equal(rows[0].span, 3000)
  assert.equal(rows[1].cacheRead, 4000)
  assert.equal(rows[1].prompt, 4300)
  assert.equal(rows[1].uncached, 300)
})

test('foldRows: ignores folds without usage and events that are not folds', () => {
  const rows = foldRows([
    { type: 'assistant/message', seq: 1, data: { usage: usage(10, 90) } },
    { type: 'compaction/summary', seq: 2, data: { shadowedTokenCount: 500 } },
    { type: 'compaction/summary', seq: 3, data: { usage: usage(0, 0), shadowedTokenCount: 500 } },
  ])
  assert.equal(rows.length, 0)
})

test('classifyFold: uncached within the instruction budget passes even when the span is large', () => {
  const row = foldRows([FIXED])[0]
  assert.equal(row.uncached, 2199)
  assert.equal(row.span, 7005)
  assert.equal(classifyFold(row).status, 'pass')
})

test('classifyFold: a re-paid span fails', () => {
  const row = foldRows([BROKEN])[0]
  assert.equal(row.uncached, 11192)
  assert.equal(classifyFold(row).status, 'fail')
  assert.match(classifyFold(row).reason, /uncached 11192 > max-tail 3500/)
})

test('classifyFold: a partially re-paid span still fails (uncached above the budget)', () => {
  const row = foldRows([fold(1, 6000, 7005, 90000)])[0]
  assert.equal(classifyFold(row).status, 'fail')
})

test('classifyFold: a span below min-span is skipped as inconclusive', () => {
  const row = foldRows([fold(1, 2199, 900, 90000)])[0]
  const verdict = classifyFold(row)
  assert.equal(verdict.status, 'skip')
  assert.match(verdict.reason, /span 900 < min-span 2000/)
})

test('classifyFold: thresholds are configurable', () => {
  const row = foldRows([BROKEN_SMALL_SPAN])[0]
  assert.equal(classifyFold(row).status, 'fail')
  assert.equal(classifyFold(row, { maxTail: 9000 }).status, 'pass')
  assert.equal(classifyFold(row, { minSpan: 5000 }).status, 'skip')
})

test('evaluate: the regression session fails, the fixed fold alone passes', () => {
  const regressed = evaluate([BROKEN_SMALL_SPAN, BROKEN])
  assert.equal(regressed.verdict, 'fail')
  assert.equal(regressed.failures.length, 2)
  const fixed = evaluate([FIXED])
  assert.equal(fixed.verdict, 'pass')
  assert.equal(fixed.failures.length, 0)
})

test('evaluate: no folds is no-data, and --last judges only the tail', () => {
  assert.equal(evaluate([]).verdict, 'no-data')
  const mixed = evaluate([BROKEN, FIXED], { last: 1 })
  assert.equal(mixed.verdict, 'pass', 'only the newest fold is judged')
  const all = evaluate([BROKEN, FIXED])
  assert.equal(all.verdict, 'fail')
})

test('lastResumeSeq: the newest resume header wins, null when the session never resumed', () => {
  const events = [
    { type: 'request/header', seq: 14, data: { reason: 'initial' } },
    { type: 'request/header', seq: 878, data: { reason: 'resume' } },
    { type: 'request/header', seq: 1056, data: { reason: 'resume' } },
  ]
  assert.equal(lastResumeSeq(events), 1056)
  assert.equal(lastResumeSeq([{ type: 'request/header', seq: 1, data: { reason: 'initial' } }]), null)
  assert.equal(lastResumeSeq([]), null)
})

test('evaluate: --since-restart judges only folds after the restart', () => {
  // BROKEN is seq 1046, FIXED is seq 1122; the restart header sits between them.
  const events = [{ type: 'request/header', seq: 1056, data: { reason: 'resume' } }, BROKEN, FIXED]
  assert.equal(evaluate(events).verdict, 'fail', 'default judges every fold in the log')
  const after = evaluate(events, { sinceRestart: true })
  assert.equal(after.rows.length, 1)
  assert.equal(after.verdict, 'pass')
})
