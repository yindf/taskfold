// Shared span preview + JSONL artifact helpers for the taskfold bundle.
//
// CONTRACT: the preview lines task_fold prints and the lines of the JSONL
// artifact are derived from the SAME messages in the SAME order — line N of
// the artifact file is exactly what preview line N describes. The model can
// map a one-line preview back to its full original by line number. When a
// span exceeds the preview cap, the window is HEAD+TAIL: opening lines and
// closing lines are kept and the middle collapses into one elision pointer
// — shown lines always keep their TRUE 1-based numbers, so the line-N
// contract holds for the tail too.
//
// Kept dependency-free (node builtins only) so both bundle plugins can import
// it without touching the bundle patch — it is a plain module, not a row.

import nodePath from 'node:path'
import nodeFs from 'node:fs'
import nodeOs from 'node:os'

const TEXT_CLIP = 80
const LINE_CLIP = 200

function clip(text, max) {
  // Newlines become a visible ↵ marker: one preview line must stay one line,
  // but the model should still see where the original line breaks were.
  const flat = String(text).replace(/\s*\n+\s*/g, ' ↵ ').replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat
}

// One brief fragment per content block. Unknown block types degrade to their
// type name so the preview never crashes on a future harness block shape.
//
// Tool-specific rendering: common tools get a web-UI-style brief instead of
// raw arguments/output (read → full path + content excerpt, grep → pattern +
// match stats, pwsh → its description, edit → path + line delta). Correlating
// a tool-result with its call needs the call map built by collectToolCalls —
// blockBrief stays callable without it (generic formatters only).
// ── Tool-specific briefs (web-UI-style: short but pointed) ──────────────────

function parseArgs(argStr) {
  if (typeof argStr !== 'string' || argStr.length === 0) return {}
  try { return JSON.parse(argStr) } catch (err) { return {} }
}

function lineCount(s) {
  if (typeof s !== 'string' || s.length === 0) return 0
  return s.split('\n').length
}

// The CALL side (assistant message fragment): what the model asked for.
export function callBrief(name, argsStr) {
  const args = parseArgs(argsStr)
  const tool = String(name === undefined ? 'tool' : name)
  if (tool === 'read') return '→read ' + String(args.file_path === undefined ? '?' : args.file_path)
  if (tool === 'write') return '→write ' + String(args.file_path === undefined ? '?' : args.file_path)
  if (tool === 'edit') {
    const added = lineCount(args.new_string)
    const removed = lineCount(args.old_string)
    return '→edit ' + String(args.file_path === undefined ? '?' : args.file_path) + ' +' + added + ' -' + removed
  }
  if (tool === 'grep') return '→grep "' + clip(args.pattern === undefined ? '' : args.pattern, 60) + '"' + (args.include !== undefined ? ' (' + args.include + ')' : '')
  if (tool === 'pwsh') {
    // description is the best label but is model-provided and may be empty —
    // fall back to a slice of the command itself.
    const label = typeof args.description === 'string' && args.description.trim().length > 0 ? args.description : String(args.command === undefined ? '' : args.command)
    return '→pwsh ‹' + clip(label, 60) + '›'
  }
  return '→' + tool + '(' + clip(argsStr === undefined ? '' : argsStr, TEXT_CLIP) + ')'
}

// Distinct file paths in grep-tool output lines. Output lines look like
// "path:line: text" (or "path:line-text"): the path is everything before
// the first colon that follows it. Windows absolute paths carry one colon
// after the drive letter, so a leading drive prefix is stripped first; a
// path must contain a separator to count (prose that merely resembles a
// filename does not). Covers absolute POSIX (/a/b.mjs), workspace-relative
// (src\a.mjs), and drive-absolute (C:\a\b.mjs) forms alike.
const GREP_FILE_LINE = /^(?:[A-Za-z]:)?([^\s:][^:]*[\\/][^\s:]*):\d/

function grepFilePaths(text) {
  const files = new Set()
  for (const line of String(text).split('\n')) {
    const m = line.match(GREP_FILE_LINE)
    if (m !== null) files.add(m[1])
  }
  return files
}

// The RESULT side (user message fragment): what came back, summarized per
// tool. Falls back to a generic excerpt for every other tool.
export function resultBrief(tool, inner) {
  const text = typeof inner === 'string' ? inner : ''
  if (tool === 'grep') {
    // Singular ("Found 1 match") and plural ("Found 2 matches") both parse —
    // `matches?` matched only "matche(s)" and silently degraded the singular
    // count line to a raw excerpt.
    const found = text.match(/Found (\d+) match(?:es)?/)
    if (found !== null) {
      const files = grepFilePaths(text)
      const nf = files.size > 0 ? files.size : (found[1] === '0' ? 0 : 1)
      return found[1] + (found[1] === '1' ? ' match' : ' matches') + ' · ' + nf + (nf === 1 ? ' file' : ' files')
    }
    return clip(text, TEXT_CLIP)
  }
  if (tool === 'read' || tool === 'edit' || tool === 'write') {
    // Tool results for file tools open with a <path>/<type> header; the
    // useful excerpt is the content, not the path repeated back.
    const cut = text.replace(/^<path>[^\n]*\n(<type>[^\n]*\n)?/, '')
    return clip(cut.length > 0 ? cut : text, TEXT_CLIP)
  }
  return clip(text, TEXT_CLIP)
}

// callId → { name, args } across the whole span, so a tool-result fragment
// (in a LATER user message) can be formatted for the tool that produced it.
export function collectToolCalls(messages) {
  const map = new Map()
  if (!Array.isArray(messages)) return map
  for (const m of messages) {
    if (m === null || typeof m !== 'object' || !Array.isArray(m.content)) continue
    for (const b of m.content) {
      if (b !== null && typeof b === 'object' && b.type === 'tool-call' && typeof b.id === 'string') {
        map.set(b.id, { name: b.name, args: b.arguments })
      }
    }
  }
  return map
}

export function blockBrief(block, calls) {
  if (block === null || typeof block !== 'object') return '?'
  if (block.type === 'text') return clip(block.text === undefined ? '' : block.text, TEXT_CLIP)
  if (block.type === 'reasoning') return '[think] ' + clip(block.text === undefined ? '' : block.text, TEXT_CLIP)
  if (block.type === 'tool-call') {
    return callBrief(block.name, block.arguments)
  }
  if (block.type === 'tool-result') {
    let inner = ''
    if (typeof block.text === 'string') inner = block.text
    else if (Array.isArray(block.content)) {
      inner = block.content.filter((b) => b !== null && typeof b === 'object' && typeof b.text === 'string').map((b) => b.text).join(' ')
    }
    const call = calls !== undefined && typeof block.toolCallId === 'string' ? calls.get(block.toolCallId) : undefined
    const brief = call === undefined ? clip(inner, TEXT_CLIP) : resultBrief(call.name, inner)
    return '←' + (block.isError === true ? 'ERROR: ' : '') + brief
  }
  return '[' + String(block.type === undefined ? 'block' : block.type) + ']'
}

// One preview line per message: `NN role: fragments`. The line number matches
// the message's 1-based position in the span — and its line in the JSONL
// artifact written by writeSpanArtifact.
// Role label: harness tool results arrive as user-role messages, and so do
// plugin-injected runtime-context snapshots — the preview distinguishes both
// from genuine user input. All-tool-result messages read `tool:`; messages
// whose source.kind is 'plugin' (runtime-context snapshots and the like) read
// `harness:`; everything else keeps its wire role.
export function messagePreviewLine(message, index, calls) {
  const role = message !== null && typeof message === 'object' && typeof message.role === 'string' ? message.role : '?'
  const blocks = message !== null && typeof message === 'object' && Array.isArray(message.content) ? message.content : []
  const allToolResults = blocks.length > 0 && blocks.every((b) => b !== null && typeof b === 'object' && b.type === 'tool-result')
  const fromPlugin = message !== null && typeof message === 'object' && message.source !== null && typeof message.source === 'object' && message.source.kind === 'plugin'
  const label = allToolResults ? 'tool' : fromPlugin ? 'harness' : role
  const joined = blocks.map((b) => blockBrief(b, calls)).join(' ')
  const body = joined.length > 0 ? joined : '(empty)'
  const numbered = String(index).padStart(3, ' ') + ' ' + label + ': ' + body
  return numbered.length > LINE_CLIP ? numbered.slice(0, LINE_CLIP - 1) + '…' : numbered
}

// The full preview block: a header plus one line per message — EVERY message,
// no elision window. Preview line N = the N-th message of the span = line N of
// the JSONL artifact = the message fold_recall({ fold, line: N }) returns.
export function renderSpanPreview(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return ['Span preview: (empty)']
  const lines = ['Span preview (' + messages.length + ' messages, one per line — same order/numbering as the JSONL artifact):']
  const calls = collectToolCalls(messages)
  for (let i = 0; i < messages.length; i += 1) lines.push(messagePreviewLine(messages[i], i + 1, calls))
  return lines
}

// Complete preview for the Fold archive section inside a summary node: every
// message line, no elision — the preview is the span's own index, and its line
// numbers are the recall coordinates (fold_recall line overload). The engine
// REJECTS a fold whose framed summary is not smaller than the shadowed span;
// each preview line is clipped to LINE_CLIP, so a full listing normally costs
// a small fraction of the span it indexes. The one defensive guard: a
// degenerate span (many near-empty messages) could break that assumption, so
// if the whole listing would rival the span itself, degrade to a header plus
// pointer rather than risk the engine rejecting the fold. Composition: the
// per-line rendering IS renderSpanPreview — this wrapper only adds the size
// guard, so the two previews can never drift apart.
export function renderArchivePreview(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return ['Span preview: (empty)']
  const header = 'Span preview (' + messages.length + ' messages, one per line — same order/numbering as the JSONL artifact):'
  const estChars = JSON.stringify(messages).length
  const lines = renderSpanPreview(messages)
  let previewChars = 0
  for (const line of lines) previewChars += line.length
  if (previewChars > estChars * 0.6) {
    return [header, '… full listing would rival the span itself — read the artifact file.']
  }
  return lines
}

// fold_recall's line overload: the exact original message at a 1-based span
// position — the same position a span-preview line and the JSONL artifact
// line carry, so a preview line number is directly recallable.
export function artifactLineAt(messages, line) {
  if (!Array.isArray(messages)) return { ok: false, error: 'no messages' }
  if (!Number.isInteger(line) || line < 1 || line > messages.length) {
    return { ok: false, error: 'line must be an integer in 1..' + Math.max(messages.length, 1) }
  }
  return { ok: true, message: messages[line - 1] }
}

// Artifact writer: JSONL, one message per line, in preview order. Each line
// is the message slimmed to {role, content} — the full original content
// blocks, without host provenance metadata (source/replayState/id): recall
// serves content recovery; audit metadata stays in the durable event log.
// Returns the file path, or undefined when writing fails (the fold itself
// must not fail because a diagnostic file could not be written).
function slugPart(raw, max) {
  // String(undefined) is "undefined" and String(12345) is "12345" — coerced
  // non-strings would silently create directories named after the coercion.
  // Only a real string may scope; anything else degrades to the empty slug.
  const text = typeof raw === 'string' ? raw : ''
  const slug = text.replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, max)
  return slug.length > 0 ? slug : ''
}

// Session-local artifact directory: the active persistence backend's own
// location for this session — locate() resolves the backend-owned JSONL log
// path, and its dirname is the per-session directory the backend documents
// as "available for future session-local artifacts". Backend-neutral by
// construction: no session-path encoding is replicated here. Anything
// missing (no backend via ctx.get, backend without per-session artifacts,
// no session header, locate() throwing) degrades to undefined, and the
// artifact writer falls back to the OS tmp root.
export function sessionArtifactDir(ctx, session) {
  try {
    const persistence = ctx !== null && typeof ctx === 'object' && typeof ctx.get === 'function' ? ctx.get('sessionPersistence') : undefined
    if (persistence === null || persistence === undefined || typeof persistence.locate !== 'function') return undefined
    const meta = session !== null && typeof session === 'object' ? session.header : undefined
    if (meta === null || meta === undefined) return undefined
    const located = persistence.locate(meta)
    const p = located !== null && typeof located === 'object' && typeof located.path === 'string' && located.path.length > 0 ? located.path : undefined
    return p === undefined ? undefined : nodePath.dirname(nodePath.resolve(p))
  } catch (err) {
    return undefined
  }
}

export function writeSpanArtifact(messages, nameKey, opts) {
  try {
    const o = opts !== null && typeof opts === 'object' ? opts : {}
    // Location precedence: (1) the session's own artifact directory (see
    // sessionArtifactDir) — artifacts live exactly as long as the session's
    // durable log, OS temp cleanup never sweeps them, and cross-session
    // mixing is impossible by construction; a taskfold/ subfolder keeps
    // them clear of backend-owned files. (2) the OS tmp root scoped by a
    // slugified session key — without scoping, that shared root interleaves
    // concurrent sessions' artifacts and leaks task names across them.
    // (3) the flat legacy tmp root when no usable key exists.
    const sessionDir = typeof o.sessionDir === 'string' && o.sessionDir.length > 0 ? nodePath.resolve(o.sessionDir) : ''
    let dir
    if (sessionDir !== '') {
      dir = nodePath.join(sessionDir, 'taskfold')
    } else {
      const root = nodePath.join(nodeOs.tmpdir(), 'taskfold-artifacts')
      const scope = slugPart(o.sessionKey, 64)
      dir = scope.length > 0 ? nodePath.join(root, scope) : root
    }
    nodeFs.mkdirSync(dir, { recursive: true })
    const slug = slugPart(nameKey, 60)
    const file = nodePath.join(dir, (slug.length > 0 ? slug : 'artifact') + '-' + Date.now().toString(36) + '.jsonl')
    const body = messages.map((m) => JSON.stringify(m !== null && typeof m === 'object' ? { role: m.role, content: m.content } : m)).join('\n') + '\n'
    nodeFs.writeFileSync(file, body, 'utf8')
    return file
  } catch (err) {
    return undefined
  }
}
