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

// The RESULT side (user message fragment): what came back, summarized per
// tool. Falls back to a generic excerpt for every other tool.
export function resultBrief(tool, inner) {
  const text = typeof inner === 'string' ? inner : ''
  if (tool === 'grep') {
    const found = text.match(/Found (\d+) matches?/)
    if (found !== null) {
      const files = new Set()
      for (const m of text.matchAll(/\n([A-Za-z]:\\[^:\n]+\.m?js):/g)) files.add(m[1])
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

// The full preview block: a header plus one line per message, capped. When
// the span exceeds the cap the window is HEAD+TAIL: the opening lines and
// the closing lines are kept (the span's ending — final verification, the
// close — is exactly what a head-only window would cut) and the middle
// collapses into one elision pointer at the artifact file.
const TAIL_LINES = 4

function headTailSplit(total, cap) {
  if (total <= cap) return { head: total, tail: 0, elided: 0 }
  const tail = Math.max(1, Math.min(TAIL_LINES, cap - 2))
  const head = cap - tail - 1 // one line of the cap is spent on the pointer
  return { head, tail, elided: total - head - tail }
}

export function renderSpanPreview(messages, maxLines) {
  const cap = Number.isInteger(maxLines) && maxLines > 0 ? maxLines : 30
  if (!Array.isArray(messages) || messages.length === 0) return ['Span preview: (empty)']
  const lines = ['Span preview (' + messages.length + ' messages, one per line — same order/numbering as the JSONL artifact):']
  const calls = collectToolCalls(messages)
  const win = headTailSplit(messages.length, cap)
  for (let i = 0; i < win.head; i += 1) lines.push(messagePreviewLine(messages[i], i + 1, calls))
  if (win.elided > 0) {
    lines.push('… +' + win.elided + ' messages between head and tail elided — read the artifact file for the middle.')
    for (let i = messages.length - win.tail; i < messages.length; i += 1) lines.push(messagePreviewLine(messages[i], i + 1, calls))
  }
  return lines
}

// Budget-aware preview for the Fold archive section inside a summary node.
// The engine REJECTS a fold whose framed summary is not smaller than the
// shadowed span, so the whole appendix (metadata bullet + preview) must stay
// a small FRACTION of the span: the preview is trimmed to ~15% of the span's
// estimated chars (minus the metadata line), never exceeding the 30-line
// cap. Within that budget the window is HEAD+TAIL (see renderSpanPreview):
// the closing lines are reserved FIRST — up to a quarter of the budget — so
// the span's ending survives whenever any preview is shown at all. Tiny
// spans may end up with no preview lines — just the header pointing at the
// artifact, which is always complete.
export function renderArchivePreview(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return ['Span preview: (empty)']
  const header = 'Span preview (' + messages.length + ' messages, one per line — same order/numbering as the JSONL artifact):'
  const estChars = JSON.stringify(messages).length
  const budget = Math.floor(estChars * 0.15) - 220 - header.length
  if (budget < 80) return [header, '… span too small to preview inline — read the artifact file.']
  const calls = collectToolCalls(messages)
  const lines = [header]
  const win = headTailSplit(messages.length, 30)
  // Reserve the tail first, kept from the span's LAST message backwards for
  // as long as the tail budget (at most a quarter of the total) allows.
  const tailAll = []
  for (let i = messages.length - win.tail; i < messages.length; i += 1) {
    tailAll.push(messagePreviewLine(messages[i], i + 1, calls))
  }
  let tailBudget = Math.min(tailAll.reduce((sum, l) => sum + l.length, 0), Math.floor(budget / 4))
  const keptTail = []
  for (let k = tailAll.length - 1; k >= 0; k -= 1) {
    if (tailBudget < tailAll[k].length) break
    tailBudget -= tailAll[k].length
    keptTail.unshift(tailAll[k])
  }
  let headBudget = budget - keptTail.reduce((sum, l) => sum + l.length, 0)
  let shown = 0
  for (let i = 0; i < win.head && i < messages.length; i += 1) {
    const line = messagePreviewLine(messages[i], i + 1, calls)
    if (shown > 0 && line.length > headBudget) break
    lines.push(line)
    headBudget -= line.length
    shown += 1
  }
  const shownTotal = shown + keptTail.length
  if (messages.length > shownTotal && shownTotal > 0) {
    if (keptTail.length > 0) {
      lines.push('… +' + (messages.length - shownTotal) + ' messages between head and tail elided — read the artifact file for the middle.')
      lines.push(...keptTail)
    } else {
      lines.push('… +' + (messages.length - shownTotal) + ' more messages — read the artifact file for the rest.')
    }
  }
  return lines
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
