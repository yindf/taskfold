import test from 'node:test'
import assert from 'node:assert/strict'
import pluginDefault, { collectStats, foldOf, attachFoldTitles, collectFolds, renderFoldList } from '../plugins/compact-stats.mjs'

/** Minimal but shape-accurate events mirroring dsh-compaction-basic output. */
function fixture() {
  return [
    { seq: 1, type: 'user/message', data: { message: { content: [{ type: 'text', text: 'hi' }] } } },
    { seq: 2, type: 'assistant/message', data: { message: { content: [] } } },
    { seq: 3, type: 'tool/result', data: {} },
    { seq: 4, type: 'compaction/start', data: { compactionId: 'c1' } },
    {
      seq: 5,
      type: 'compaction/summary',
      data: {
        compactionId: 'c1',
        summary: [{ type: 'text', text: '## Primary Request and Intent\n- investigated the harness' }],
        shadowedRange: { start: 10, end: 16 },
        shadowedSeqs: [10, 11, 12, 13, 14, 15, 16],
        shadowedTokenCount: 2845,
        provider: 'deepseek',
        model: 'glm-5.3'
      }
    },
    { seq: 6, type: 'user/message', data: {} },
    {
      seq: 7,
      type: 'compaction/summary',
      data: {
        compactionId: 'c2',
        summary: [{ type: 'text', text: 'second fold' }],
        shadowedRange: { start: 20, end: 22 },
        shadowedTokenCount: 900
        // provider/model intentionally absent
      }
    },
    { seq: 8, type: 'todo/write', data: { todos: [{ content: 'x', status: 'in_progress' }] } }
  ]
}

test('detects folds with totals and previews, oldest first', () => {
  const stats = collectStats(fixture(), 12)
  assert.equal(stats.eventCount, 8)
  assert.equal(stats.surfaceLength, 12)
  assert.equal(stats.totals.folds, 2)
  assert.equal(stats.totals.shadowedTokens, 3745)
  assert.equal(stats.folds[0].seq, 5)
  assert.equal(stats.folds[0].shadowedTokenCount, 2845)
  assert.equal(stats.folds[0].shadowedStart, 10)
  assert.equal(stats.folds[0].shadowedEnd, 16)
  assert.equal(stats.folds[0].provider, 'deepseek')
  // Preview skips the engine's fixed "## Section" headers and shows the first
  // meaningful line instead (headers would burn the whole 60-char budget).
  assert.equal(stats.folds[0].preview, '- investigated the harness')
  assert.equal(stats.folds[1].compactionId, 'c2')
  assert.equal('provider' in stats.folds[1], false)
})

test('empty history is zeros, not an error', () => {
  const stats = collectStats([], 0)
  assert.equal(stats.totals.folds, 0)
  assert.equal(stats.totals.shadowedTokens, 0)
  assert.equal(stats.eventCount, 0)
  assert.deepEqual(stats.folds, [])
})

test('fold preview skips headers, truncates with ellipsis', () => {
  const long = '- '.concat('x'.repeat(120))
  const event = {
    seq: 5,
    type: 'compaction/summary',
    data: { summary: [{ type: 'text', text: '## Primary Request and Intent\n\n' + long + '\n\n## Next' }] }
  }
  const [fold] = [foldOf(event)]
  assert.equal(fold.preview.length, 60 + 1)
  assert.ok(fold.preview.endsWith('…'))
  assert.ok(!fold.preview.includes('#'))
  // summary that is ONLY headers previews as empty, not garbage
  const onlyHeaders = foldOf({ seq: 6, type: 'compaction/summary', data: { summary: [{ type: 'text', text: '## A\n## B\n' }] } })
  assert.equal(onlyHeaders.preview, '')
})

test('fold accounting keys only on compaction/summary — unknown types are invisible, not errors', () => {
  // The exhaustive known-type set is gone by design; a log full of
  // unfamiliar event types must not break stats or produce noise.
  const events = fixture().concat([{ seq: 9, type: 'compaction/v2-commit', data: {} }, { seq: 10, type: 'brandnew/thing', data: {} }])
  const stats = collectStats(events, 12)
  assert.equal(stats.totals.folds, 2)
  assert.equal('unknownEventTypes' in stats, false)
})

test('defensive against malformed fold events', () => {
  const fold = foldOf({ seq: 'x', type: 'compaction/summary', data: { summary: 'not-blocks' } })
  assert.equal(fold.seq, -1)
  assert.equal(fold.shadowedTokenCount, 0)
  assert.equal(fold.shadowedTokenCountMissing, true)
  assert.equal(fold.preview, '')
  const nullish = collectStats([null, 42, { type: 7 }, undefined], 3)
  assert.equal(nullish.eventCount, 4)
  assert.equal(nullish.totals.folds, 0)
})

// ── fold titles + collectFolds (shared by stats and compact_recall) ────────

function foldCallEvent(seq, callId, name) {
  return { seq, type: 'assistant/message', data: { message: { content: [
    { type: 'tool-call', id: callId, name: 'task_fold', arguments: JSON.stringify({ name }) }
  ] } } }
}

function resultEvent(seq, callId) {
  return { seq, type: 'tool/result', data: { message: { content: [
    { type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'Task folded: x — all closed.' }] }
  ] } } }
}

function summaryEvent(seq, shadowed, summaryText) {
  return { seq, type: 'compaction/summary', data: { shadowedSeqs: shadowed, shadowedRange: { start: shadowed[0], end: shadowed[shadowed.length - 1] }, shadowedTokenCount: 42, summary: [{ type: 'text', text: summaryText === undefined ? '# x\n- body' : summaryText }] } }
}

test('a fold is titled by the in-flight task_fold call\u0027s arguments', () => {
  // Call → summary (engine commits during execute) → result: the temporal
  // window guarantees the in-flight call owns the fold.
  const events = [
    { seq: 10, type: 'user/message', data: {} },
    foldCallEvent(11, 'c1', 'argument-based titles'),
    summaryEvent(12, [10, 11]),
    resultEvent(13, 'c1')
  ]
  const folds = collectFolds(events)
  assert.equal(folds.length, 1)
  assert.equal(folds[0].title, 'argument-based titles', 'name read from arguments, not rendered text')
})

test('failed task_fold calls never mislabel folds', () => {
  // A failed call produces NO summary before its result — the call is
  // retired from the in-flight map, so an auto fold after it stays untitled.
  // The summary here deliberately carries no '# ' heading (an AUTO fold).
  const events = [
    foldCallEvent(11, 'c1', 'will fail'),
    resultEvent(12, 'c1'),
    summaryEvent(13, [10, 11], '- untitled auto-fold body')
  ]
  const folds = collectFolds(events)
  assert.equal(folds[0].title, undefined, 'failed call does not label the next fold')
})

test('deferred folds are titled by their summary heading, not the call window', () => {
  // v9: the fold commits at a step boundary, long after the call/result
  // window — the in-flight path misses it, and the '# <name>' heading the
  // scoped summarizer forces is the title source.
  const events = [
    foldCallEvent(11, 'c1', 'queued close'),
    resultEvent(12, 'c1'),
    { seq: 40, type: 'user/message', data: {} },
    { seq: 41, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'the deliverable' }] } } },
    summaryEvent(50, [10, 41], '# queued close\n## What happened\n- did the work')
  ]
  const folds = collectFolds(events)
  assert.equal(folds[0].title, 'queued close', 'deferred fold titled by its summary heading')
})

test('summary headings only match level-1, not section headers', () => {
  const events = [summaryEvent(10, [1, 9], '## What happened\n- no title here')]
  const folds = collectFolds(events)
  assert.equal(folds[0].title, undefined, '## section headers are not fold titles')
})

test('fold names normalize whitespace from arguments', () => {
  const events = [
    foldCallEvent(11, 'c1', 'fix  the   bug'),
    summaryEvent(12, [10, 11]),
    resultEvent(13, 'c1')
  ]
  const folds = collectFolds(events)
  assert.equal(folds[0].title, 'fix the bug')
})

test('collectFolds and collectStats outputs are lossless JSON', () => {
  const events = [
    { seq: 10, type: 'user/message', data: { message: { content: [{ type: 'text', text: 'live one' }] } } },
    { seq: 11, type: 'compaction/summary', data: { shadowedSeqs: [5], shadowedRange: { start: 5, end: 5 }, shadowedTokenCount: 7, summary: [{ type: 'text', text: '## H\n- untitled body' }] } }
  ]
  const stats = collectStats(events, 4)
  assert.deepEqual(JSON.parse(JSON.stringify(stats)), stats)
  const folds = collectFolds(events)
  assert.deepEqual(JSON.parse(JSON.stringify(folds)), folds)
})

test('renderFoldList numbers folds chronologically — the domain fold_recall validates', () => {
  // fixture() carries two folds at event seqs 5 and 7. The printed numbers
  // MUST be the 1-based chronological index (1, 2) — fold_recall accepts
  // exactly 1..folds.length. The display carries only that domain: number,
  // tokens, title. The raw event seq and shadowed range never appear —
  // they live in the durable log and the artifact footers.
  const stats = collectStats(fixture(), 12)
  const lines = renderFoldList(stats)
  assert.equal(lines.length, 3)
  assert.match(lines[1], /^#1 \d+ tokens \| /, 'line 1 is #1 with tokens then title')
  assert.match(lines[2], /^#2 \d+ tokens \| /, 'line 2 is #2')
  assert.ok(!/\(seq|range/.test(lines[1]), 'internal ids never leak into the listing')
  // Numbering matches fold_recall's parameter domain exactly: for every
  // printed #N, N is a valid fold_recall({ fold: N }) argument.
  for (let i = 1; i <= stats.totals.folds; i += 1) {
    assert.ok(i >= 1 && i <= stats.folds.length)
    assert.ok(lines[i].startsWith('#' + i + ' '))
  }
})

test('renderFoldList: empty and defensive inputs', () => {
  assert.deepEqual(renderFoldList({ totals: { folds: 0, shadowedTokens: 0 }, folds: [], surfaceLength: 0, eventCount: 0 }),
    ['Surface: 0 nodes; folds: 0, ~0 tokens shadowed.'])
  assert.equal(renderFoldList(null).length, 1, 'degenerate stats still render a header line')
  assert.equal(renderFoldList({ folds: [{ seq: 1, shadowedTokenCount: 3, preview: 'p' }] })[1],
    '#1 3 tokens | p', 'missing totals/range fields degrade gracefully')
})

test('fold_recall range overload: one call returns a cited slice of exact originals (no file written)', async () => {
  const captured = []
  pluginDefault.apply({ tools: { register: (t) => captured.push(t) } })
  const recall = captured.find((t) => t.name === 'fold_recall')
  assert.ok(recall !== undefined, 'fold_recall registered')
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'fix it' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{"file_path":"a"}' }] },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'contents' }] }] },
    { role: 'assistant', content: [{ type: 'text', text: 'done' }] }
  ]
  const seqs = [11, 12, 13, 14]
  const log = [{ seq: 20, type: 'compaction/summary', data: { shadowedTokenCount: 42, shadowedSeqs: seqs, summary: [{ type: 'text', text: '# demo task\n\n## What happened\n- did things' }] } }]
  const session = {
    id: 'sess-range-test',
    events: log,
    surface: { nodes: [20] },
    eventAt: (seq) => ({ seq }),
    deriveEventMessage: (e) => messages[seqs.indexOf(e.seq)]
  }
  const exec = { agent: { session } }
  const range = await recall.execute({ fold: 1, from: 2, to: 3 }, exec)
  assert.equal(range.ok, true)
  assert.deepEqual(range.lines.map((l) => l.line), [2, 3], 'true line numbers carried')
  assert.equal(range.entries, 4, 'total span size reported')
  assert.deepEqual(Object.keys(range.lines[0].message), ['role', 'content'], 'slimmed like the line overload')
  const text = recall.output.render({ fold: 1, from: 2, to: 3 }, range)[0].text
  assert.ok(text.startsWith('Fold #1 lines 2-3 of 4:'), 'render header carries the range and the total')
  assert.ok(text.includes('\n2 {"role":"assistant"'), 'each line prefixed by its true number, raw JSON body')
  assert.ok(text.includes('\n3 {"role":"user"'), 'slice ends at the requested line')
  const clash = await recall.execute({ fold: 1, line: 2, from: 2, to: 3 }, exec)
  assert.equal(clash.ok, false, 'line and from/to are mutually exclusive')
  assert.match(clash.error, /mutually exclusive/)
  const inverted = await recall.execute({ fold: 1, from: 3, to: 2 }, exec)
  assert.equal(inverted.ok, false)
  assert.match(inverted.error, /fold #1 \(4 lines\): /, 'validation errors carry the fold context prefix')
  const oob = await recall.execute({ fold: 1, from: 2, to: 9 }, exec)
  assert.equal(oob.ok, false, 'out-of-span range rejected')
  assert.match(oob.error, /1\.\.4/, 'error names the valid domain')
})

test('foldOf is total: a nullish or malformed event degrades instead of throwing', () => {
  // Review-found: the doc claimed "defensive on every field" while
  // foldOf(null) read `event.seq` on null and threw a TypeError. It is a
  // public pure helper, so the EVENT itself is defensive too now.
  for (const bad of [null, undefined, 42, 'x', []]) {
    const fold = foldOf(bad)
    assert.equal(fold.seq, -1)
    assert.equal(fold.shadowedTokenCount, 0)
    assert.equal(fold.preview, '')
  }
  assert.equal(foldOf({ seq: 3, type: 'compaction/summary', data: null }).seq, 3, 'missing data degrades to an empty record')
})

test('an AUTO (untitled) fold lists by its preview; a task fold by its heading', () => {
  const events = [
    { seq: 10, type: 'compaction/summary', data: { shadowedSeqs: [1, 9], shadowedTokenCount: 42, summary: [{ type: 'text', text: '## Primary Request and Intent\n- the auto checkpoint body' }] } },
    { seq: 11, type: 'compaction/summary', data: { shadowedSeqs: [12, 20], shadowedTokenCount: 77, summary: [{ type: 'text', text: '# a named task\n\n## What happened\n- body' }] } }
  ]
  const stats = collectStats(events, 6)
  assert.equal(stats.folds[0].title, undefined, 'an AUTO checkpoint carries no title')
  assert.equal(stats.folds[1].title, 'a named task', 'the constructed heading is the title source')
  const lines = renderFoldList(stats)
  assert.match(lines[1], /\| - the auto checkpoint body$/, 'untitled folds list their preview')
  assert.match(lines[2], /\| a named task$/, 'titled folds list the heading')
})
