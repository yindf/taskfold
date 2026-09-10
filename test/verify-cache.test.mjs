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
import { decodeSessionLog, parseEvents, foldRows, classifyFold, evaluate, lastResumeSeq, parseArgs } from '../scripts/verify-cache.mjs'

const usage = (inputTokens, cacheReadTokens) => ({ inputTokens, cacheReadTokens })
const fold = (seq, uncached, span, cacheRead) => ({
  type: 'compaction/summary',
  seq,
  data: { usage: usage(uncached, cacheRead), shadowedTokenCount: span },
})

// Measured: fold 11 (broken) and fold 12 (fixed) of the 2026-09-09 session,
// plus fold 1303 — a healthy fold whose nested fold rewrote its span's middle,
// leaving 5655 uncached while the 19796-token span itself came from cache.
const BROKEN = fold(1046, 11192, 5924, 80128)
const BROKEN_SMALL_SPAN = fold(980, 8470, 3581, 88448)
const FIXED = fold(1122, 2199, 7005, 92672)
const HEALTHY_NESTED = fold(1303, 5655, 19796, 132736)

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

test('classifyFold: a re-paid span fails on the positive tail', () => {
  const row = foldRows([BROKEN])[0]
  assert.equal(row.uncached, 11192)
  assert.equal(row.tail, 5268)
  assert.equal(classifyFold(row).status, 'fail')
  assert.match(classifyFold(row).reason, /uncached 11192 - span 5924 = 5268 > tail-budget 3500/)
})

test('classifyFold: a mid-span rewrite that lifts uncached above the instruction still passes', () => {
  const row = foldRows([HEALTHY_NESTED])[0]
  assert.equal(row.uncached, 5655)
  assert.equal(row.tail, -14141)
  assert.equal(classifyFold(row).status, 'pass', 'the span itself came from cache')
})

test('classifyFold: a partially re-paid span still fails', () => {
  const row = foldRows([fold(1, 12000, 7005, 90000)])[0]
  assert.equal(row.tail, 4995)
  assert.equal(classifyFold(row).status, 'fail')
})

test('classifyFold: a span below min-span is skipped when the guard is on', () => {
  const row = foldRows([fold(1, 2199, 900, 90000)])[0]
  const verdict = classifyFold(row, { minSpan: 2000 })
  assert.equal(verdict.status, 'skip')
  assert.match(verdict.reason, /span 900 < min-span 2000/)
  assert.equal(classifyFold(row).status, 'pass', 'guard is off by default')
})

test('classifyFold: thresholds are configurable', () => {
  const row = foldRows([BROKEN_SMALL_SPAN])[0]
  assert.equal(row.tail, 4889)
  assert.equal(classifyFold(row).status, 'fail')
  assert.equal(classifyFold(row, { tailBudget: 9000 }).status, 'pass')
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

test('parseArgs: a non-numeric flag value is a usage error, never a silent widening', () => {
  // `Number('abc')` is NaN and `slice(-NaN)` is `slice(0)`, so `--last abc`
  // used to judge EVERY fold while looking scoped — a regression check that
  // silently stops checking.
  assert.equal(parseArgs(['--last', '3']).last, 3)
  assert.throws(() => parseArgs(['--last', 'abc']), /--last needs a whole number >= 1 \(got abc\)/)
  assert.throws(() => parseArgs(['--last', '0']), /--last needs a whole number >= 1/)
  assert.throws(() => parseArgs(['--last', '1.5']), /--last needs a whole number >= 1/)
  assert.throws(() => parseArgs(['--last']), /--last needs a whole number >= 1 \(got undefined\)/)
  assert.throws(() => parseArgs(['--tail-budget', 'x']), /--tail-budget needs a number >= 0/)
  assert.throws(() => parseArgs(['--min-span', '-1']), /--min-span needs a number >= 0/)
  assert.equal(parseArgs(['--min-span', '2500', '--json']).minSpan, 2500)
  assert.equal(parseArgs([]).tailBudget, 3500, 'defaults survive')
  assert.throws(() => parseArgs(['--nope']), /unknown argument: --nope/)
})
