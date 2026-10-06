#!/usr/bin/env node
// Release flow for dsh-taskfold. Design: docs/design/release-flow.md.
//
// State model (quadruple: CHANGELOG top entry, package.json version, latest
// v* tag, working tree). Legal states:
//   CLEAN   top entry released vX == package.json == tag vX, tree clean
//   DRAFT   top entry `unreleased draft` Y > X, package.json == tag == X,
//           only CHANGELOG.md may be dirty (the draft itself)
//   PENDING top released vY == package.json == local tag vY, but the remote
//           lacks the tag or the release commit — release resumes pushes.
// Anything else is INVALID: the script never auto-repairs versions (that is
// exactly the historical 0.1.0 accident); it prints the quadruple plus a
// targeted manual fix hint and exits 1.
//
// A successful `release` also publishes the GitHub Release for the new tag with
// a prebuilt `dsh-taskfold-<version>.tgz` attached; `assets` re-runs just that
// step for an already-released version (and repairs releases shipped without it).
//
// When a token is available, `release` (and its PENDING resume) additionally
// publishes the version to npm — an automation-type token, because 2FA accounts
// reject publish-time OTPs for granular tokens. The token is read from the
// process environment and, on Windows, from the user-level variable as well (a
// host-launched shell snapshots its environment at start-up, so a token set
// after that is invisible to the child while plainly set for the user). The npm
// step is idempotent (a version already on the registry is a no-op) and never
// fails the release: everything git-side is durable before it runs.
//
// `npm` re-runs just that step for an ALREADY-RELEASED version — the repair path
// for a release whose npm step was skipped (no token at the time) or failed.
// `release` cannot repair that: a fully-pushed release is CLEAN, and release
// resumes pushes only in PENDING. npm publishes the WORKING TREE, never a tag,
// so `npm` refuses unless this checkout really is that release (package.json
// version, local tag, clean tree, tree identical to the tag).
//
// Version numbers are strict `X.Y.Z` numerics; prerelease/build metadata are
// rejected. The only source of truth for the NEXT version is the CHANGELOG
// top entry; package.json is synced by this script, never by hand.
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, openSync, closeSync, unlinkSync, mkdtempSync, existsSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { clientBundlePath, repoBundleText } from './build-client.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const changelogPath = path.join(repoRoot, 'CHANGELOG.md')
const pkgPath = path.join(repoRoot, 'package.json')

// ── Pure helpers (exported for offline tests) ─────────────────────────────

const DASH = '[-–—]'

/** Parse one CHANGELOG entry header line. Returns null on malformed input. */
export function parseEntryHeader(line) {
  if (typeof line !== 'string') return null
  const m = line.match(new RegExp('^## (\\d+)\\.(\\d+)\\.(\\d+) ' + DASH + ' (.+)$'))
  if (!m) return null
  let title = m[4]
  let kind = 'released'
  const draft = title.match(/^(.*) \(unreleased draft (\d{4}-\d{2}-\d{2})\)$/)
  if (draft) {
    title = draft[1]
    kind = 'draft'
  } else {
    // Legacy entries may carry "(current)" or "(date)" markers; both mean released.
    title = title.replace(/ \((current|\d{4}-\d{2}-\d{2})\)$/, '')
  }
  return { version: m[1] + '.' + m[2] + '.' + m[3], title, kind }
}

/** Compare two strict X.Y.Z versions: -1 / 0 / 1. Throws on malformed input. */
export function cmpSemver(a, b) {
  const pa = semverParts(a)
  const pb = semverParts(b)
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1
  }
  return 0
}

function semverParts(v) {
  if (typeof v !== 'string' || !/^\d+\.\d+\.\d+$/.test(v)) {
    throw new Error('malformed version (only strict X.Y.Z is supported): ' + String(v))
  }
  return v.split('.').map(Number)
}

/**
 * Parse one `git log --pretty` subject line into a conventional-commit shape.
 * Merge commits, reverts, and prefix-less subjects land in type 'other'
 * (reverts must not masquerade as the type they revert).
 */
export function parseConventional(subject) {
  if (typeof subject !== 'string') return { type: 'other', scope: undefined, breaking: false, subject }
  const m = subject.match(/^([a-z]+)(?:\(([^)]+)\))?(!)?: (.+)$/)
  if (!m || m[1] === 'revert') {
    // reverts land in 'other': their subject names the reverted type and must
    // not masquerade as it in version inference or grouping.
    return { type: 'other', scope: undefined, breaking: false, subject }
  }
  return { type: m[1], scope: m[2], breaking: m[3] === '!', subject: m[4] }
}

/** Bump `current` given the commit set. All-chore logs bump patch by choice. */
export function nextVersion(current, commits) {
  const hasBreaking = commits.some((c) => c.breaking || c.type === 'breaking')
  const hasFeat = commits.some((c) => c.type === 'feat')
  const p = semverParts(current)
  if (hasBreaking) return (p[0] + 1) + '.0.0'
  if (hasFeat) return p[0] + '.' + (p[1] + 1) + '.0'
  return p[0] + '.' + p[1] + '.' + (p[2] + 1)
}

/** Render a draft entry block (header + grouped bullets). */
export function renderEntry(version, title, date, groups) {
  const order = ['feat', 'fix', 'perf', 'refactor', 'test', 'docs', 'chore', 'other']
  const labels = { feat: 'Features', fix: 'Fixes', perf: 'Performance', refactor: 'Refactoring', test: 'Tests', docs: 'Docs', chore: 'Chores', other: 'Other' }
  const lines = ['## ' + version + ' — ' + title + ' (unreleased draft ' + date + ')', '']
  for (const key of order) {
    const items = (groups && groups[key]) || []
    if (items.length === 0) continue
    lines.push('- **' + labels[key] + '**')
    for (const s of items) lines.push('  - ' + s)
  }
  return lines.join('\n')
}

/** Replace a draft header with its released form. Throws if already released. */
export function finalizeDraftHeader(line, date) {
  const h = parseEntryHeader(line)
  if (h === null || h.kind !== 'draft') {
    throw new Error('top CHANGELOG entry is not an unreleased draft: ' + line)
  }
  return '## ' + h.version + ' — ' + h.title + ' (' + date + ')'
}

/**
 * Classify the repository quadruple. `remoteHasTag` is optional (local-only
 * view: status never contacts the network). Dirty file names are repo-relative
 * POSIX paths; only 'CHANGELOG.md' may be dirty in DRAFT.
 */
export function classifyState({ top, packageVersion, tagVersion, dirty, remoteHasTag }) {
  const dirtySet = new Set(dirty || [])
  const onlyChangelog = dirtySet.size === 0 || (dirtySet.size === 1 && dirtySet.has('CHANGELOG.md'))
  if (top === null) return { state: 'INVALID', reason: 'CHANGELOG has no parseable version entry' }
  const base = tagVersion !== undefined ? tagVersion : packageVersion
  if (top.kind === 'draft') {
    if (packageVersion !== base) return { state: 'INVALID', reason: 'package.json (' + packageVersion + ') != tag/base (' + base + ') while a draft is pending' }
    if (cmpSemver(top.version, packageVersion) <= 0) return { state: 'INVALID', reason: 'draft version ' + top.version + ' must be greater than ' + packageVersion }
    if (!onlyChangelog) return { state: 'INVALID', reason: 'dirty files beyond CHANGELOG.md: ' + [...dirtySet].join(', ') }
    return { state: 'DRAFT', version: top.version }
  }
  // released top
  if (packageVersion !== top.version) return { state: 'INVALID', reason: 'package.json (' + packageVersion + ') != CHANGELOG top (' + top.version + ')' }
  if (tagVersion !== undefined && tagVersion !== top.version) return { state: 'INVALID', reason: 'tag v' + tagVersion + ' != CHANGELOG top ' + top.version }
  if (dirtySet.size !== 0) return { state: 'INVALID', reason: 'working tree dirty: ' + [...dirtySet].join(', ') }
  if (remoteHasTag === false) return { state: 'PENDING', version: top.version, reason: 'local release v' + top.version + ' not fully pushed (remote lacks the tag)' }
  return { state: 'CLEAN', version: top.version }
}

// ── git / fs plumbing ─────────────────────────────────────────────────────

// Some sandboxes forbid captured pipes (EPERM on named pipes). When that
// happens, rerun the command with stdout backed by a temp file — the tool still
// runs, only the capture channel changes. stderr is discarded in that mode;
// the non-zero status is the error signal. Shared by git, npm and gh so every
// external tool degrades the same way.
function spawnCaptured(file, args, opts) {
  const useShell = !!(opts && opts.shell)
  const cwd = (opts && opts.cwd) || repoRoot
  const r = spawnSync(file, args, { cwd, encoding: 'utf8', shell: useShell })
  // Discovery probes opt out: re-running a missing tool through the fallback
  // below cannot fix an ENOENT, it only hides it.
  if (opts && opts.probe) return r
  if (r.error && (r.error.code === 'EPERM' || r.error.code === 'ENOENT')) {
    const tmp = path.join(os.tmpdir(), 'dsh-release-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.out')
    let fd
    try {
      fd = openSync(tmp, 'w')
      const s = spawnSync(file, args, { cwd, stdio: ['ignore', fd, 'ignore'], shell: useShell })
      closeSync(fd); fd = undefined
      const stdout = readFileSync(tmp, 'utf8')
      return { status: s.status, stdout, stderr: '' }
    } finally {
      if (fd !== undefined) { try { closeSync(fd) } catch (err) {} }
      try { unlinkSync(tmp) } catch (err) {}
    }
  }
  return r
}

function git(args, opts) {
  const r = spawnCaptured('git', args, opts)
  if (r.status !== 0 && !(opts && opts.okNonZero)) {
    throw new Error('git ' + args.join(' ') + ' failed (' + r.status + '): ' + (r.stderr || r.error || '').toString().trim())
  }
  return r
}

function readTopEntry() {
  const text = readFileSync(changelogPath, 'utf8')
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('## ')) return parseEntryHeader(line)
  }
  return null
}

function insertDraft(block) {
  const text = readFileSync(changelogPath, 'utf8')
  const lines = text.split(/\r?\n/)
  let insertAt = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) { insertAt = i; break }
  }
  if (insertAt === -1) throw new Error('no existing ## entry found to insert before')
  // Drop the legacy "(current)" marker from the previous top entry — exactly
  // one released generation is "current", and it is the new one.
  const prev = lines[insertAt]
  lines[insertAt] = prev.replace(/ \(current\)$/, '')
  lines.splice(insertAt, 0, ...block.split('\n'), '')
  writeFileSync(changelogPath, lines.join('\n'))
}

// Channel branches share one tag namespace, so "latest tag" must be scoped to
// tags reachable from HEAD: alpha's v0.34.7 must not read as master's baseline.
// (Pre-split history makes this load-bearing: alpha owns the v0.34.2 tag while
// master's own 0.34.2 release commit is untagged.)
function latestTag() {
  const r = git(['tag', '--list', 'v*', '--sort=-v:refname', '--merged', 'HEAD'])
  const first = (r.stdout || '').split(/\r?\n/).find((l) => l.trim() !== '')
  return first ? first.replace(/^v/, '') : undefined
}

/** True when a tag with exactly this version exists on any ref. */
function tagExists(version) {
  const r = git(['tag', '--list', 'v' + version], { okNonZero: true })
  return (r.stdout || '').split(/\r?\n/).some((l) => l.trim() === 'v' + version)
}

/**
 * True when the working tree carries exactly the tag's content. `npm publish`
 * ships the working tree and never a tag, so this is the guard that keeps
 * unreleased work from going out under a released version number. Untracked
 * files are invisible to `git diff`; the dirty-tree check covers those.
 */
function treeMatchesTag(version) {
  return git(['diff', '--quiet', '--no-ext-diff', 'v' + version, '--', '.'], { okNonZero: true }).status === 0
}

/**
 * The tag the state machine treats as this branch's latest release. Normally
 * the newest reachable tag. The one exception is the channel-twin case: this
 * branch's newest reachable tag is BELOW package.json while the missing
 * version is tagged on another branch (master's 0.34.2 release vs alpha's
 * v0.34.2 tag). That version is released and uniquely tagged — just not on
 * this branch — so the twin tag stands in as the baseline. A version below
 * package.json with no tag anywhere stays a mismatch (classifyState rejects),
 * and a reachable tag above package.json passes through for the same reject.
 */
function baselineTag(expectedVersion) {
  const own = latestTag()
  if (own === undefined || expectedVersion === undefined) return own
  if (cmpSemver(own, expectedVersion) >= 0) return own
  if (tagExists(expectedVersion)) return expectedVersion
  return own
}

function dirtyFiles() {
  const r = git(['status', '--porcelain'])
  const out = []
  for (const line of (r.stdout || '').split(/\r?\n/)) {
    if (line.trim() === '') continue
    out.push(line.slice(3).trim())
  }
  return out
}

function gatherState(remoteHasTag) {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const own = latestTag()
  const tag = baselineTag(pkg.version)
  // Ancestry tripwire: this branch's own newest tag must be reachable from
  // HEAD — always true for a --merged listing, so this fires only when a tag
  // was rewritten out from under the branch. The channel-twin stand-in is
  // exempt: it belongs to the other branch by design.
  if (own !== undefined && tag === own) {
    const probe = git(['merge-base', '--is-ancestor', 'v' + own, 'HEAD'], { okNonZero: true })
    if (probe.status !== 0) throw new Error('latest tag v' + own + ' is not an ancestor of HEAD — tag diverged from branch history')
  }
  return classifyState({ top: readTopEntry(), packageVersion: pkg.version, tagVersion: tag, dirty: dirtyFiles(), remoteHasTag })
}

function report(state, extra) {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  console.log('CHANGELOG top : ' + (readTopEntry() === null ? '(none)' : readTopEntry().version + ' (' + readTopEntry().kind + ')'))
  console.log('package.json  : ' + pkg.version)
  const baseline = baselineTag(pkg.version)
  console.log('latest tag    : ' + (baseline === undefined ? '(none)' : 'v' + baseline))
  console.log('dirty files   : ' + (dirtyFiles().join(', ') || '(none)'))
  console.log('state         : ' + state + (extra ? ' — ' + extra : ''))
}

function today() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

// ── GitHub Release + prebuilt tarball asset ───────────────────────────────
//
// The READMEs promise a prebuilt `dsh-taskfold-<version>.tgz` on every release;
// only v0.31.1 ever had one, because nothing in this flow published it. These
// helpers build that asset and drive `gh`. Everything here runs AFTER the
// commit, tag and push are durable, so a missing `gh` (or a failing upload)
// downgrades to a printed manual recipe — it must never look like a failed
// release. Re-running is safe: an existing release gets its asset re-uploaded.

/** Extract one entry from a CHANGELOG text: { version, title, body } or null. */
export function changelogSection(text, version) {
  const lines = String(text === undefined || text === null ? '' : text).split(/\r?\n/)
  let at = -1
  for (let i = 0; i < lines.length; i++) {
    const h = parseEntryHeader(lines[i])
    if (h !== null && h.version === version) { at = i; break }
  }
  if (at === -1) return null
  const header = parseEntryHeader(lines[at])
  let end = at + 1
  while (end < lines.length && !lines[end].startsWith('## ')) end++
  return { version: header.version, title: header.title, body: lines.slice(at + 1, end).join('\n').trim() }
}

/** npm tarball file name for a package name + version (scoped names fold the slash). */
export function packTarballName(name, version) {
  return String(name).replace(/^@/, '').replace(/\//g, '-') + '-' + version + '.tgz'
}

/** Release body: the CHANGELOG entry plus what the attached asset is. */
export function releaseNotes(section, tarballName) {
  const body = (section && section.body) || ''
  return body + '\n\n---\n\nPrebuilt plugin bundle attached: `' + tarballName + '` (`npm pack` of this tag).\n'
}

/** `gh` argv: the first publish creates the release, a re-run uploads into it. */
export function ghReleaseArgs({ version, tarball, notesFile, exists }) {
  const tag = 'v' + version
  if (exists) return ['release', 'upload', tag, tarball, '--clobber']
  return ['release', 'create', tag, tarball, '--title', tag, '--notes-file', notesFile]
}

/** What to print when the asset could not be published automatically. */
export function manualAssetHint(version, tarballName) {
  const tag = 'v' + version
  return [
    'GitHub Release ' + tag + ' was NOT published automatically (the commit and tag are already pushed).',
    'Publish it by hand, or re-run once the tooling is available: node scripts/release.mjs assets',
    '  npm pack',
    '  gh release create ' + tag + ' ' + tarballName + ' --title ' + tag + ' --notes-file <CHANGELOG section>',
  ].join('\n')
}

/**
 * The project-level .npmrc body that injects the auth token for exactly this
 * one publish, without touching the user's global config. npm itself reads no
 * token from the environment (NODE_AUTH_TOKEN is only honored through .npmrc
 * templating), so publishToNpm writes this file, publishes, and removes it
 * again in a finally.
 */
export function npmrcAuthLine(token) {
  return '//registry.npmjs.org/:_authToken=' + token + '\n'
}

/** What to print when the npm publish could not run or failed. */
export function manualNpmHint(version, detail) {
  return [
    'npm publish did NOT happen (' + detail + '). Everything git-side is already durable.',
    'Publish by hand from this checkout (package.json is already v' + version + '):',
    '  npm publish --access public',
    'Note: an account with 2FA needs an Automation-type token (granular tokens are rejected at publish time).',
  ].join('\n')
}

/**
 * Where to look for the GitHub CLI: PATH first, then the usual install
 * locations — a script launched by the host does not always inherit the
 * interactive shell's PATH.
 */
export function ghCandidates(platform = process.platform, env = process.env) {
  const list = ['gh']
  if (platform === 'win32') {
    const pf = env.ProgramFiles || 'C:\\Program Files'
    const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    list.push(path.join(pf, 'GitHub CLI', 'gh.exe'), path.join(pf86, 'GitHub CLI', 'gh.exe'))
  } else {
    list.push('/usr/local/bin/gh', '/opt/homebrew/bin/gh', '/usr/bin/gh')
  }
  return list
}

function resolveGh() {
  for (const cand of ghCandidates()) {
    if (spawnCaptured(cand, ['--version'], { okNonZero: true, probe: true }).status === 0) return cand
  }
  return undefined
}

/**
 * Run `npm`. On Windows npm is a .cmd shim and Node refuses to spawn .cmd/.bat
 * without a shell (ENOENT for `npm`, EINVAL for `npm.cmd` — both verified), so
 * we run npm's own CLI through the current node binary instead: no shell, no
 * argument escaping, no deprecation warning. POSIX spawns `npm` directly.
 */
function npmSpawn(args, cwd) {
  const opts = { okNonZero: true, cwd }
  if (process.platform !== 'win32') return spawnCaptured('npm', args, opts)
  const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (existsSync(cli)) return spawnCaptured(process.execPath, [cli, ...args], opts)
  return spawnCaptured('npm.cmd', args, { ...opts, shell: true })
}

function warnAssets(version, tarballName, detail) {
  console.log('warning: ' + detail)
  console.log(manualAssetHint(version, tarballName))
}

/**
 * Publish the GitHub Release for `version` and attach its prebuilt tarball.
 * Idempotent (an existing release gets the asset re-uploaded with --clobber)
 * and non-throwing: it reports failure by returning false so the caller can
 * decide whether the outcome is fatal.
 */
export function publishReleaseAssets(version) {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const tarballName = packTarballName(pkg.name, version)
  const section = changelogSection(readFileSync(changelogPath, 'utf8'), version)
  if (section === null) {
    warnAssets(version, tarballName, 'CHANGELOG has no entry for ' + version + ' — cannot build release notes.')
    return false
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-taskfold-assets-'))
  try {
    const packed = npmSpawn(['pack', '--pack-destination', dir])
    const tarball = path.join(dir, tarballName)
    if (packed.status !== 0 || !existsSync(tarball)) {
      warnAssets(version, tarballName, '`npm pack` did not produce ' + tarballName + '.')
      return false
    }
    const gh = resolveGh()
    if (gh === undefined) {
      warnAssets(version, tarballName, 'the GitHub CLI (`gh`) is missing or not logged in.')
      return false
    }
    const notesFile = path.join(dir, 'release-notes.md')
    writeFileSync(notesFile, releaseNotes(section, tarballName))
    const exists = spawnCaptured(gh, ['release', 'view', 'v' + version], { okNonZero: true }).status === 0
    const r = spawnCaptured(gh, ghReleaseArgs({ version, tarball, notesFile, exists }), { okNonZero: true })
    if (r.status !== 0) {
      warnAssets(version, tarballName, '`gh release ' + (exists ? 'upload' : 'create') + '` failed: ' + String(r.stderr || '').trim())
      return false
    }
    console.log('GitHub Release v' + version + ' published with ' + tarballName + (exists ? ' (asset re-uploaded)' : '') + '.')
    return true
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch (err) {}
  }
}

/**
 * Parse `reg query HKCU\Environment /v NPM_TOKEN` output: the Windows
 * user-level variable, which a stale process environment can hide.
 */
export function parseRegQueryToken(stdout) {
  for (const line of String(stdout === undefined || stdout === null ? '' : stdout).split(/\r?\n/)) {
    const m = line.match(/^\s*NPM_TOKEN\s+REG_(?:SZ|EXPAND_SZ)\s+(.+?)\s*$/i)
    if (m) return m[1]
  }
  return undefined
}

/** The publish token: the process environment first, then the Windows user scope. */
function resolveNpmToken() {
  const fromProcess = process.env.NPM_TOKEN
  if (typeof fromProcess === 'string' && fromProcess.length > 0) return fromProcess
  if (process.platform !== 'win32') return undefined
  const r = spawnCaptured('reg', ['query', 'HKCU\\Environment', '/v', 'NPM_TOKEN'], { probe: true })
  if (r.status !== 0) return undefined
  return parseRegQueryToken(r.stdout)
}

/**
 * The version `npm` targets: an explicit `--version` wins, otherwise the top
 * CHANGELOG entry — which must be a RELEASED one. A draft is not a version the
 * registry can already hold, and this script never guesses.
 */
export function resolveNpmVersion({ requested, top }) {
  if (requested !== undefined) {
    if (!/^\d+\.\d+\.\d+$/.test(String(requested))) {
      return { ok: false, reason: 'malformed version (only strict X.Y.Z is supported): ' + String(requested) }
    }
    return { ok: true, version: String(requested) }
  }
  if (top === null) {
    return { ok: false, reason: 'CHANGELOG has no parseable version entry — pass --version X.Y.Z.' }
  }
  if (top.kind === 'draft') {
    return { ok: false, reason: 'top CHANGELOG entry is an unreleased draft (' + top.version + ') — release it first, or pass --version X.Y.Z for an already-released version.' }
  }
  return { ok: true, version: top.version }
}

/**
 * Every guard `npm` checks before publishing. They all exist because npm ships
 * the WORKING TREE: the version in package.json, the local release tag, a clean
 * tree, and a tree identical to that tag. A checkout that carries work the
 * release does not would put unreleased files on the registry under a released
 * version number — the one thing this command must never do.
 */
export function checkNpmTarget({ version, packageVersion, hasTag, treeMatches, dirty }) {
  if (packageVersion !== version) {
    return { ok: false, reason: 'package.json is v' + packageVersion + ', not v' + version + ' — check out that release first: git switch --detach v' + version }
  }
  if (!hasTag) {
    return { ok: false, reason: 'tag v' + version + ' does not exist locally — nothing released to publish.' }
  }
  if (dirty.length > 0) {
    return { ok: false, reason: 'working tree dirty (' + dirty.join(', ') + ') — `npm publish` ships the working tree, not the tag; commit or stash first.' }
  }
  if (!treeMatches) {
    return { ok: false, reason: 'this checkout differs from tag v' + version + ' (it carries work the release does not) — publishing would put those files on the registry under a released version; publish from the tag instead: git switch --detach v' + version }
  }
  return { ok: true, version }
}

/**
 * True when one strict `X.Y.Z` range covers `version`. Only the three shapes
 * this repo actually declares are accepted (`^X.Y.Z`, `~X.Y.Z`, `X.Y.Z`);
 * anything else is not a range this guard can vouch for, so it returns false
 * and the caller reports the dependency as unsatisfiable.
 */
function rangeIncludes(range, version) {
  const base = range.replace(/^[\^~]/, '')
  let parts
  try {
    parts = semverParts(base)
    semverParts(version)
  } catch (err) {
    return false
  }
  if (range.startsWith('^')) {
    return parts[0] === 0
      ? (parts[1] === 0 ? version === base : version.startsWith('0.' + parts[1] + '.'))
      : version.startsWith(parts[0] + '.')
  }
  if (range.startsWith('~')) return version.startsWith(parts[0] + '.' + parts[1] + '.')
  return version === base
}

/**
 * Ship-guard: the browser row in `cordis.patch.yml` is mounted by the BARE
 * package name `dsh-taskfold-client`, and client-modules only accepts a row
 * name that is path-like or an exact bare package name. A profile therefore
 * has to resolve that name through its own node_modules, which makes the
 * declaration in `dependencies` load-bearing — and makes its FORM the whole
 * defect class this guard exists for.
 *
 * 0.38.0 shipped `"file:./client"` and every install died with
 * `ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND: Could not install from "<profile>/client"`:
 * pnpm resolves a path specifier against the CONSUMER workspace root, not
 * against the package that declares it, so the nested directory is looked for
 * one level above the profile. `link:` and `workspace:` fail differently
 * (`workspace:*` is not a member of a consumer's workspace; `link:` installs
 * without ever creating a resolvable `node_modules/dsh-taskfold-client`). The
 * only declaration a consumer can install is a registry version range, which
 * means the client must be a published package of its own.
 *
 * Nothing downstream can catch this: unit tests run inside this repo, where the
 * nested directory is simply there. The failure is only visible from a
 * consumer's pnpm, and only after the release is on the registry and every user
 * has hit it. So it is checked here, before either manifest is written.
 *
 * @param {string} [root] - repo root to check; defaults to this repo.
 * @param {string} [intendedClient] - version the release is about to write into
 *   client/package.json; omitted when checking a tree as it already stands.
 * @returns {{ spec: string, version: string, name: string }} the validated pair.
 * @throws when the client could not reach a consumer's node_modules.
 */
export function assertClientDependencyResolvable(root = repoRoot, intendedClient = undefined) {
  const rootManifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  const spec = (rootManifest.dependencies || {})['dsh-taskfold-client']
  if (typeof spec !== 'string' || spec === '') {
    throw new Error('ship-guard: package.json declares no "dsh-taskfold-client" dependency — the browser row mounts that package by bare name, so a profile cannot resolve it without this declaration')
  }
  if (/^(?:file|link|portal|workspace):/.test(spec)) {
    throw new Error(
      'ship-guard: "dsh-taskfold-client" is declared as "' + spec + '" — pnpm resolves a path specifier against the CONSUMER workspace root, not the dependant package, so every install fails with ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND. Declare a registry version range instead (the client is its own published package).'
    )
  }
  if (!/^[\^~]?\d+\.\d+\.\d+$/.test(spec)) {
    throw new Error('ship-guard: "dsh-taskfold-client" must be a registry version range (^X.Y.Z, ~X.Y.Z or X.Y.Z), not "' + spec + '"')
  }
  const clientPath = path.join(root, 'client', 'package.json')
  if (!existsSync(clientPath)) {
    throw new Error('ship-guard: client/package.json is missing — the client package is published from this directory')
  }
  const client = JSON.parse(readFileSync(clientPath, 'utf8'))
  if (client.name !== 'dsh-taskfold-client') {
    throw new Error('ship-guard: client/package.json is named "' + client.name + '", not "dsh-taskfold-client"')
  }
  if (client.private === true) {
    throw new Error('ship-guard: client/package.json is "private": true — npm publish refuses a private package, so the version the root now depends on could never reach the registry')
  }
  if (client.dsh === undefined || client.dsh.client === undefined || client.dsh.client.platform !== 'web') {
    throw new Error('ship-guard: client/package.json does not declare dsh.client.platform === "web" — client-modules would never mount this row')
  }
  if (!client.exports || typeof client.exports['./client'] !== 'string') {
    throw new Error('ship-guard: client/package.json exports no "./client" bundle — client-modules requires the mounted package to export it')
  }
  /* Two callers, two readings of "which version".
   *
   * `release` runs this BEFORE it writes anything, and at that moment the client
   * legitimately still carries the PREVIOUS version — the bump is the script's
   * next step. So an intended version is checked for what the release must be:
   * a strict X.Y.Z the declared range will cover. Demanding on-disk equality
   * there would refuse every release, because the file cannot be both un-bumped
   * and bumped at once.
   *
   * `npm` publishes an already-finalized tree, so it checks the release that IS:
   * the client's own version must equal the version being published (the lockstep
   * rule) and the declared range must cover it. */
  if (intendedClient !== undefined) {
    if (!/^\d+\.\d+\.\d+$/.test(String(intendedClient))) {
      throw new Error('ship-guard: the release version must be strict X.Y.Z, got ' + String(intendedClient))
    }
    if (!rangeIncludes(spec, intendedClient)) {
      throw new Error('ship-guard: the dependency "' + spec + '" does not include this release\'s client version ' + intendedClient + ' — the registry entry for the required version would be missing')
    }
    return { spec, version: intendedClient, name: client.name }
  }
  const version = client.version
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error('ship-guard: client version must be strict X.Y.Z, got ' + String(version))
  }
  if (!rangeIncludes(spec, version)) {
    throw new Error('ship-guard: the dependency "' + spec + '" does not include the client version ' + version + ' — the registry entry for the required version would be missing')
  }
  return { spec, version, name: client.name }
}

/**
 * Publish `version` to npm. Shared by `release` (opt-in, and its result is
 * deliberately ignored there: everything git-side is durable before this runs,
 * so a missing token or a failed upload must never fail the release) and by the
 * standalone `npm` repair command, which exits non-zero for anything but a
 * publish or an already-present version. Idempotent: a version already on the
 * registry is a no-op, so resumed, re-run and hand-repaired releases are safe.
 *
 * TWO packages publish, CLIENT FIRST. The browser half is its own registry
 * package (`dsh-taskfold-client`) because the root mounts that row by bare
 * package name: a profile resolves the row through its own node_modules, so a
 * version range is the only declaration a consumer's pnpm can install. The
 * order is a correctness rule, not a preference — the root's manifest depends
 * on the client's version, so a root published first would 404 for every
 * consumer until the client landed. Each package is probed and published on its
 * own, so a re-run finishes whichever half is missing. Any status but
 * 'published'/'already' stops the loop: publishing the root over an unpublished
 * client is the exact failure this order exists to prevent.
 *
 * Returns 'published' | 'already' | 'no-token' | 'refused' | 'failed'.
 */
export function publishOrder(root = repoRoot) {
  const rootManifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  return [
    { name: 'dsh-taskfold-client', dir: path.join(root, 'client') },
    { name: rootManifest.name, dir: root }
  ]
}

function publishToNpm(version) {
  const token = resolveNpmToken()
  if (token === undefined) {
    console.log('npm publish skipped: no NPM_TOKEN (checked the process environment and, on Windows, the user-level variable).')
    return 'no-token'
  }
  let status = 'already'
  for (const target of publishOrder()) {
    const pkgPathHere = path.join(target.dir, 'package.json')
    if (!existsSync(pkgPathHere)) {
      console.log(manualNpmHint(version, 'package manifest missing for ' + target.name + ': ' + pkgPathHere))
      return 'failed'
    }
    const pkgName = JSON.parse(readFileSync(pkgPathHere, 'utf8')).name
    const live = npmSpawn(['view', pkgName + '@' + version, 'version'])
    if (live.status === 0 && (live.stdout || '').trim() === version) {
      console.log('npm: ' + pkgName + '@' + version + ' is already on the registry — nothing to publish.')
      continue
    }
    const npmrc = path.join(target.dir, '.npmrc')
    if (existsSync(npmrc)) {
      console.log(manualNpmHint(version, 'a project .npmrc already exists at ' + npmrc + ' — refusing to overwrite it'))
      return 'refused'
    }
    try {
      writeFileSync(npmrc, npmrcAuthLine(token))
      const pub = npmSpawn(['publish', '--access', 'public'], target.dir)
      if (pub.status !== 0) {
        const first = String(pub.stderr || pub.stdout || '').trim().split(/\r?\n/)[0]
        console.log(manualNpmHint(version, '`npm publish` failed for ' + pkgName + ': ' + first))
        return 'failed'
      }
      console.log('npm: ' + pkgName + '@' + version + ' published.')
      status = 'published'
    } finally {
      try { unlinkSync(npmrc) } catch (err) { /* already gone */ }
    }
  }
  return status
}

// ── commands ──────────────────────────────────────────────────────────────

function cmdDraft(opts) {
  const st = gatherState(undefined)
  if (st.state !== 'CLEAN') {
    report(st.state, st.reason)
    if (st.state === 'DRAFT' && opts.force) {
      // --force: drop the existing top draft, regenerate from the tag baseline.
      const text = readFileSync(changelogPath, 'utf8')
      const lines = text.split(/\r?\n/)
      let i = 0
      while (i < lines.length && !lines[i].startsWith('## ')) i++
      let j = i + 1
      while (j < lines.length && !lines[j].startsWith('## ')) j++
      lines.splice(i, j - i)
      writeFileSync(changelogPath, lines.join('\n'))
      console.log('--force: removed the previous draft entry')
    } else {
      console.error('\ndraft requires a CLEAN state (review/commit or release the draft first).')
      process.exit(1)
    }
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const tag = baselineTag(pkg.version)
  const logArgs = tag !== undefined ? ['log', 'v' + tag + '..HEAD'] : ['log', '--reverse', 'HEAD']
  logArgs.push('--pretty=%s%x1f%b%x1e')
  const log = git(logArgs).stdout
  const KNOWN_TYPES = new Set(['feat', 'fix', 'perf', 'refactor', 'test', 'docs', 'chore'])
  const groups = {}
  const commits = []
  for (const record of (log || '').split('\x1e')) {
    if (!record.trim()) continue
    const [subject, body] = record.split('\x1f')
    const c = parseConventional(subject.trim())
    c.breaking = c.breaking || /^BREAKING CHANGE:/m.test(body || '')
    if (c.type === 'chore' && /^chore\(release\)/.test(subject)) continue
    commits.push(c)
    const key = KNOWN_TYPES.has(c.type) ? c.type : 'other'
    ;(groups[key] = groups[key] || []).push(c.subject)
  }
  let version = nextVersion(pkg.version, commits)
  if (opts.version) {
    semverParts(opts.version) // validate
    if (opts.version !== version) console.log('warning: --version ' + opts.version + ' overrides the inferred ' + version)
    version = opts.version
  }
  // Channel branches share one tag namespace: a version already tagged (most
  // likely by the other channel's release) can never be tagged here — reject
  // at draft time with guidance instead of dying at `git tag` during release.
  if (tagExists(version)) {
    console.error('tag v' + version + ' already exists — the version is taken (possibly by the other channel\'s release); pass --version with a free number.')
    process.exit(1)
  }
  const title = commits.length === 0 ? '(no changes)' : summarizeTitle(commits)
  assertClientBundleFresh()
  insertDraft(renderEntry(version, title, today(), groups))
  console.log('Draft ' + version + ' written to CHANGELOG.md — review/edit it, then run: node scripts/release.mjs release')
  console.log('Reminder: after a dsh upgrade (or any change to the fold envelope), run "node scripts/verify-cache.mjs --since-restart" against a live session log and record the numbers in the CHANGELOG entry — it exits non-zero when a fold re-pays its span.')
  console.log('Reminder: if this release changes which dsh versions are supported, update the "Supported dsh versions" section in BOTH READMEs (README.md + README.zh.md) before releasing. Each branch records ONLY its own build\'s verification: one newest-version entry for its home channel (delete superseded ones) and, for the other channel, a LINK to the other branch\'s README — never a copied number.')
}

function summarizeTitle(commits) {
  const feat = commits.find((c) => c.type === 'feat')
  const fix = commits.find((c) => c.type === 'fix')
  const pick = feat || fix || commits[0]
  return pick ? pick.subject : 'maintenance'
}

function remoteHasTag(version) {
  // Network probe used only by release; failures degrade to "unknown" (undefined)
  try {
    const r = git(['ls-remote', '--tags', 'origin', 'v' + version], { okNonZero: true })
    return (r.stdout || '').trim() !== ''
  } catch (err) {
    return undefined
  }
}

/**
 * Ship-guard: the browser bundle is a COMMITTED generated artifact (the host
 * serves its raw bytes), so a stale one would ship silently. Every release
 * path must fail before writing anything when the committed bytes differ from
 * a fresh render of plugins/task-stack-ui.mjs through the envelope template.
 *
 * Both sides go through build-client.mjs' own helpers (clientBundlePath +
 * repoBundleText) and both default to THIS repo's root: an earlier version
 * called them with no arguments at all, which does not throw here but crashes
 * on an undefined root — a guard is only a guard once it is exercised.
 * Exported so the offline suite can run the exact call the release makes.
 * @param {string} [root] - repo root to check; defaults to this repo.
 */
export function assertClientBundleFresh(root = repoRoot) {
  const current = readFileSync(clientBundlePath(root), 'utf8')
  if (current !== repoBundleText(root)) {
    throw new Error('client/taskfold-client.mjs is stale — run `node scripts/build-client.mjs` and commit the regenerated bundle first')
  }
}

function cmdRelease() {
  let st = gatherState(undefined)
  if (st.state === 'CLEAN') {
    // Local view cannot distinguish PENDING from CLEAN; probe the remote tag.
    st = gatherState(remoteHasTag(st.version))
  }
  if (st.state === 'PENDING') {
    console.log('PENDING release v' + st.version + ' detected — resuming pushes only.')
    pushRelease(st.version)
    console.log('Release v' + st.version + ' fully pushed.')
    publishReleaseAssets(st.version)
    publishToNpm(st.version)
    return
  }
  if (st.state !== 'DRAFT') {
    report(st.state, st.reason)
    if (st.state === 'INVALID') console.log('INVALID states are repaired by hand; this script never rewrites versions for you.')
    process.exit(1)
  }
  const version = st.version
  assertClientBundleFresh()
  // Pre-write guard: the client's version is about to change, so validate the
  // pair the release will leave behind rather than the tree as it stands.
  assertClientDependencyResolvable(repoRoot, version)
  // Non-blocking guard: both READMEs must declare the supported-dsh section.
  for (const readme of ['README.md', 'README.zh.md']) {
    const text = readFileSync(path.join(repoRoot, readme), 'utf8')
    if (!/Supported dsh versions|支持的 dsh 版本/.test(text)) {
      console.log('warning: ' + readme + ' is missing the "Supported dsh versions" section — add it before the next release.')
    }
  }
  const date = today()
  const lines = readFileSync(changelogPath, 'utf8').split(/\r?\n/)
  const i = lines.findIndex((l) => l.startsWith('## '))
  lines[i] = finalizeDraftHeader(lines[i], date)
  writeFileSync(changelogPath, lines.join('\n'))
  const pkgText = readFileSync(pkgPath, 'utf8')
  const newPkg = pkgText.replace(new RegExp('"version"\\s*:\\s*"[^"]*"'), '"version": "' + version + '"')
  if (newPkg === pkgText) throw new Error('failed to update package.json version field')
  writeFileSync(pkgPath, newPkg)
  // The nested browser-bundle package (client/package.json) releases in lockstep
  // with the root: bump and stage it too, or its version drifts from the tag.
  const clientPkgPath = path.join(repoRoot, 'client', 'package.json')
  const staged = ['CHANGELOG.md', 'package.json']
  if (existsSync(clientPkgPath)) {
    const clientPkgText = readFileSync(clientPkgPath, 'utf8')
    const newClientPkg = clientPkgText.replace(new RegExp('"version"\\s*:\\s*"[^"]*"'), '"version": "' + version + '"')
    if (newClientPkg !== clientPkgText) {
      writeFileSync(clientPkgPath, newClientPkg)
      staged.push('client/package.json')
    }
  }
  git(['add', ...staged])
  git(['commit', '-m', 'chore(release): v' + version])
  git(['tag', 'v' + version])
  console.log('Committed and tagged v' + version + '.')
  pushRelease(version)
  console.log('Release v' + version + ' fully pushed.')
  publishReleaseAssets(version)
  publishToNpm(version)
}

// The remote branch release pushes must reconcile against: HEAD's upstream
// when set, else the first of origin/master / origin/main that exists, else
// '' (no divergence check possible — push HEAD and let the server judge).
function remoteBranch() {
  try {
    const up = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { okNonZero: true })
    const name = (up.stdout || '').trim()
    if (up.status === 0 && name !== '' && name !== '@{u}') return name
  } catch (err) { /* no upstream configured */ }
  for (const cand of ['origin/master', 'origin/main']) {
    try {
      if (git(['rev-parse', '--verify', '--quiet', cand], { okNonZero: true }).status === 0) return cand
    } catch (err) { /* keep probing */ }
  }
  return ''
}

function pushRelease(version) {
  // Refuse non-fast-forward pushes up front instead of half-pushing.
  git(['fetch', 'origin'])
  const upstream = remoteBranch()
  if (upstream !== '') {
    const remote = git(['rev-parse', upstream]).stdout.trim()
    if (remote !== '') {
      const anc = git(['merge-base', '--is-ancestor', upstream, 'HEAD'], { okNonZero: true })
      if (anc.status !== 0) {
        console.error(upstream + ' has diverged from HEAD. The local tag/commit were NOT pushed.')
        console.error('Recover by hand: git tag -d v' + version + ' && git reset --hard ' + upstream + ', then re-run draft (CHANGELOG edits are lost to the reset — re-apply or use git stash).')
        process.exit(1)
      }
    }
  }
  const fail = (which) => {
    console.error(which + ' push failed (network / credentials / sandbox are all possible — not guessing).')
    console.error('Everything up to the push is durable. Re-run `node scripts/release.mjs release` to resume, or push manually:')
    console.error('  git push origin v' + version + ' && git push origin HEAD')
    process.exit(1)
  }
  if (git(['push', 'origin', 'v' + version], { okNonZero: true }).status !== 0) fail('tag')
  if (git(['push', 'origin', 'HEAD'], { okNonZero: true }).status !== 0) fail(upstream !== '' ? upstream : 'branch')
}

function cmdStatus() {
  let st
  try {
    st = gatherState(undefined)
  } catch (err) {
    console.error(String(err.message))
    process.exit(1)
  }
  report(st.state, st.reason)
  if (st.state === 'INVALID') {
    console.log('\nRepair by hand — this script never rewrites versions for you. Common fixes:')
    console.log('  package.json behind CHANGELOG top  -> set package.json version to match, or revert the stray CHANGELOG entry')
    console.log('  tag != CHANGELOG top               -> delete the stray tag (git tag -d vX.Y.Z) or add the missing entry')
    process.exit(1)
  }
}

/**
 * `npm`: (re)publish an already-released version to the registry. The repair
 * path for a release whose npm step was skipped (no token at the time) or
 * failed — `release` cannot do that job, because a fully-pushed release is
 * CLEAN and only PENDING resumes its pushes. Idempotent through publishToNpm's
 * registry probe. Unlike `release`, a failure here exits 1: publishing is the
 * whole point of running this.
 */
function cmdNpm(opts) {
  const top = readTopEntry()
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const resolved = resolveNpmVersion({ requested: opts.version, top })
  if (!resolved.ok) {
    console.error(resolved.reason)
    process.exit(1)
  }
  const version = resolved.version
  const dirty = dirtyFiles()
  const hasTag = tagExists(version)
  const treeMatches = hasTag && treeMatchesTag(version)
  console.log('npm target    : v' + version + (opts.version === undefined ? ' (CHANGELOG top)' : ' (--version)'))
  console.log('package.json  : ' + pkg.version)
  console.log('local tag     : ' + (hasTag ? 'v' + version + (treeMatches ? ' (working tree matches it)' : ' (working tree DIFFERS)') : '(missing)'))
  console.log('dirty files   : ' + (dirty.join(', ') || '(none)'))
  const check = checkNpmTarget({ version, packageVersion: pkg.version, hasTag, treeMatches, dirty })
  if (!check.ok) {
    console.error('\n' + check.reason)
    process.exit(1)
  }
  try {
    assertClientBundleFresh()
  } catch (err) {
    console.error(String(err.message))
    process.exit(1)
  }
  try {
    assertClientDependencyResolvable()
  } catch (err) {
    console.error(String(err.message))
    process.exit(1)
  }
  const status = publishToNpm(version)
  if (status !== 'published' && status !== 'already') process.exit(1)
}

/**
 * `assets`: (re)publish the GitHub Release + tarball for an already-released
 * version. This is the repair path for releases that went out before the flow
 * attached assets, and the retry path after a failed upload. Unlike the release
 * command it exits 1 on failure — attaching the asset is the whole point here.
 */
function cmdAssets(opts) {
  const top = readTopEntry()
  if (top === null) {
    console.error('CHANGELOG has no parseable version entry.')
    process.exit(1)
  }
  if (top.kind === 'draft') {
    console.error('top CHANGELOG entry is an unreleased draft (' + top.version + ') — release it first.')
    process.exit(1)
  }
  const version = opts.version || top.version
  const tagged = git(['rev-parse', '--verify', '--quiet', 'v' + version], { okNonZero: true }).status === 0
  if (!tagged) {
    console.error('tag v' + version + ' does not exist locally — nothing to publish.')
    process.exit(1)
  }
  if (!publishReleaseAssets(version)) process.exit(1)
}

// ── CLI entry ─────────────────────────────────────────────────────────────

function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const opts = {}
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--version') opts.version = rest[++i]
    else if (rest[i] === '--force') opts.force = true
  }
  if (cmd === 'draft') cmdDraft(opts)
  else if (cmd === 'release') cmdRelease()
  else if (cmd === 'npm') cmdNpm(opts)
  else if (cmd === 'assets') cmdAssets(opts)
  else if (cmd === 'status') cmdStatus()
  else {
    console.error('usage: node scripts/release.mjs draft [--version X.Y.Z] [--force] | release | npm [--version X.Y.Z] | assets [--version X.Y.Z] | status')
    console.error('  release also publishes to npm when a token is available (automation-type token).')
    console.error('  npm (re)publishes an already-released version to npm — the repair path when release skipped or failed that step.')
    process.exit(1)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main()
