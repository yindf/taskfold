import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import {
  parseEntryHeader,
  cmpSemver,
  parseConventional,
  nextVersion,
  renderEntry,
  finalizeDraftHeader,
  classifyState,
  changelogSection,
  packTarballName,
  releaseNotes,
  ghReleaseArgs,
  manualAssetHint,
  ghCandidates,
} from '../scripts/release.mjs'

// ── cmpSemver ─────────────────────────────────────────────────────────────

test('cmpSemver: ordering, equality, zero paddings', () => {
  assert.equal(cmpSemver('0.0.0', '0.0.1'), -1)
  assert.equal(cmpSemver('0.2.9', '0.2.10'), -1)
  assert.equal(cmpSemver('1.0.0', '0.9.9'), 1)
  assert.equal(cmpSemver('1.2.3', '1.2.3'), 0)
})

test('cmpSemver: malformed input throws (prerelease, build metadata, non-numeric)', () => {
  for (const bad of ['1.2.3-rc.1', '1.2.3+build', 'v1.2.3', '1.2', 'x.y.z', '']) {
    assert.throws(() => cmpSemver(bad, '0.0.1'), /malformed/, bad)
  }
})

// ── parseConventional ─────────────────────────────────────────────────────

test('parseConventional: plain types, scopes, breaking marker', () => {
  assert.deepEqual(parseConventional('feat: add x'), { type: 'feat', scope: undefined, breaking: false, subject: 'add x' })
  assert.deepEqual(parseConventional('fix(ui): correct y'), { type: 'fix', scope: 'ui', breaking: false, subject: 'correct y' })
  assert.equal(parseConventional('feat(api)!: change contract').breaking, true)
})

test('parseConventional: merge commits, reverts, prefix-less land in other', () => {
  assert.equal(parseConventional('Merge branch "x"').type, 'other')
  assert.equal(parseConventional('revert: feat: add x').type, 'other')
  assert.equal(parseConventional('just a sentence').type, 'other')
})

// ── nextVersion ───────────────────────────────────────────────────────────

test('nextVersion: feat -> minor, breaking (either form) -> major, all-chore -> patch', () => {
  assert.equal(nextVersion('1.2.3', [{ type: 'feat' }]), '1.3.0')
  assert.equal(nextVersion('1.2.3', [{ type: 'feat', breaking: true }]), '2.0.0')
  assert.equal(nextVersion('1.2.3', [{ type: 'fix', breaking: true }]), '2.0.0')
  assert.equal(nextVersion('1.2.3', [{ type: 'chore' }]), '1.2.4')
  assert.equal(nextVersion('0.2.3', []), '0.2.4')
})

// ── parseEntryHeader ──────────────────────────────────────────────────────

test('parseEntryHeader: em/en/hyphen dashes all parse; draft vs released vs legacy markers', () => {
  assert.deepEqual(parseEntryHeader('## 1.2.3 — title here'), { version: '1.2.3', title: 'title here', kind: 'released' })
  assert.deepEqual(parseEntryHeader('## 1.2.3 – dash'), { version: '1.2.3', title: 'dash', kind: 'released' })
  assert.deepEqual(parseEntryHeader('## 1.2.3 - hyphen'), { version: '1.2.3', title: 'hyphen', kind: 'released' })
  assert.deepEqual(parseEntryHeader('## 0.2.3 — old style (current)'), { version: '0.2.3', title: 'old style', kind: 'released' })
  assert.deepEqual(parseEntryHeader('## 0.3.0 — next (unreleased draft 2025-06-01)'), { version: '0.3.0', title: 'next', kind: 'draft' })
})

test('parseEntryHeader: malformed lines return null', () => {
  assert.equal(parseEntryHeader('## not-a-version — x'), null)
  assert.equal(parseEntryHeader('## 1.2.3.4 — x'), null)
  assert.equal(parseEntryHeader('1.2.3 — no heading'), null)
  assert.equal(parseEntryHeader('## 1.2.3 (unreleased draft 2025-06-01)'), null) // missing dash+title grammar
  assert.equal(parseEntryHeader(null), null)
})

// ── renderEntry / finalizeDraftHeader ─────────────────────────────────────

test('renderEntry: ordered groups, empty groups omitted, raw subjects preserved', () => {
  const text = renderEntry('0.3.0', 'a `title` with ticks', '2025-06-01', {
    feat: ['add `x`\nsecond line'],
    fix: [],
    other: ['merge-ish thing'],
  })
  const lines = text.split('\n')
  assert.equal(lines[0], '## 0.3.0 — a `title` with ticks (unreleased draft 2025-06-01)')
  assert.ok(lines.includes('- **Features**'))
  assert.ok(!lines.includes('- **Fixes**'))
  assert.ok(text.includes('  - add `x`\nsecond line'))
  assert.ok(lines.includes('- **Other**'))
})

test('finalizeDraftHeader: replaces draft header with release date; throws on released or malformed', () => {
  assert.equal(finalizeDraftHeader('## 0.3.0 — next (unreleased draft 2025-06-01)', '2025-06-02'), '## 0.3.0 — next (2025-06-02)')
  assert.throws(() => finalizeDraftHeader('## 0.3.0 — next (2025-06-01)', '2025-06-02'), /not an unreleased draft/)
  assert.throws(() => finalizeDraftHeader('garbage', '2025-06-02'), /not an unreleased draft/)
})

// ── classifyState ─────────────────────────────────────────────────────────

test('classifyState: CLEAN (matching triple, clean tree)', () => {
  assert.equal(classifyState({ top: { version: '0.2.3', kind: 'released' }, packageVersion: '0.2.3', tagVersion: '0.2.3', dirty: [] }).state, 'CLEAN')
})

test('classifyState: DRAFT (pending bump, only CHANGELOG dirty)', () => {
  const s = classifyState({ top: { version: '0.3.0', kind: 'draft' }, packageVersion: '0.2.3', tagVersion: '0.2.3', dirty: ['CHANGELOG.md'] })
  assert.equal(s.state, 'DRAFT')
  assert.equal(s.version, '0.3.0')
})

test('classifyState: PENDING (released triple, remote lacks tag)', () => {
  assert.equal(classifyState({ top: { version: '0.3.0', kind: 'released' }, packageVersion: '0.3.0', tagVersion: '0.3.0', dirty: [], remoteHasTag: false }).state, 'PENDING')
})

test('classifyState: INVALID — package behind CHANGELOG top, tag mismatch, dirty tree, non-increasing draft, package/tag mismatch under draft', () => {
  assert.equal(classifyState({ top: { version: '0.3.0', kind: 'released' }, packageVersion: '0.2.3', tagVersion: '0.2.3', dirty: [] }).state, 'INVALID')
  assert.equal(classifyState({ top: { version: '0.3.0', kind: 'released' }, packageVersion: '0.3.0', tagVersion: '0.2.3', dirty: [] }).state, 'INVALID')
  assert.equal(classifyState({ top: { version: '0.3.0', kind: 'released' }, packageVersion: '0.3.0', tagVersion: '0.3.0', dirty: ['README.md'] }).state, 'INVALID')
  assert.equal(classifyState({ top: { version: '0.2.3', kind: 'draft' }, packageVersion: '0.2.3', tagVersion: '0.2.3', dirty: [] }).state, 'INVALID')
  assert.equal(classifyState({ top: { version: '0.3.0', kind: 'draft' }, packageVersion: '0.2.4', tagVersion: '0.2.3', dirty: [] }).state, 'INVALID')
  assert.equal(classifyState({ top: null, packageVersion: '0.2.3', tagVersion: '0.2.3', dirty: [] }).state, 'INVALID')
})

test('classifyState: first-release (no tag) uses package.json as baseline', () => {
  assert.equal(classifyState({ top: { version: '0.2.3', kind: 'released' }, packageVersion: '0.2.3', tagVersion: undefined, dirty: [] }).state, 'CLEAN')
  assert.equal(classifyState({ top: { version: '1.0.0', kind: 'draft' }, packageVersion: '0.2.3', tagVersion: undefined, dirty: ['CHANGELOG.md'] }).state, 'DRAFT')
})

// ── GitHub Release assets ─────────────────────────────────────────────────

const CHANGELOG_FIXTURE = [
  '# Changelog',
  '',
  '## 0.3.0 — third release (2025-06-02)',
  '',
  '- **Features**',
  '  - add x',
  '',
  '## 0.2.3 — second release (2025-06-01)',
  '',
  '- **Fixes**',
  '  - fix y',
  '',
].join('\n')

test('changelogSection: extracts one entry body, stops at the next heading, null when absent', () => {
  const third = changelogSection(CHANGELOG_FIXTURE, '0.3.0')
  assert.equal(third.title, 'third release')
  assert.equal(third.body, '- **Features**\n  - add x')
  assert.equal(changelogSection(CHANGELOG_FIXTURE, '0.2.3').body, '- **Fixes**\n  - fix y')
  assert.equal(changelogSection(CHANGELOG_FIXTURE, '9.9.9'), null)
  assert.equal(changelogSection('no entries here', '0.3.0'), null)
  assert.equal(changelogSection(undefined, '0.3.0'), null)
})

test('packTarballName: plain and scoped names match npm pack output', () => {
  assert.equal(packTarballName('dsh-taskfold', '0.34.0'), 'dsh-taskfold-0.34.0.tgz')
  assert.equal(packTarballName('@scope/name', '1.2.3'), 'scope-name-1.2.3.tgz')
})

test('releaseNotes: keeps the CHANGELOG body and names the attached tarball', () => {
  const md = releaseNotes({ title: 't', body: '- **Features**\n  - add x' }, 'dsh-taskfold-0.34.0.tgz')
  assert.ok(md.includes('- **Features**\n  - add x'))
  assert.ok(md.includes('`dsh-taskfold-0.34.0.tgz`'))
  assert.ok(!md.includes('undefined'))
  const bare = releaseNotes({ title: 't', body: '' }, 'x-1.0.0.tgz')
  assert.ok(bare.startsWith('\n\n---'))
  assert.ok(!bare.includes('undefined'))
  assert.ok(!releaseNotes(null, 'x-1.0.0.tgz').includes('undefined'))
})

test('ghReleaseArgs: create on first publish, --clobber upload into an existing release', () => {
  assert.deepEqual(
    ghReleaseArgs({ version: '0.34.0', tarball: '/tmp/x.tgz', notesFile: '/tmp/n.md', exists: false }),
    ['release', 'create', 'v0.34.0', '/tmp/x.tgz', '--title', 'v0.34.0', '--notes-file', '/tmp/n.md'],
  )
  assert.deepEqual(
    ghReleaseArgs({ version: '0.34.0', tarball: '/tmp/x.tgz', notesFile: '/tmp/n.md', exists: true }),
    ['release', 'upload', 'v0.34.0', '/tmp/x.tgz', '--clobber'],
  )
})

test('manualAssetHint: names the tag, the asset and both recovery routes', () => {
  const hint = manualAssetHint('0.34.0', 'dsh-taskfold-0.34.0.tgz')
  assert.ok(hint.includes('v0.34.0'))
  assert.ok(hint.includes('dsh-taskfold-0.34.0.tgz'))
  assert.ok(hint.includes('gh release create'))
  assert.ok(hint.includes('release.mjs assets'))
})

test('ghCandidates: PATH first, then the platform install locations', () => {
  const win = ghCandidates('win32', { ProgramFiles: 'C:\\PF', 'ProgramFiles(x86)': 'C:\\PF86' })
  assert.equal(win[0], 'gh')
  assert.ok(win.includes(path.join('C:\\PF', 'GitHub CLI', 'gh.exe')))
  assert.ok(win.includes(path.join('C:\\PF86', 'GitHub CLI', 'gh.exe')))
  // Missing env vars fall back to the conventional defaults rather than undefined.
  assert.ok(ghCandidates('win32', {}).every((c) => typeof c === 'string' && c.length > 0))
  const mac = ghCandidates('darwin', {})
  assert.equal(mac[0], 'gh')
  assert.ok(mac.includes('/opt/homebrew/bin/gh'))
  const linux = ghCandidates('linux', {})
  assert.ok(linux.includes('/usr/bin/gh'))
})
