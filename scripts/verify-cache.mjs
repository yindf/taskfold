// Verify that fold summarization calls reuse the conversation's prefix cache.
//
// WHY THIS EXISTS
// A fold's summarizer request must be a strict prefix of the main conversation
// request: [system][tools][pre-span][span][instruction]. Then the provider
// serves everything up to the trailing instruction from its prefix cache and
// only that instruction (plus the summary output) is billed at full price.
//
// dsh 0.1.5-alpha.1 changed BasicCompactionEngine.buildSummarizationInput()
// from `{ system, tools, messages: regionMessages }` to
// `{ tools, messages: [system, ...regionMessages] }`. The plugin's prefix
// envelope already replays surface node 0, so the request became
// [system][pre-span][system][span][instruction]: the duplicated system head sat
// exactly at the span start, the cache broke there, and every folded span was
// paid for a second time. Measured on the session that found it: 8 folds,
// cacheRead == lastPrompt - span on every one, 201,196 tokens re-billed.
//
// Offline tests (test/fold-engine.test.mjs) can only assert the structural
// precondition — one system message, strict prefix. cacheReadTokens exists
// only in a live session log, so this script reads one and classifies each
// fold. Run it after every dsh upgrade, and before releasing when the fold
// envelope changed.
//
// PASS rule (per fold): uncached - span <= --tail-budget (default 3500). The
// discriminator is the SIGN of that difference, not the absolute uncached cost:
// a healthy fold can still leave a few thousand tokens uncached when a nested
// fold rewrote the middle of its span (fold 1303: uncached 5655, span 19796,
// tail -14141 — the span itself was fully cached). The regression always adds
// the whole span to the bill, so its tail stays positive: +3974 .. +18587
// measured across the eleven broken folds, versus -4806 / -5445 / -14141 on the
// three healthy ones. An optional --min-span guard skips folds too small to say
// anything.
//
// Usage:
//   node scripts/verify-cache.mjs [--log <session.jsonl.zstd>] [--session <id>]
//                                 [--last <n>] [--max-tail <tokens>]
//                                 [--min-span <tokens>] [--require] [--json]

import { zstdDecompressSync } from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const DEFAULT_TAIL_BUDGET = 3500
const DEFAULT_MIN_SPAN = 0

/** Decode a multi-frame zstd session log: scan frame magic, one-shot each frame. */
export function decodeSessionLog(buf) {
  const candidates = []
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) candidates.push(i)
  }
  candidates.push(buf.length)
  const parts = []
  let startIdx = 0
  while (startIdx < candidates.length - 1) {
    const start = candidates[startIdx]
    let decoded = null
    let usedEnd = -1
    for (let endIdx = startIdx + 1; endIdx < candidates.length; endIdx++) {
      try {
        decoded = zstdDecompressSync(buf.subarray(start, candidates[endIdx]))
        usedEnd = endIdx
        break
      } catch (err) { /* magic can appear inside a payload: extend to the next candidate */ }
    }
    if (decoded === null) throw new Error('undecodable zstd frame at byte ' + start)
    parts.push(decoded)
    startIdx = usedEnd
  }
  return parseEvents(Buffer.concat(parts).toString('utf8'))
}

/** Parse one event per line, skipping blank lines and recording undecodable ones. */
export function parseEvents(text) {
  const events = []
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    try {
      events.push(JSON.parse(line))
    } catch (err) {
      events.push({ type: 'PARSE_ERROR' })
    }
  }
  return events
}

/** Usage may sit on the event or on its recorded stream chunk. */
function usageOf(event) {
  const direct = event?.data?.usage
  if (direct !== undefined && direct !== null) return direct
  const chunks = event?.data?.stream
  if (Array.isArray(chunks)) {
    for (const entry of chunks) {
      const u = entry?.chunk?.usage
      if (u !== undefined && u !== null) return u
    }
  }
  return null
}

/**
 * One row per fold that recorded usage. `uncached` is what the provider billed
 * at full price; `span` is the shadowed token count the fold removed.
 */
export function foldRows(events) {
  const rows = []
  for (const e of events) {
    if (e?.type !== 'compaction/summary') continue
    const usage = usageOf(e)
    if (usage === null) continue
    const cacheRead = usage.cacheReadTokens ?? 0
    const prompt = (usage.inputTokens ?? 0) + cacheRead
    if (prompt <= 0) continue
    const span = e?.data?.shadowedTokenCount ?? 0
    const uncached = prompt - cacheRead
    rows.push({
      seq: e.seq,
      prompt,
      cacheRead,
      uncached,
      span,
      hit: cacheRead / prompt,
      tail: uncached - span,
    })
  }
  return rows
}

/**
 * Classify one fold by the sign of `uncached - span`.
 *   'pass'  — the span (or nearly all of it) came from cache: only the trailing
 *             instruction, plus any mid-span rewrite, was billed again
 *   'fail'  — uncached exceeds span by more than the instruction budget: the
 *             span was billed again, the duplicate-system regression signature
 *   'skip'  — span below --min-span: the sample cannot distinguish the two
 */
export function classifyFold(row, opts = {}) {
  const tailBudget = opts.tailBudget ?? DEFAULT_TAIL_BUDGET
  const minSpan = opts.minSpan ?? DEFAULT_MIN_SPAN
  if (row.span < minSpan) return { status: 'skip', reason: 'span ' + row.span + ' < min-span ' + minSpan }
  const tail = row.uncached - row.span
  if (tail > tailBudget) {
    return { status: 'fail', reason: 'uncached ' + row.uncached + ' - span ' + row.span + ' = ' + tail + ' > tail-budget ' + tailBudget }
  }
  return { status: 'pass', reason: 'uncached ' + row.uncached + ' - span ' + row.span + ' = ' + tail + ' <= tail-budget ' + tailBudget }
}

/** Seq of the newest `request/header reason=resume` (the last host restart), or null. */
export function lastResumeSeq(events) {
  let seq = null
  for (const e of events) {
    if (e?.type === 'request/header' && e?.data?.reason === 'resume' && typeof e.seq === 'number') seq = e.seq
  }
  return seq
}

/** Classify every row and summarize. `verdict` is 'pass' | 'fail' | 'no-data'. */
export function evaluate(events, opts = {}) {
  let all = foldRows(events)
  if (opts.sinceRestart === true) {
    const resume = lastResumeSeq(events)
    if (resume !== null) all = all.filter((r) => typeof r.seq === 'number' && r.seq > resume)
  }
  const rows = opts.last === undefined ? all : all.slice(-opts.last)
  const judged = rows.map((row) => ({ ...row, ...classifyFold(row, opts) }))
  const failures = judged.filter((r) => r.status === 'fail')
  const skipped = judged.filter((r) => r.status === 'skip')
  return {
    rows: judged,
    failures,
    skipped,
    verdict: judged.length === 0 ? 'no-data' : failures.length > 0 ? 'fail' : 'pass',
  }
}

/** Newest session log under $DSH_HOME/sessions, or null. */
export function findNewestLog(home = process.env.DSH_HOME) {
  if (home === undefined || home === '') return null
  const root = path.join(home, 'sessions')
  const found = []
  const walk = (dir) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (err) { return }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/^session(\.v\d+)?\.jsonl\.zstd$/.test(entry.name)) found.push(full)
    }
  }
  walk(root)
  let best = null
  for (const file of found) {
    // A file that vanished between the walk and the stat must not abort the
    // whole resolution — skip it and keep the newest survivor.
    let mtime
    try { mtime = fs.statSync(file).mtimeMs } catch (err) { continue }
    if (best === null || mtime > best.mtime) best = { file, mtime }
  }
  return best === null ? null : best.file
}

/**
 * One numeric flag value. `Number('abc')` is NaN and `slice(-NaN)` is
 * `slice(0)`: `--last abc` used to judge EVERY fold while looking scoped, so a
 * bad value has to be a usage error (exit 2), never a silent widening.
 */
export function numberArg(argv, index, flag, opts) {
  const o = opts === undefined ? {} : opts
  const min = o.min === undefined ? 0 : o.min
  const raw = argv[index]
  const value = Number(raw)
  if (raw === undefined || raw.trim() === '' || !Number.isFinite(value) || value < min || (o.integer === true && !Number.isInteger(value))) {
    throw new Error(flag + ' needs a ' + (o.integer === true ? 'whole number' : 'number') + ' >= ' + min + ' (got ' + String(raw) + ')')
  }
  return value
}

export function parseArgs(argv) {
  const opts = { tailBudget: DEFAULT_TAIL_BUDGET, minSpan: DEFAULT_MIN_SPAN }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--log') opts.log = argv[++i]
    else if (arg === '--session') opts.session = argv[++i]
    else if (arg === '--last') opts.last = numberArg(argv, ++i, '--last', { integer: true, min: 1 })
    else if (arg === '--since-restart') opts.sinceRestart = true
    else if (arg === '--tail-budget') opts.tailBudget = numberArg(argv, ++i, '--tail-budget')
    else if (arg === '--min-span') opts.minSpan = numberArg(argv, ++i, '--min-span')
    else if (arg === '--require') opts.require = true
    else if (arg === '--json') opts.json = true
    else if (arg === '--help' || arg === '-h') opts.help = true
    else throw new Error('unknown argument: ' + arg)
  }
  return opts
}

function resolveLog(opts) {
  if (opts.log !== undefined) return opts.log
  if (opts.session !== undefined) {
    const home = process.env.DSH_HOME ?? ''
    const dir = path.join(home, 'sessions')
    // Both scans are guarded: a missing or renamed sessions root must degrade
    // to the caller's clean "no session log found" (exit 2), never to a raw
    // ENOENT stack trace out of a diagnostic script.
    let projects
    try { projects = fs.readdirSync(dir) } catch (err) { return null }
    const hits = []
    for (const project of projects) {
      const candidate = path.join(dir, project, opts.session)
      if (fs.existsSync(candidate)) hits.push(candidate)
    }
    for (const dirPath of hits) {
      let names
      try { names = fs.readdirSync(dirPath) } catch (err) { continue }
      for (const name of names) {
        if (/^session(\.v\d+)?\.jsonl\.zstd$/.test(name)) return path.join(dirPath, name)
      }
    }
    return null
  }
  return findNewestLog()
}

const HELP = `Verify fold summarizer cache reuse from a live dsh session log.

  node scripts/verify-cache.mjs [options]

  --log <path>      session log to read (default: newest under $DSH_HOME/sessions)
  --session <id>    session id to resolve under $DSH_HOME/sessions
  --last <n>        judge only the last n folds
  --since-restart   judge only folds after the newest reason=resume request
                    header — the right scope right after a dsh upgrade
  --tail-budget <n> pass when uncached - span <= n (default ${DEFAULT_TAIL_BUDGET})
  --min-span <n>    skip folds whose span < n (default ${DEFAULT_MIN_SPAN}: none)
  --require         exit 1 when the log holds no fold to judge
  --json            machine-readable output

Exit codes: 0 pass / 1 regression (or --require with no data) / 2 usage error.`

function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(err.message)
    console.error(HELP)
    process.exit(2)
  }
  if (opts.help) { console.log(HELP); return }

  const log = resolveLog(opts)
  if (log === null || !fs.existsSync(log)) {
    console.error('no session log found — pass --log <session.jsonl.zstd>')
    process.exit(2)
  }
  const { rows, failures, skipped, verdict } = evaluate(decodeSessionLog(fs.readFileSync(log)), opts)

  if (opts.json) {
    console.log(JSON.stringify({ log, verdict, rows, failures: failures.length, skipped: skipped.length }, null, 2))
  } else {
    console.log('log: ' + log)
    console.log('fold  seq    hit%    cacheRead   uncached      span        tail    status')
    rows.forEach((r, i) => {
      console.log(
        String(i + 1).padStart(4),
        String(r.seq).padStart(5),
        (r.hit * 100).toFixed(1).padStart(7),
        String(r.cacheRead).padStart(11),
        String(r.uncached).padStart(10),
        String(r.span).padStart(9),
        String(r.tail).padStart(11),
        '   ' + r.status,
      )
    })
    console.log('')
    console.log('judged: ' + (rows.length - skipped.length) + '  pass: ' + (rows.length - skipped.length - failures.length)
      + '  fail: ' + failures.length + '  skipped: ' + skipped.length)
    for (const f of failures) console.log('FAIL seq ' + f.seq + ': ' + f.reason)
    for (const s of skipped) console.log('skip seq ' + s.seq + ': ' + s.reason)
  }

  if (verdict === 'fail') process.exit(1)
  if (verdict === 'no-data' && opts.require) {
    console.error('no fold with usage found in ' + log)
    process.exit(1)
  }
  if (verdict === 'no-data') console.log('no fold with usage found — nothing to verify (pass --require to fail instead)')
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main()
