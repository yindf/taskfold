import test from 'node:test'
import assert from 'node:assert/strict'
import nodeFs from 'node:fs'
import nodePath from 'node:path'
import nodeOs from 'node:os'
import { blockBrief, messagePreviewLine, renderSpanPreview, writeSpanArtifact } from '../plugins/span-preview.mjs'

/** Shape-accurate request messages (the same blocks deriveEventMessage yields). */
function span() {
  return [
    { role: 'user', content: [{ type: 'text', text: 'fix the fold boundary\nplease' }] },
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'Let me analyze the new log:\n\nmultiline' },
        { type: 'tool-call', id: 'c1', name: 'grep', arguments: '{"pattern":"balanced"}' }
      ]
    },
    {
      role: 'user',
      content: [{
        type: 'tool-result',
        toolCallId: 'c1',
        content: [{ type: 'text', text: 'Found 2 matches' }],
        isError: false
      }]
    },
    { role: 'assistant', content: [{ type: 'text', text: 'Fixed and tested.' }] }
  ]
}

test('blockBrief: one fragment per block type, whitespace flattened, long text clipped', () => {
  assert.equal(blockBrief({ type: 'text', text: 'a\n  b' }), 'a ⏎ b')
  assert.equal(blockBrief({ type: 'text', text: 'para one\n\npara two' }), 'para one ⏎ para two', 'original line breaks become a visible marker')
  assert.equal(blockBrief({ type: 'reasoning', text: 'think' }), '[think] think')
  assert.equal(blockBrief({ type: 'tool-call', name: 'grep', arguments: '{"pattern":"x"}' }), '→grep({"pattern":"x"})')
  assert.equal(blockBrief({ type: 'tool-result', content: [{ type: 'text', text: 'Found 2 matches' }] }), '⇐Found 2 matches')
  assert.equal(blockBrief({ type: 'tool-result', content: [{ type: 'text', text: 'boom' }], isError: true }), '⇐ERROR: boom')
  assert.equal(blockBrief({ type: 'future-block' }), '[future-block]')
  assert.equal(blockBrief(null), '?')
  const long = blockBrief({ type: 'text', text: 'x'.repeat(200) })
  assert.ok(long.length <= 81 && long.endsWith('…'), 'text clips at 80 chars')
})

test('messagePreviewLine: numbered, role-prefixed, single line, capped length', () => {
  const line = messagePreviewLine(span()[1], 2)
  assert.ok(line.startsWith('  2 assistant: '), '1-based padded number + role')
  assert.ok(line.includes('[think] Let me analyze the new log: ⏎ multiline'), 'newlines render as ⏎, still one line')
  assert.ok(line.includes('→grep('), 'tool-call fragment present')
  assert.ok(!line.includes('\n'), 'never a raw newline')
  assert.ok(messagePreviewLine({ role: 'user', content: [] }, 1).endsWith('(empty)'), 'empty content marked')
  assert.ok(messagePreviewLine({ role: 'user', content: [{ type: 'text', text: 'y'.repeat(500) }] }, 1).length <= 201, 'line clips at 200 chars')
})

test('renderSpanPreview: header counts messages, cap collapses the tail with a pointer', () => {
  const lines = renderSpanPreview(span(), 3)
  assert.equal(lines[0], 'Span preview (4 messages, one per line — same order/numbering as the JSONL artifact):')
  assert.equal(lines.length, 5, 'header + 3 capped lines + overflow')
  assert.equal(lines[4], '… +1 more messages — read the artifact file for the rest.')
  assert.deepEqual(renderSpanPreview([]), ['Span preview: (empty)'])
  assert.equal(renderSpanPreview(span())[1].startsWith('  1 user: fix the fold boundary ⏎ please'), true, 'default cap 30 keeps all of a small span')
})

test('writeSpanArtifact: JSONL file, one message per line, parseable back to the exact span', () => {
  const messages = span()
  const file = writeSpanArtifact(messages, 'test span/名称 — ok?')
  assert.ok(file !== undefined && file.endsWith('.jsonl'), 'writes a .jsonl path')
  assert.ok(nodePath.basename(file).startsWith('test-span'), 'name slugified')
  const raw = nodeFs.readFileSync(file, 'utf8')
  const lines = raw.split('\n').filter((l) => l.length > 0)
  assert.equal(lines.length, messages.length, 'exactly one line per message')
  assert.deepEqual(lines.map((l) => JSON.parse(l)), messages, 'line N is exactly message N')
  nodeFs.rmSync(file)
})
