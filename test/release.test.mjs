import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
  npmrcAuthLine,
  manualNpmHint,
  parseRegQueryToken,
  resolveNpmVersion,
  checkNpmTarget,
  assertClientDependencyResolvable,
  publishOrder,
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

// ── npm step helpers ──────────────────────────────────────────────────────

test('npmrcAuthLine: one registry auth line with trailing newline, token verbatim', () => {
  assert.equal(npmrcAuthLine('npm_abc123'), '//registry.npmjs.org/:_authToken=npm_abc123\n')
  assert.equal(npmrcAuthLine('npm_x+y/z='), '//registry.npmjs.org/:_authToken=npm_x+y/z=\n')
})

test('manualNpmHint: names the version, the manual command, and the automation-token caveat', () => {
  const hint = manualNpmHint('0.37.7', 'NPM_TOKEN expired')
  assert.ok(hint.includes('0.37.7'))
  assert.ok(hint.includes('npm publish --access public'))
  assert.ok(hint.includes('Automation-type token'))
})

// ── npm repair command (`release.mjs npm`) ────────────────────────────────

test('resolveNpmVersion: --version wins; otherwise the CHANGELOG top must be released', () => {
  assert.deepEqual(resolveNpmVersion({ requested: '1.2.3', top: null }), { ok: true, version: '1.2.3' })
  assert.deepEqual(
    resolveNpmVersion({ requested: undefined, top: { version: '0.37.7', kind: 'released' } }),
    { ok: true, version: '0.37.7' },
  )
  assert.equal(resolveNpmVersion({ requested: undefined, top: null }).ok, false)
  assert.match(
    resolveNpmVersion({ requested: undefined, top: { version: '0.38.0', kind: 'draft' } }).reason,
    /unreleased draft \(0\.38\.0\)/,
  )
  // An explicit --version still names an already-released version while a draft
  // is pending: the repair path must not be blocked by the next release's draft.
  assert.deepEqual(
    resolveNpmVersion({ requested: '0.37.7', top: { version: '0.38.0', kind: 'draft' } }),
    { ok: true, version: '0.37.7' },
  )
  for (const bad of ['1.2', 'v1.2.3', '1.2.3-rc.1', '', 'nonsense']) {
    assert.equal(resolveNpmVersion({ requested: bad, top: null }).ok, false, bad)
  }
})

test('checkNpmTarget: package version, local tag, clean tree and tag-identical tree are all required', () => {
  const base = { version: '0.37.7', packageVersion: '0.37.7', hasTag: true, treeMatches: true, dirty: [] }
  assert.deepEqual(checkNpmTarget(base), { ok: true, version: '0.37.7' })
  assert.match(checkNpmTarget({ ...base, packageVersion: '0.37.6' }).reason, /package\.json is v0\.37\.6, not v0\.37\.7/)
  assert.match(checkNpmTarget({ ...base, hasTag: false }).reason, /tag v0\.37\.7 does not exist locally/)
  assert.match(checkNpmTarget({ ...base, dirty: ['README.md', 'plugins/x.mjs'] }).reason, /dirty \(README\.md, plugins\/x\.mjs\)/)
  assert.match(checkNpmTarget({ ...base, treeMatches: false }).reason, /differs from tag v0\.37\.7/)
  // Precedence: the version mismatch is named first, the dirty tree before the
  // tag comparison (a dirty tree is the cheaper thing to resolve).
  assert.match(checkNpmTarget({ ...base, packageVersion: '0.37.6', dirty: ['x'], treeMatches: false }).reason, /package\.json/)
  assert.match(checkNpmTarget({ ...base, dirty: ['x'], treeMatches: false }).reason, /working tree dirty/)
})

test('parseRegQueryToken: reads REG_SZ and REG_EXPAND_SZ, ignores everything else', () => {
  const reg = ['', 'HKEY_CURRENT_USER\\Environment', '    NPM_TOKEN    REG_SZ    npm_abc123', ''].join('\r\n')
  assert.equal(parseRegQueryToken(reg), 'npm_abc123')
  assert.equal(parseRegQueryToken('    NPM_TOKEN    REG_EXPAND_SZ    npm_x+y/z=\n'), 'npm_x+y/z=')
  assert.equal(parseRegQueryToken('    NPM_TOKEN    REG_DWORD    0x1\n'), undefined)
  assert.equal(parseRegQueryToken('    OTHER_TOKEN    REG_SZ    value\n'), undefined)
  assert.equal(parseRegQueryToken(''), undefined)
  assert.equal(parseRegQueryToken(undefined), undefined)
})

// ── client dependency ship-guard ──────────────────────────────────────────
//
// 0.38.0 shipped `"dsh-taskfold-client": "file:./client"` and EVERY install
// died (`ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND`, the path resolved against the
// consumer's workspace root). The unit suite cannot see that shape — inside
// this repo the nested directory is simply there — so these tests pin the
// guard that reads the declaration instead of the directory.

/** A throwaway repo: root manifest + the nested client package beside it. */
function fixtureRepo(rootManifest, clientManifest) {
  const dir = mkdtempSync(path.join(tmpdir(), 'taskfold-guard-'))
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify(rootManifest, null, 2))
  mkdirSync(path.join(dir, 'client'))
  writeFileSync(path.join(dir, 'client', 'package.json'), JSON.stringify(clientManifest, null, 2))
  return dir
}

const ROOT_OK = { name: 'dsh-taskfold', version: '0.38.0', dependencies: { 'dsh-taskfold-client': '^0.38.0' } }
const CLIENT_OK = {
  name: 'dsh-taskfold-client',
  version: '0.38.0',
  type: 'module',
  exports: { '.': './index.mjs', './client': './taskfold-client.mjs', './package.json': './package.json' },
  dsh: { client: { platform: 'web' } },
}

test('assertClientDependencyResolvable: accepts a registry range with a publishable client', () => {
  const dir = fixtureRepo(ROOT_OK, CLIENT_OK)
  assert.deepEqual(assertClientDependencyResolvable(dir), { spec: '^0.38.0', version: '0.38.0', name: 'dsh-taskfold-client' })
  // `~` and exact pins are ranges this repo may declare.
  const tilde = fixtureRepo({ ...ROOT_OK, dependencies: { 'dsh-taskfold-client': '~0.38.0' } }, CLIENT_OK)
  assert.equal(assertClientDependencyResolvable(tilde).spec, '~0.38.0')
})

test('assertClientDependencyResolvable: every path specifier is refused, naming the consumer-side failure', () => {
  for (const spec of ['file:./client', 'file:client', 'link:./client', 'workspace:*', 'workspace:^', 'portal:./client']) {
    const dir = fixtureRepo({ ...ROOT_OK, dependencies: { 'dsh-taskfold-client': spec } }, CLIENT_OK)
    assert.throws(() => assertClientDependencyResolvable(dir), /ship-guard: "dsh-taskfold-client" is declared as/, spec)
  }
  // The guard is about the resolver, so the message must say what the user saw.
  const dir = fixtureRepo({ ...ROOT_OK, dependencies: { 'dsh-taskfold-client': 'file:./client' } }, CLIENT_OK)
  assert.throws(() => assertClientDependencyResolvable(dir), /ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND/)
})

test('assertClientDependencyResolvable: a missing declaration is refused (the row mounts by bare name)', () => {
  const dir = fixtureRepo({ name: 'dsh-taskfold', version: '0.38.0' }, CLIENT_OK)
  assert.throws(() => assertClientDependencyResolvable(dir), /declares no "dsh-taskfold-client" dependency/)
})

test('assertClientDependencyResolvable: the client must be publishable and mountable', () => {
  const priv = fixtureRepo(ROOT_OK, { ...CLIENT_OK, private: true })
  assert.throws(() => assertClientDependencyResolvable(priv), /"private": true — npm publish refuses/)
  const misnamed = fixtureRepo(ROOT_OK, { ...CLIENT_OK, name: 'taskfold-client' })
  assert.throws(() => assertClientDependencyResolvable(misnamed), /is named "taskfold-client"/)
  const noPlatform = fixtureRepo(ROOT_OK, { ...CLIENT_OK, dsh: {} })
  assert.throws(() => assertClientDependencyResolvable(noPlatform), /dsh\.client\.platform === "web"/)
  const noExport = fixtureRepo(ROOT_OK, { ...CLIENT_OK, exports: { '.': './index.mjs' } })
  assert.throws(() => assertClientDependencyResolvable(noExport), /exports no "\.\/client" bundle/)
})

test('assertClientDependencyResolvable: the declared range must include the released client version', () => {
  const dir = fixtureRepo({ ...ROOT_OK, dependencies: { 'dsh-taskfold-client': '^0.39.0' } }, CLIENT_OK)
  assert.throws(() => assertClientDependencyResolvable(dir), /does not include the client version 0\.38\.0/)
})

test('assertClientDependencyResolvable: an intended version is checked for what the release will be', () => {
  const dir = fixtureRepo(ROOT_OK, CLIENT_OK)
  /* `release` validates BEFORE it bumps: the client legitimately still carries
   * the previous version at that moment, so reading it off disk must not decide
   * anything — but the version about to be written is still judged. */
  assert.equal(assertClientDependencyResolvable(dir, '0.38.0').version, '0.38.0')
  assert.throws(() => assertClientDependencyResolvable(dir, '0.39.0'), /does not include this release's client version 0\.39\.0/)
  assert.throws(() => assertClientDependencyResolvable(dir, '0.39'), /must be strict X\.Y\.Z/)
  // A range that covers the next release is the shipped arrangement.
  const bumped = fixtureRepo({ ...ROOT_OK, dependencies: { 'dsh-taskfold-client': '^0.38.1' } }, CLIENT_OK)
  assert.equal(assertClientDependencyResolvable(bumped, '0.38.1').version, '0.38.1')
})

test('assertClientDependencyResolvable: publishing the tree itself demands lockstep', () => {
  /* The `npm` path has the finalized tree in hand, so the client's own version
   * is the release being published and must match it. */
  const dir = fixtureRepo({ ...ROOT_OK, dependencies: { 'dsh-taskfold-client': '^0.38.0' } }, { ...CLIENT_OK, version: '0.37.0' })
  assert.throws(() => assertClientDependencyResolvable(dir), /does not include the client version 0\.37\.0/)
})

test('publishOrder: the client publishes FIRST, the root second', () => {
  const dir = fixtureRepo(ROOT_OK, CLIENT_OK)
  const order = publishOrder(dir)
  assert.deepEqual(order.map((t) => t.name), ['dsh-taskfold-client', 'dsh-taskfold'])
  assert.equal(order[0].dir, path.join(dir, 'client'))
  assert.equal(order[1].dir, dir)
})
