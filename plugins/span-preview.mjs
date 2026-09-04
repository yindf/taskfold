// Shared span preview + JSONL artifact helpers for the taskfold bundle.
//
// CONTRACT: the preview lines task_fold prints and the lines of the JSONL
// artifact are derived from the SAME messages in the SAME order — line N of
// the artifact file is exactly what preview line N describes. The model can
// map a one-line preview back to its full original by line number.
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
// Role label: harness tool results arrive as user-role messages, but the
// preview distinguishes them — a message whose blocks are ALL tool-results
// reads `tool:`, so genuine user input (and runtime-context snapshots) keeps
// a visibly different `user:` label.
export function messagePreviewLine(message, index, calls) {
  const role = message !== null && typeof message === 'object' && typeof message.role === 'string' ? message.role : '?'
  const blocks = message !== null && typeof message === 'object' && Array.isArray(message.content) ? message.content : []
  const allToolResults = blocks.length > 0 && blocks.every((b) => b !== null && typeof b === 'object' && b.type === 'tool-result')
  const label = allToolResults ? 'tool' : role
  const joined = blocks.map((b) => blockBrief(b, calls)).join(' ')
  const body = joined.length > 0 ? joined : '(empty)'
  const numbered = String(index).padStart(3, ' ') + ' ' + label + ': ' + body
  return numbered.length > LINE_CLIP ? numbered.slice(0, LINE_CLIP - 1) + '…' : numbered
}

// The full preview block: a header plus one line per message, capped. Lines
// beyond the cap collapse into one overflow pointer at the artifact file.
export function renderSpanPreview(messages, maxLines) {
  const cap = Number.isInteger(maxLines) && maxLines > 0 ? maxLines : 30
  if (!Array.isArray(messages) || messages.length === 0) return ['Span preview: (empty)']
  const lines = ['Span preview (' + messages.length + ' messages, one per line — same order/numbering as the JSONL artifact):']
  const calls = collectToolCalls(messages)
  for (let i = 0; i < messages.length && i < cap; i += 1) lines.push(messagePreviewLine(messages[i], i + 1, calls))
  if (messages.length > cap) lines.push('… +' + (messages.length - cap) + ' more messages — read the artifact file for the rest.')
  return lines
}

// Artifact writer: JSONL, one message per line, in preview order. Each line
// is the message slimmed to {role, content} — the full original content
// blocks, without host provenance metadata (source/replayState/id): recall
// serves content recovery; audit metadata stays in the durable event log.
// Returns the file path, or undefined when writing fails (the fold itself
// must not fail because a diagnostic file could not be written).
export function writeSpanArtifact(messages, nameKey) {
  try {
    const dir = nodePath.join(nodeOs.tmpdir(), 'taskfold-artifacts')
    nodeFs.mkdirSync(dir, { recursive: true })
    const slug = String(nameKey).replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60)
    const file = nodePath.join(dir, (slug.length > 0 ? slug : 'artifact') + '-' + Date.now().toString(36) + '.jsonl')
    const body = messages.map((m) => JSON.stringify(m !== null && typeof m === 'object' ? { role: m.role, content: m.content } : m)).join('\n') + '\n'
    nodeFs.writeFileSync(file, body, 'utf8')
    return file
  } catch (err) {
    return undefined
  }
}
