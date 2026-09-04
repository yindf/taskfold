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
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat
}

// One brief fragment per content block. Unknown block types degrade to their
// type name so the preview never crashes on a future harness block shape.
export function blockBrief(block) {
  if (block === null || typeof block !== 'object') return '?'
  if (block.type === 'text') return clip(block.text === undefined ? '' : block.text, TEXT_CLIP)
  if (block.type === 'reasoning') return '[think] ' + clip(block.text === undefined ? '' : block.text, TEXT_CLIP)
  if (block.type === 'tool-call') {
    return '→' + String(block.name === undefined ? 'tool' : block.name) + '(' + clip(block.arguments === undefined ? '' : block.arguments, TEXT_CLIP) + ')'
  }
  if (block.type === 'tool-result') {
    let inner = ''
    if (typeof block.text === 'string') inner = block.text
    else if (Array.isArray(block.content)) {
      inner = block.content.filter((b) => b !== null && typeof b === 'object' && typeof b.text === 'string').map((b) => b.text).join(' ')
    }
    return '⇐' + (block.isError === true ? 'ERROR: ' : '') + clip(inner, TEXT_CLIP)
  }
  return '[' + String(block.type === undefined ? 'block' : block.type) + ']'
}

// One preview line per message: `NN role: fragments`. The line number matches
// the message's 1-based position in the span — and its line in the JSONL
// artifact written by writeSpanArtifact.
export function messagePreviewLine(message, index) {
  const role = message !== null && typeof message === 'object' && typeof message.role === 'string' ? message.role : '?'
  const blocks = message !== null && typeof message === 'object' && Array.isArray(message.content) ? message.content : []
  const joined = blocks.map(blockBrief).join(' ')
  const body = joined.length > 0 ? joined : '(empty)'
  const numbered = String(index).padStart(3, ' ') + ' ' + role + ': ' + body
  return numbered.length > LINE_CLIP ? numbered.slice(0, LINE_CLIP - 1) + '…' : numbered
}

// The full preview block: a header plus one line per message, capped. Lines
// beyond the cap collapse into one overflow pointer at the artifact file.
export function renderSpanPreview(messages, maxLines) {
  const cap = Number.isInteger(maxLines) && maxLines > 0 ? maxLines : 30
  if (!Array.isArray(messages) || messages.length === 0) return ['Span preview: (empty)']
  const lines = ['Span preview (' + messages.length + ' messages, one per line — same order/numbering as the JSONL artifact):']
  for (let i = 0; i < messages.length && i < cap; i += 1) lines.push(messagePreviewLine(messages[i], i + 1))
  if (messages.length > cap) lines.push('… +' + (messages.length - cap) + ' more messages — read the artifact file for the rest.')
  return lines
}

// Artifact writer: JSONL, one message per line, in preview order. Returns the
// file path, or undefined when writing fails (the fold itself must not fail
// because a diagnostic file could not be written).
export function writeSpanArtifact(messages, nameKey) {
  try {
    const dir = nodePath.join(nodeOs.tmpdir(), 'taskfold-artifacts')
    nodeFs.mkdirSync(dir, { recursive: true })
    const slug = String(nameKey).replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60)
    const file = nodePath.join(dir, (slug.length > 0 ? slug : 'artifact') + '-' + Date.now().toString(36) + '.jsonl')
    const body = messages.map((m) => JSON.stringify(m)).join('\n') + '\n'
    nodeFs.writeFileSync(file, body, 'utf8')
    return file
  } catch (err) {
    return undefined
  }
}
