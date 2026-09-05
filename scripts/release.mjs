#!/usr/bin/env node
// Release flow for dsh-taskfold. Design: docs/design/release-flow.md (workspace).
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
// Version numbers are strict `X.Y.Z` numerics; prerelease/build metadata are
// rejected. The only source of truth for the NEXT version is the CHANGELOG
// top entry; package.json is synced by this script, never by hand.
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, openSync, closeSync, unlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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
// happens, rerun the command with stdout backed by a temp file — git still
// runs, only the capture channel changes. stderr is discarded in that mode;
// the non-zero status is the error signal.
function git(args, opts) {
  let r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' })
  if (r.error && (r.error.code === 'EPERM' || r.error.code === 'ENOENT')) {
    const tmp = path.join(os.tmpdir(), 'dsh-release-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.out')
    let fd
    try {
      fd = openSync(tmp, 'w')
      const s = spawnSync('git', args, { cwd: repoRoot, stdio: ['ignore', fd, 'ignore'] })
      closeSync(fd); fd = undefined
      const stdout = readFileSync(tmp, 'utf8')
      return { status: s.status, stdout, stderr: '' }
    } finally {
      if (fd !== undefined) { try { closeSync(fd) } catch (err) {} }
      try { unlinkSync(tmp) } catch (err) {}
    }
  }
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

function latestTag() {
  const r = git(['tag', '--list', 'v*', '--sort=-v:refname'])
  const first = (r.stdout || '').split(/\r?\n/).find((l) => l.trim() !== '')
  return first ? first.replace(/^v/, '') : undefined
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
  const tag = latestTag()
  if (tag !== undefined) {
    const probe = git(['merge-base', '--is-ancestor', 'v' + tag, 'HEAD'], { okNonZero: true })
    if (probe.status !== 0) throw new Error('latest tag v' + tag + ' is not an ancestor of HEAD — tag diverged from master history')
  }
  return classifyState({ top: readTopEntry(), packageVersion: pkg.version, tagVersion: tag, dirty: dirtyFiles(), remoteHasTag })
}

function report(state, extra) {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  console.log('CHANGELOG top : ' + (readTopEntry() === null ? '(none)' : readTopEntry().version + ' (' + readTopEntry().kind + ')'))
  console.log('package.json  : ' + pkg.version)
  console.log('latest tag    : ' + (latestTag() === undefined ? '(none)' : 'v' + latestTag()))
  console.log('dirty files   : ' + (dirtyFiles().join(', ') || '(none)'))
  console.log('state         : ' + state + (extra ? ' — ' + extra : ''))
}

function today() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
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
  const tag = latestTag()
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
  const title = commits.length === 0 ? '(no changes)' : summarizeTitle(commits)
  insertDraft(renderEntry(version, title, today(), groups))
  console.log('Draft ' + version + ' written to CHANGELOG.md — review/edit it, then run: node scripts/release.mjs release')
  console.log('Reminder: if this release changes which dsh versions are supported, update the "Supported dsh versions" section in BOTH READMEs (README.md + README.zh.md) before releasing.')
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
    return
  }
  if (st.state !== 'DRAFT') {
    report(st.state, st.reason)
    if (st.state === 'INVALID') console.log('INVALID states are repaired by hand; this script never rewrites versions for you.')
    process.exit(1)
  }
  const version = st.version
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
  git(['add', 'CHANGELOG.md', 'package.json'])
  git(['commit', '-m', 'chore(release): v' + version])
  git(['tag', 'v' + version])
  console.log('Committed and tagged v' + version + '.')
  pushRelease(version)
  console.log('Release v' + version + ' fully pushed.')
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
  else if (cmd === 'status') cmdStatus()
  else {
    console.error('usage: node scripts/release.mjs draft [--version X.Y.Z] [--force] | release | status')
    process.exit(1)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main()
