// Offline pins for the fold instruction layer: the five-section structure,
// the citation rules (index-copy / source-file / no-evidence / mirror), the
// clustering wording agreement between the What-happened line and the Budget
// rule, and the assembleFoldInstruction envelope contract (index appended
// last, fenced, non-H2 lead line).
import test from 'node:test'
import assert from 'node:assert/strict'
import nodeFs from 'node:fs'
import { buildFoldInstruction, assembleFoldInstruction, FOLD_SUMMARY_INSTRUCTION } from '../plugins/fold-instruction.mjs'

test('FOLD_SUMMARY_CORE: exactly the five section headings — no sixth section that could mirror the index', () => {
  const headings = FOLD_SUMMARY_INSTRUCTION.split('\n')
    .filter((l) => l.startsWith('## '))
    .map((l) => l.replace(/:.*$/, '').trim())
  assert.deepEqual(headings, ['## What happened', '## User inputs & decisions', '## Changes', '## Pitfalls & gotchas', '## Outcomes'])
})

test('citation rules present: index-copy, source-file, no-evidence, mirror prohibition', () => {
  assert.match(FOLD_SUMMARY_INSTRUCTION, /Span message index printed at the end of THIS instruction/, 'citations rule anchors at the instruction-tail index')
  assert.match(FOLD_SUMMARY_INSTRUCTION, /never count messages yourself/, 'numbers are copied, not counted')
  assert.match(FOLD_SUMMARY_INSTRUCTION, /never estimate line numbers from memory/, 'source-file rule forbids memory-estimated line numbers')
  assert.match(FOLD_SUMMARY_INSTRUCTION, /quote a short verbatim fragment instead of citing a number/, 'no-evidence fallback is a verbatim quote')
  assert.match(FOLD_SUMMARY_INSTRUCTION, /navigation input only/, 'mirror prohibition present')
})

test('granularity rule: 3-5 steps per bullet with a hard ceiling of 10; budget never trims coverage', () => {
  assert.match(FOLD_SUMMARY_INSTRUCTION, /one bullet per phase of 3-5 steps/, 'section line carries the numeric granularity')
  assert.match(FOLD_SUMMARY_INSTRUCTION, /10 is the hard ceiling/, 'hard ceiling present in the rules')
  assert.match(FOLD_SUMMARY_INSTRUCTION, /MUST be split into consecutive bullets/, 'over-ceiling bullets must split, keeping their L<N>-<M>')
  assert.match(FOLD_SUMMARY_INSTRUCTION, /Never join distinct actions with separators inside one bullet/, 'anti separator-packing present')
  assert.match(FOLD_SUMMARY_INSTRUCTION, /outweighs the word budget/, 'coverage beats budget stated')
  assert.match(FOLD_SUMMARY_INSTRUCTION, /The budget shapes prose economy, never coverage/, 'budget rule disclaims coverage authority')
  assert.ok(!FOLD_SUMMARY_INSTRUCTION.includes('one bullet per meaningful step'), 'old vague granularity wording gone')
  assert.ok(!FOLD_SUMMARY_INSTRUCTION.includes('merge only same-action repeats'), 'the older anti-clustering clause stays gone')
})

test('reasoning rule: thinking blocks mined for rationale; why + rejected alternatives per bullet', () => {
  assert.match(FOLD_SUMMARY_INSTRUCTION, /which alternatives were rejected and why/, 'section line carries the reasoning clause')
  assert.match(FOLD_SUMMARY_INSTRUCTION, /thinking blocks are the primary source of decision rationale/, 'thinking blocks declared the primary rationale source')
  assert.match(FOLD_SUMMARY_INSTRUCTION, /not only WHAT was done but WHY/, 'why is a per-bullet requirement')
  assert.match(FOLD_SUMMARY_INSTRUCTION, /rejected alternatives and the reason they lost/, 'rejected alternatives kept with their losing reason')
  assert.match(FOLD_SUMMARY_INSTRUCTION, /distinguish settled conclusions from passing guesses/, 'conclusion confidence distinguished')
  assert.match(FOLD_SUMMARY_INSTRUCTION, /Failure causes belong in Pitfalls & gotchas; choice rationale belongs here/, 'division of labor vs Pitfalls pinned')
})

test('assembleFoldInstruction: base + budget + closing, fenced index appended LAST with a non-H2 lead line', () => {
  const text = assembleFoldInstruction({
    opts: { prefix: true, name: 'demo' },
    budgetLine: '\nWord budget for THIS fold: at most ~100 words.',
    closing: '\nThe task this span belongs to is named "demo". Rules for this fold:',
    indexLines: [
      'Span preview (3 messages, one per line — same order/numbering as the JSONL artifact):',
      '  1 user: hi',
      '  2 assistant: hello',
      '  3 tool: ←done'
    ]
  })
  assert.match(text, /Task begun: demo/, 'opts forwarded: prefix-anchored opening present')
  assert.ok(text.indexOf('Word budget for THIS fold') < text.indexOf('Rules for this fold:'), 'budget precedes closing')
  const idx = text.indexOf('Span message index (line N')
  assert.ok(idx > text.indexOf('Rules for this fold:'), 'index appended AFTER the closing rules')
  assert.match(text.slice(idx), /^Span message index \(line N = the N-th span message = artifact line N\):/, 'lead line is plain text — deliberately not a heading')
  assert.ok(text.includes('```\nSpan preview (3 messages, one per line — same order/numbering as the JSONL artifact):\n  1 user: hi\n  2 assistant: hello\n  3 tool: ←done\n```'), 'index body fenced verbatim, header line included')
  const lean = assembleFoldInstruction({ opts: {}, budgetLine: '', closing: '', indexLines: [] })
  assert.equal(lean, buildFoldInstruction({}), 'empty extras + no index degrade to the plain span-only instruction')
  assert.ok(!lean.includes('Span message index (line N'), 'no index section when indexLines is empty (rule text may still mention the index by name)')
})

test('model-facing texts stay in footer semantics; turn-stopping drain registered', () => {
  const src = nodeFs.readFileSync(new URL('../plugins/compact-region.mjs', import.meta.url), 'utf8')
  assert.ok(!src.includes('no elision'), 'task_end description / system-prompt section must not promise a no-elision full preview')
  assert.ok(!src.includes('complete span preview'), 'the complete-preview wording is gone')
  assert.ok(src.includes('compact archive footer'), 'footer semantics present in model-facing texts')
  assert.ok(src.includes("ctx.on('agent/turn-stopping'"), 'the turn-stopping drain hook is registered (feature 1)')
})
