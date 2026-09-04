import test from 'node:test'
import assert from 'node:assert/strict'
import nodeFs from 'node:fs'
import nodePath from 'node:path'
import nodeOs from 'node:os'
import { blockBrief, messagePreviewLine, renderSpanPreview, writeSpanArtifact, callBrief, resultBrief, collectToolCalls } from '../plugins/span-preview.mjs'

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
  assert.equal(blockBrief({ type: 'text', text: 'a\n  b' }), 'a ↵ b')
  assert.equal(blockBrief({ type: 'text', text: 'para one\n\npara two' }), 'para one ↵ para two', 'original line breaks become a visible marker')
  assert.equal(blockBrief({ type: 'reasoning', text: 'think' }), '[think] think')
  assert.equal(blockBrief({ type: 'tool-call', name: 'grep', arguments: '{"pattern":"x"}' }), '→grep "x"')
  assert.equal(blockBrief({ type: 'tool-result', content: [{ type: 'text', text: 'Found 2 matches' }] }), '←Found 2 matches')
  assert.equal(blockBrief({ type: 'tool-result', content: [{ type: 'text', text: 'boom' }], isError: true }), '←ERROR: boom')
  assert.equal(blockBrief({ type: 'future-block' }), '[future-block]')
  assert.equal(blockBrief(null), '?')
  const long = blockBrief({ type: 'text', text: 'x'.repeat(200) })
  assert.ok(long.length <= 81 && long.endsWith('…'), 'text clips at 80 chars')
})

test('messagePreviewLine: numbered, role-prefixed, single line, capped length', () => {
  const line = messagePreviewLine(span()[1], 2)
  assert.ok(line.startsWith('  2 assistant: '), '1-based padded number + role')
  assert.ok(line.includes('[think] Let me analyze the new log: ↵ multiline'), 'newlines render as ↵, still one line')
  assert.ok(line.includes('→grep "balanced"'), 'tool-call fragment present')
  assert.ok(!line.includes('\n'), 'never a raw newline')
  assert.ok(messagePreviewLine({ role: 'user', content: [] }, 1).endsWith('(empty)'), 'empty content marked')
  assert.ok(messagePreviewLine({ role: 'user', content: [{ type: 'text', text: 'y'.repeat(500) }] }, 1).length <= 201, 'line clips at 200 chars')
})

test('messagePreviewLine: all-tool-result messages label as tool, user text stays user', () => {
  const toolLine = messagePreviewLine({ role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'probe output' }] }] }, 7)
  assert.ok(toolLine.startsWith('  7 tool: ←probe output'), 'tool-result message reads tool:')
  const userLine = messagePreviewLine({ role: 'user', content: [{ type: 'text', text: 'Current runtime context.' }] }, 3)
  assert.ok(userLine.startsWith('  3 user: Current runtime context'), 'genuine user text keeps user:')
  const mixed = messagePreviewLine({ role: 'user', content: [{ type: 'text', text: 'note' }, { type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'r' }] }] }, 4)
  assert.ok(mixed.startsWith('  4 user: '), 'mixed blocks keep the original role label')
  const snap = messagePreviewLine({ role: 'user', content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes…' }], source: { kind: 'plugin' } }, 3)
  assert.ok(snap.startsWith('  3 harness: Current runtime context'), 'plugin-injected snapshots read harness:')
})

test('renderSpanPreview: header counts messages, cap collapses the tail with a pointer', () => {
  const lines = renderSpanPreview(span(), 3)
  assert.equal(lines[0], 'Span preview (4 messages, one per line — same order/numbering as the JSONL artifact):')
  assert.equal(lines.length, 5, 'header + 3 capped lines + overflow')
  assert.equal(lines[4], '… +1 more messages — read the artifact file for the rest.')
  assert.deepEqual(renderSpanPreview([]), ['Span preview: (empty)'])
  assert.equal(renderSpanPreview(span())[1].startsWith('  1 user: fix the fold boundary ↵ please'), true, 'default cap 30 keeps all of a small span')
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

test('callBrief: tool-specific call summaries for common tools', () => {
  assert.equal(callBrief('read', '{"file_path":"C:\\\\w\\\\CHANGELOG.md"}'), '→read C:\\w\\CHANGELOG.md')
  assert.equal(callBrief('write', '{"file_path":"/tmp/a.txt"}'), '→write /tmp/a.txt')
  assert.equal(callBrief('edit', '{"file_path":"p.mjs","old_string":"a\\nb","new_string":"a\\nb\\nc\\nd"}'), '→edit p.mjs +4 -2')
  assert.equal(callBrief('grep', '{"pattern":"reportPart","include":"*.mjs"}'), '→grep "reportPart" (*.mjs)')
  assert.equal(callBrief('pwsh', '{"command":"node -e …","description":"Run live probe"}'), '→pwsh ‹Run live probe›')
  assert.equal(callBrief('pwsh', '{"command":"node -e \\"console.log(1)\\""}'), '→pwsh ‹node -e "console.log(1)"›', 'empty description falls back to the command')
  assert.equal(callBrief('other', '{"x":1}'), '→other({"x":1})', 'unknown tools keep the generic form')
})

test('resultBrief: grep stats, file-tool content excerpts, generic fallback', () => {
  assert.equal(resultBrief('grep', 'Found 2 matches\n\nC:\\a\\f.mjs:1: x\nC:\\a\\f.mjs:2: y'), '2 matches · 1 file')
  assert.equal(resultBrief('grep', 'Found 3 matches\n\nC:\\a\\f.mjs:1: x\nC:\\b\\g.mjs:2: y'), '3 matches · 2 files')
  assert.equal(resultBrief('grep', 'No matches found'), 'No matches found', 'unparsed grep output falls back to excerpt')
  assert.ok(resultBrief('read', '<path>C:\\w\\x.md</path>\n<type>file</type>\n1: hello world').startsWith('1: hello world'), 'read result shows content, not the path header')
  assert.equal(resultBrief('pwsh', 'probe output'), 'probe output')
})

test('collectToolCalls + blockBrief correlation: result briefs match the calling tool', () => {
  const span2 = [
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c9', name: 'grep', arguments: '{"pattern":"x"}' }] },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c9', content: [{ type: 'text', text: 'Found 5 matches\n\nC:\\a\\f.mjs:1: x' }] }] }
  ]
  const calls = collectToolCalls(span2)
  assert.equal(calls.get('c9').name, 'grep')
  assert.equal(blockBrief(span2[1].content[0], calls), '←5 matches · 1 file')
  assert.equal(blockBrief(span2[1].content[0]), '←Found 5 matches ↵ C:\\a\\f.mjs:1: x', 'without the map the generic excerpt stays')
})

test('writeSpanArtifact: provenance metadata is stripped, content kept whole', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'text', text: 'hi' }], source: { kind: 'model', replayState: { response: { id: 'r1' } } }, id: 'm1' },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }], source: { kind: 'tool', callId: 'c1' }, id: 'm2' }
  ]
  const file = writeSpanArtifact(messages, 'meta-strip-test')
  const parsed = nodeFs.readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l))
  assert.deepEqual(parsed, [
    { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }] }
  ], 'only role + content survive')
  nodeFs.rmSync(file)
})
