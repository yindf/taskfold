import test from 'node:test'
import assert from 'node:assert/strict'
import nodeFs from 'node:fs'
import nodePath from 'node:path'
import nodeOs from 'node:os'
import { blockBrief, messagePreviewLine, renderSpanPreview, writeSpanArtifact, callBrief, resultBrief, collectToolCalls, renderArchivePreview, sessionArtifactDir, artifactLineAt } from '../plugins/span-preview.mjs'

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

test('renderSpanPreview: every message line, no elision, true numbering', () => {
  const lines = renderSpanPreview(span())
  assert.equal(lines[0], 'Span preview (4 messages, one per line — same order/numbering as the JSONL artifact):')
  assert.equal(lines.length, 5, 'header + one line per message, nothing elided')
  assert.ok(lines[1].startsWith('  1 user: fix the fold boundary ↵ please'), 'first message on line 1')
  assert.ok(lines[4].startsWith('  4 assistant: Fixed and tested.'), 'last message keeps its TRUE number')
  assert.ok(!lines.some((l) => l.includes('elided')), 'no elision pointer anywhere')
  assert.deepEqual(renderSpanPreview([]), ['Span preview: (empty)'])
})

test('artifactLineAt: the fold_recall line overload picks the exact message', () => {
  const messages = span()
  const first = artifactLineAt(messages, 1)
  assert.equal(first.ok, true)
  assert.equal(first.message, messages[0], 'line N returns exactly message N')
  const last = artifactLineAt(messages, messages.length)
  assert.equal(last.ok === true && last.message, messages[messages.length - 1], 'last line is the last message')
  assert.equal(artifactLineAt(messages, 0).ok, false, 'line 0 is rejected')
  assert.equal(artifactLineAt(messages, messages.length + 1).ok, false, 'beyond-the-end is rejected')
  assert.equal(artifactLineAt(messages, 2.5).ok, false, 'non-integer lines are rejected')
  assert.equal(artifactLineAt(null, 1).ok, false, 'non-array input is rejected')
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

test('writeSpanArtifact: a session key scopes artifacts into a per-session subdirectory', () => {
  const file = writeSpanArtifact(span(), 'scoped artifact', { sessionKey: 'sess 42/b' })
  assert.ok(file !== undefined)
  const dir = nodePath.dirname(file)
  assert.equal(nodePath.basename(dir), 'sess-42-b', 'session key is slugified into its own subdir')
  assert.equal(nodePath.basename(nodePath.dirname(dir)), 'taskfold-artifacts', 'subdir sits under the shared taskfold-artifacts root')
  assert.ok(nodeFs.existsSync(file), 'artifact written inside the session dir')
  nodeFs.rmSync(file)
  nodeFs.rmdirSync(dir)
})

test('writeSpanArtifact: a session dir override lands artifacts in its taskfold subfolder', () => {
  const base = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'tf-sessiondir-'))
  try {
    const file = writeSpanArtifact(span(), 'session local', { sessionDir: base })
    assert.ok(file !== undefined)
    assert.equal(nodePath.basename(nodePath.dirname(file)), 'taskfold', 'artifact sits in the taskfold subfolder')
    assert.equal(nodePath.dirname(nodePath.dirname(file)), nodePath.resolve(base), 'subfolder sits directly in the given session dir')
    assert.ok(nodeFs.existsSync(file), 'artifact written inside the session-local folder')
    assert.ok(writeSpanArtifact(span(), 'override wins', { sessionDir: base, sessionKey: 'sess 42/b' }) !== undefined, 'sessionDir takes precedence over the tmp key path')
  } finally {
    nodeFs.rmSync(base, { recursive: true, force: true })
  }
})

test('sessionArtifactDir: dirname of the persistence backend\u0027s located artifact, with defensive fallbacks', () => {
  const logPath = nodePath.join(nodePath.resolve(nodeOs.tmpdir()), 'fake-sessions', '--proj--', 'session-1', 'session.jsonl')
  const backend = { locate: (meta) => (meta !== undefined ? { kind: 'jsonl', path: logPath } : undefined) }
  const ctx = { get: (name) => (name === 'sessionPersistence' ? backend : undefined) }
  const resolved = sessionArtifactDir(ctx, { header: { id: 'session-1' } })
  assert.equal(resolved, nodePath.dirname(logPath), 'located path dirname, resolved absolute')
  assert.ok(nodePath.isAbsolute(resolved), 'returned dir is absolute')
  assert.equal(sessionArtifactDir(ctx, {}), undefined, 'no session header degrades to undefined')
  assert.equal(sessionArtifactDir({ get: () => undefined }, { header: {} }), undefined, 'no backend degrades to undefined')
  assert.equal(sessionArtifactDir({}, { header: {} }), undefined, 'ctx without get degrades to undefined')
  const throwing = { get: () => ({ locate: () => { throw new Error('boom') } }) }
  assert.equal(sessionArtifactDir(throwing, { header: {} }), undefined, 'locate() throwing degrades to undefined')
})

test('writeSpanArtifact: missing or non-string session keys fall back to the flat root', () => {
  for (const bad of [undefined, null, '', 12345]) {
    const file = writeSpanArtifact(span(), 'flat fallback probe', { sessionKey: bad })
    assert.ok(file !== undefined)
    assert.equal(nodePath.basename(nodePath.dirname(file)), 'taskfold-artifacts', `key ${String(bad)} must not create a subdirectory`)
    assert.notEqual(nodePath.basename(nodePath.dirname(file)), 'undefined', 'String(undefined) must never become a directory name')
    nodeFs.rmSync(file)
  }
})

test('renderArchivePreview: every message line inline; degenerate spans degrade defensively', () => {
  const small = renderArchivePreview(span())
  assert.ok(small[0].startsWith('Span preview (4 messages'), 'header present')
  assert.equal(small.length, 5, 'small span lists every message line inline')
  const big = []
  for (let i = 0; i < 60; i += 1) {
    big.push({ role: 'user', content: [{ type: 'text', text: 'request ' + i + ' '.repeat(400) }] })
    big.push({ role: 'assistant', content: [{ type: 'text', text: 'answer ' + i + ' '.repeat(400) }] })
  }
  const large = renderArchivePreview(big)
  assert.equal(large.length, 121, 'large span lists ALL 120 message lines — no elision, no window')
  assert.ok(!large.some((l) => l.startsWith('… +')), 'no elision pointer')
  assert.ok(large[large.length - 1].startsWith('120 '), 'the span\'s final message is the last preview line (true number kept)')
  const totalChars = large.join('\n').length
  const estChars = JSON.stringify(big).length
  assert.ok(totalChars < estChars * 0.6, 'full listing still costs a fraction of the span it indexes')
  const degenerate = []
  for (let i = 0; i < 80; i += 1) degenerate.push({ role: 'user', content: [] })
  const guard = renderArchivePreview(degenerate)
  assert.equal(guard.length, 2, 'near-empty spans degrade to header + pointer instead of rivaling the span')
  assert.ok(/artifact file/.test(guard[1]), 'pointer directs at the artifact file')
})
