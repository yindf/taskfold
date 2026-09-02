import test from 'node:test'
import assert from 'node:assert/strict'
import { collectStats, foldOf, buildRecall, digestOf, RECALL_FULL_LIMIT, taskEndTitleOf, attachFoldTitles, buildArtifactLines } from '../plugins/compact-stats.mjs'

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

// ── compact_recall ───────────────────────────────────────────────────────────

/** Log whose archived seqs exist as real message events (fold 1), plus an
 *  old fold without shadowedSeqs (fold 2) and a live tail message. */
function recallFixture() {
  return [
    { seq: 10, type: 'user/message', data: { message: { content: [{ type: 'text', text: 'fix the bug please' }] } } },
    { seq: 11, type: 'assistant/message', data: { message: { content: [
      { type: 'text', text: 'reading files first' },
      { type: 'tool-call', id: 'call-1', name: 'read' }
    ] } } },
    { seq: 12, type: 'tool/result', data: { message: { content: [
      { type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'the file body returned here' }] }
    ] } } },
    { seq: 13, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'plain answer, no tools' }] } } },
    {
      seq: 50,
      type: 'compaction/summary',
      data: {
        compactionId: 'c9',
        summary: [{ type: 'text', text: 'the checkpoint' }],
        shadowedRange: { start: 10, end: 13 },
        shadowedSeqs: [10, 11, 12, 13],
        shadowedTokenCount: 1234
      }
    },
    { seq: 60, type: 'user/message', data: { message: { content: [{ type: 'text', text: 'live message still on surface' }] } } },
    {
      seq: 70,
      type: 'compaction/summary',
      data: {
        compactionId: 'c10',
        summary: [{ type: 'text', text: 'old fold' }],
        shadowedRange: { start: 1, end: 5 },
        shadowedTokenCount: 100
        // shadowedSeqs intentionally absent (pre-shadowedSeqs fold)
      }
    }
  ]
}

test('recall index mode lists folds with entry counts', () => {
  const r = buildRecall(recallFixture(), {})
  assert.equal(r.ok, true)
  assert.equal(r.mode, 'index')
  assert.equal(r.folds.length, 2)
  assert.equal(r.folds[0].fold, 1)
  assert.equal(r.folds[0].summarySeq, 50)
  assert.equal(r.folds[0].entries, 4)
  assert.equal(r.folds[0].shadowedTokenCount, 1234)
  assert.equal(r.folds[1].entries, undefined)
})

test('recall fold mode opens the artifact: readable transcript, windowed', () => {
  const r = buildRecall(recallFixture(), { fold: 1 })
  assert.equal(r.ok, true)
  assert.equal(r.mode, 'artifact')
  assert.equal(r.target, 'fold #1')
  assert.ok(r.totalLines > 0)
  const joined = r.lines.join('\n')
  assert.ok(joined.includes('─── user'), 'user entry header rendered')
  assert.ok(joined.includes('fix the bug please'), 'user text present')
  assert.ok(joined.includes('→ read('), 'tool call rendered with arguments')
  assert.ok(joined.includes('the file body returned here'), 'tool result present')
  assert.ok(joined.includes('plain answer, no tools'), 'assistant text present')
  // default window covers the small artifact entirely
  assert.equal(r.more, false)
  assert.equal(r.fromLine, 1)
  assert.equal(r.toLine, r.totalLines)
})

test('artifact window seeks by line and is capped', () => {
  const events = []
  for (let i = 0; i < 30; i += 1) {
    events.push({ seq: 100 + i, type: 'user/message', data: { message: { content: [{ type: 'text', text: 'line ' + i + ' of a long artifact entry' }] } } })
  }
  events.push({ seq: 200, type: 'compaction/summary', data: { shadowedSeqs: Array.from({ length: 30 }, (_, i) => 100 + i), shadowedRange: { start: 100, end: 129 }, shadowedTokenCount: 9, summary: [{ type: 'text', text: 's' }] } })
  const head = buildRecall(events, { fold: 1 })
  assert.equal(head.fromLine, 1)
  assert.equal(head.lines.length, head.totalLines, 'small artifact fully windowed')
  const seek = buildRecall(events, { fold: 1, fromLine: 10, toLine: 12 })
  assert.equal(seek.fromLine, 10)
  assert.equal(seek.lines.length, 3)
  assert.ok(seek.lines[0].startsWith('line 4'), 'line 10 is the 5th entry header/body pair region')
})

test('artifact find searches by substring and reports line numbers', () => {
  const r = buildRecall(recallFixture(), { fold: 1, find: 'FILE BODY' })
  assert.equal(r.ok, true)
  assert.equal(r.mode, 'find')
  assert.equal(r.hits.length, 1)
  assert.ok(r.hits[0].text.includes('the file body returned here'))
  assert.ok(r.hits[0].line >= 1)
  const none = buildRecall(recallFixture(), { fold: 1, find: 'zzz-nope' })
  assert.equal(none.hits.length, 0)
})

test('artifact lines carry tool-call arguments', () => {
  const events = [
    { seq: 10, type: 'assistant/message', data: { message: { content: [
      { type: 'text', text: 'writing the file' },
      { type: 'tool-call', id: 'c1', name: 'write', arguments: { file_path: '/tmp/a.md', content: '# Title\nbody' } }
    ] } } },
    { seq: 11, type: 'compaction/summary', data: { shadowedSeqs: [10], shadowedRange: { start: 10, end: 10 }, shadowedTokenCount: 5, summary: [{ type: 'text', text: 's' }] } }
  ]
  const lines = buildArtifactLines(events, [10])
  const joined = lines.join('\n')
  assert.ok(joined.includes('→ write('), 'call name rendered')
  assert.ok(joined.includes('file_path'), 'arguments serialized')
})

test('giant single entries are truncated inside the artifact', () => {
  const long = 'y'.repeat(6500)
  const events = [
    { seq: 10, type: 'user/message', data: { message: { content: [{ type: 'text', text: long }] } } },
    { seq: 11, type: 'compaction/summary', data: { shadowedSeqs: [10], shadowedRange: { start: 10, end: 10 }, shadowedTokenCount: 1, summary: [{ type: 'text', text: 's' }] } }
  ]
  const lines = buildArtifactLines(events, [10])
  assert.ok(lines.some((l) => l.includes('chars truncated in artifact')), 'truncation marker present')
})

test('recall seq mode finds archived and live entries', () => {
  const archived = buildRecall(recallFixture(), { seq: 12 })
  assert.equal(archived.ok, true)
  assert.equal(archived.mode, 'seq')
  assert.equal(archived.archivedByFold, 1)
  assert.equal(archived.kind, 'user/tool_result')
  const live = buildRecall(recallFixture(), { seq: 60 })
  assert.equal(live.ok, true)
  assert.equal(live.archivedByFold, undefined)
  assert.equal(live.preview, 'live message still on surface')
  const missing = buildRecall(recallFixture(), { seq: 999 })
  assert.equal(missing.ok, false)
})

test('recall rejects folds without shadowedSeqs and bad targeting', () => {
  const old = buildRecall(recallFixture(), { fold: 2 })
  assert.equal(old.ok, false)
  assert.match(old.error, /no shadowedSeqs/)
  const both = buildRecall(recallFixture(), { fold: 1, seq: 10 })
  assert.equal(both.ok, false)
  assert.match(both.error, /exactly one/)
  const badRange = buildRecall(recallFixture(), { from: 5, to: 2 })
  assert.equal(badRange.ok, false)
})

test('recall range mode opens an artifact over the seq span', () => {
  const r = buildRecall(recallFixture(), { from: 10, to: 13 })
  assert.equal(r.ok, true)
  assert.equal(r.mode, 'artifact')
  assert.equal(r.target, 'seqs 10..13')
  assert.ok(r.totalLines > 0)
  const none = buildRecall(recallFixture(), { from: 61, to: 69 })
  assert.equal(none.ok, true)
  assert.equal(none.totalLines, 0)
})

test('recall seq full mode raises the cap with an ellipsis marker', () => {
  const long = 'x'.repeat(RECALL_FULL_LIMIT + 500)
  const events = [
    { seq: 10, type: 'user/message', data: { message: { content: [{ type: 'text', text: long }] } } },
    { seq: 11, type: 'compaction/summary', data: { shadowedRange: { start: 10, end: 10 }, shadowedSeqs: [10], shadowedTokenCount: 1, summary: [{ type: 'text', text: 's' }] } }
  ]
  const preview = buildRecall(events, { seq: 10 })
  assert.equal(preview.preview.length, 60 + 1) // 60 chars + ellipsis
  assert.ok(preview.preview.endsWith('…'))
  const full = buildRecall(events, { seq: 10, full: true })
  assert.equal(full.preview.length, RECALL_FULL_LIMIT + 1)
  assert.ok(full.preview.endsWith('…'))
})

test('digestOf defends against malformed events and unknown types', () => {
  assert.equal(digestOf(null, 60).kind, 'other')
  const weird = digestOf({ seq: 3, type: 'brandnew/thing', data: {} }, 60)
  assert.equal(weird.kind, 'event/brandnew/thing')
  assert.equal(weird.preview, '')
  const noSeq = digestOf({ type: 'user/message', data: {} }, 60)
  assert.equal(noSeq.seq, -1)
})

// ── fold titles (task_end {title}) ──────────────────────────────────────────

function resultEvent(seq, text) {
  return { seq, type: 'tool/result', data: { message: { content: [
    { type: 'tool-result', toolCallId: 'c' + seq, content: [{ type: 'text', text }] }
  ] } } }
}

test('taskEndTitleOf extracts the Title line only from task_end successes', () => {
  const titled = resultEvent(30, 'Task ended and compacted into one summary node (99 tokens, 0 mark(s) still open). Original entries stay archived.\nTitle: implement fold titles\n\nSummary:\nbody')
  assert.equal(taskEndTitleOf(titled), 'implement fold titles')
  assert.equal(taskEndTitleOf(resultEvent(31, 'Task ended and compacted into one summary node (5 tokens).')), undefined)
  assert.equal(taskEndTitleOf(resultEvent(32, 'Task ended without compaction (0 mark(s) still open): too small')), undefined)
  assert.equal(taskEndTitleOf(resultEvent(33, 'Title: not a task_end result')), undefined)
  assert.equal(taskEndTitleOf({ seq: 34, type: 'user/message', data: {} }), undefined)
})

test('attachFoldTitles labels the fold its task_end committed', () => {
  const events = [
    { seq: 10, type: 'compaction/summary', data: { shadowedSeqs: [1], shadowedTokenCount: 10, summary: [{ type: 'text', text: 'manual compact fold' }] } },
    { seq: 11, type: 'user/message', data: {} },
    { seq: 20, type: 'compaction/summary', data: { shadowedSeqs: [2], shadowedTokenCount: 20, summary: [{ type: 'text', text: '## S\n- second fold body' }] } },
    { seq: 21, type: 'user/message', data: {} },
    resultEvent(22, 'Task ended and compacted into one summary node (20 tokens, 0 mark(s) still open).\nTitle: ship the preset\n\nSummary:\n…')
  ]
  const folds = [foldOf(events[0]), foldOf(events[2])]
  attachFoldTitles(folds, events)
  assert.equal(folds[0].title, undefined) // manual compact() fold, untitled
  assert.equal(folds[1].title, 'ship the preset')
})

test('collectStats and recall index surface titles over previews', () => {
  const events = [
    { seq: 10, type: 'compaction/summary', data: { shadowedSeqs: [1], shadowedTokenCount: 10, summary: [{ type: 'text', text: '## H\n- preview body' }] } },
    resultEvent(11, 'Task ended and compacted into one summary node (10 tokens, 0 mark(s) still open).\nTitle: named task\n\nSummary:\n…')
  ]
  const stats = collectStats(events, 3)
  assert.equal(stats.folds[0].title, 'named task')
  const index = buildRecall(events, {})
  assert.equal(index.folds[0].title, 'named task')
  assert.equal(index.folds[0].preview, '- preview body')
})

test('two-phase folds carry their title INSIDE the shadowed range', () => {
  // Follow-up-fold era: the titled task_end result is one of the archived
  // seqs — primary extraction reads it from within the fold, not from a
  // result that follows the summary event.
  const events = [
    { seq: 10, type: 'user/message', data: {} },
    { seq: 11, type: 'tool/result', data: { message: { content: [
      { type: 'tool-result', toolCallId: 'ce', content: [{ type: 'text', text: 'Task ended — all marks closed. The complete task span folds into one summary node automatically next.\nTitle: two-phase task name' }] }
    ] } } },
    { seq: 12, type: 'compaction/summary', data: { shadowedSeqs: [10, 11], shadowedRange: { start: 10, end: 11 }, shadowedTokenCount: 42, summary: [{ type: 'text', text: '## H\n- body' }] } }
  ]
  const stats = collectStats(events, 5)
  assert.equal(stats.folds[0].title, 'two-phase task name', 'title extracted from inside the shadowed range')
  const index = buildRecall(events, {})
  assert.equal(index.folds[0].title, 'two-phase task name')
})

test('recall outputs are lossless JSON (no undefined-valued properties)', () => {
  // Untitled folds + folds without shadowedSeqs + a LIVE seq (no archivedByFold)
  // must not emit explicit undefined values: the host validates tool results
  // as lossless JSON and rejects them ("value is not lossless JSON").
  const events = [
    { seq: 10, type: 'user/message', data: { message: { content: [{ type: 'text', text: 'live one' }] } } },
    { seq: 11, type: 'compaction/summary', data: { shadowedSeqs: [5], shadowedRange: { start: 5, end: 5 }, shadowedTokenCount: 7, summary: [{ type: 'text', text: '## H\n- untitled body' }] } },
    { seq: 12, type: 'compaction/summary', data: { shadowedTokenCount: 9, summary: [{ type: 'text', text: 'old fold no seqs' }] } }
  ]
  for (const args of [{}, { seq: 10 }, { from: 1, to: 100 }, { fold: 1 }]) {
    const out = buildRecall(events, args)
    assert.equal(out.ok, true, 'mode ' + JSON.stringify(args))
    assert.deepEqual(JSON.parse(JSON.stringify(out)), out, 'mode ' + JSON.stringify(args))
  }
  const stats = collectStats(events, 4)
  assert.deepEqual(JSON.parse(JSON.stringify(stats)), stats)
})
