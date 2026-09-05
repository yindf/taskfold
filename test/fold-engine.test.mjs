// Offline tests for the scope-adherence guard's pure helpers exported from
// plugins/fold-engine.mjs: normalizeHeadingTitle and headingSimilarity. The
// guard itself runs inside the LLM seam (buildScopedEngine) and is covered by
// the acceptance note; these tests pin the lenient-comparison contract that
// replaced the byte-exact prefix match (which retried whole-span fold calls
// on curly quotes and translated headings).
// Run in-process (the sandbox blocks node --test child processes):
//   node test/fold-engine.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { HEADING_SIMILARITY_THRESHOLD, normalizeHeadingTitle, headingSimilarity } from '../plugins/fold-engine.mjs'

const NAME = 'Investigate settings Models page "off" bug'

test('threshold is a sane constant', () => {
  assert.ok(HEADING_SIMILARITY_THRESHOLD > 0 && HEADING_SIMILARITY_THRESHOLD < 1)
})

test('normalizeHeadingTitle: identity on plain ASCII', () => {
  assert.equal(normalizeHeadingTitle(NAME), normalizeHeadingTitle(NAME))
  assert.ok(normalizeHeadingTitle(NAME).length > 0)
})

test('typographic drift normalizes to equality (the 12-retry killer)', () => {
  // Curly quotes instead of ASCII — the exact live failure from the session log.
  assert.equal(normalizeHeadingTitle('Investigate settings Models page “off” bug'), normalizeHeadingTitle(NAME))
  // Case and spacing drift.
  assert.equal(normalizeHeadingTitle('  investigate   SETTINGS models page "off" BUG  '), normalizeHeadingTitle(NAME))
  // Em/en dashes and single quotes fold too.
  assert.equal(normalizeHeadingTitle('a — b — c'), normalizeHeadingTitle('a - b - c'))
  assert.equal(normalizeHeadingTitle('it’s "x"'), normalizeHeadingTitle('it\'s "x"'))
})

test('headingSimilarity: exact and typographic variants pass at 1.0', () => {
  assert.equal(headingSimilarity(NAME, NAME), 1)
  assert.equal(headingSimilarity('Investigate settings Models page “off” bug', NAME), 1)
})

test('headingSimilarity: reordered or truncated headings stay above threshold', () => {
  assert.ok(headingSimilarity('guard in fold-engine the fix', 'fix the guard in fold-engine') >= HEADING_SIMILARITY_THRESHOLD)
  assert.ok(headingSimilarity('Investigate settings', NAME) >= HEADING_SIMILARITY_THRESHOLD)
})

test('headingSimilarity: translated heading stays below threshold (retry is correct)', () => {
  // Same meaning, zero character overlap — the model ignored the
  // copy-verbatim instruction; a retry with that instruction is the fix.
  assert.ok(headingSimilarity('调查设置“模型”页面“关闭”bug', NAME) < HEADING_SIMILARITY_THRESHOLD)
})

test('headingSimilarity: a foreign heading (drift) is rejected', () => {
  assert.ok(headingSimilarity('Release v0.22.1', NAME) < HEADING_SIMILARITY_THRESHOLD)
  assert.ok(headingSimilarity('Find broken auto-fold in taskfold', NAME) < HEADING_SIMILARITY_THRESHOLD)
})

test('headingSimilarity: empty or non-string input scores 0, never passes', () => {
  assert.equal(headingSimilarity('', NAME), 0)
  assert.equal(headingSimilarity(undefined, NAME), 0)
  assert.equal(headingSimilarity('   ', NAME), 0)
})

test('headingSimilarity: punctuation-only differences survive on sequence ratio', () => {
  // Quotes dropped entirely: tokens identical → overlap 1.0 regardless.
  assert.ok(headingSimilarity('Investigate settings Models page off bug', NAME) >= HEADING_SIMILARITY_THRESHOLD)
})
