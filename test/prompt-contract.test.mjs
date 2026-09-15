// Model-facing pins for the task-mark HANDOFF contract.
//
// The failure these pins exist for was NOT a rejected call. `task_end` followed
// by a BARE TEXT report is perfectly legal — but the host ends the turn on any
// assistant message carrying no tool call, so the successor `task_begin` the
// model had already promised never ran (the promise died in the same message
// that announced it). The 0.34.x wording made it worse: "send the next
// task_begin as its own FOLLOWING message" and a shape example drawing
// `report` and `task_begin` as two separate nodes read as "a message carrying
// a mark must contain nothing else", and the model duly sent a text-only
// message.
//
// So four facts must stay in EVERY model-facing surface:
//   1. "only" constrains task-mark CALLS — text, reasoning and any non-mark
//      tool may sit beside the single mark, and a batched relay fails BOTH
//      calls (the guard rejects every mark in the carrying message, not just
//      the second one).
//   2. A handoff puts the successor task_begin in the SAME message as the
//      report; a text-only message is a turn END, not a pause.
//   3. The report's moment is ANCHORED — the first message after the task_end
//      result; text in the closing message itself arrives before the result.
//   4. The fold span starts after the LAST result of the task_begin message (a
//      parallel-begin partner extends the start) and ends at the last result of
//      the task_end message — the PARALLEL-BEGIN guard, not the simplified
//      "'Task begun' result" phrasing.
import test from 'node:test'
import assert from 'node:assert/strict'
import nodeFs from 'node:fs'

const src = nodeFs.readFileSync(new URL('../plugins/compact-region.mjs', import.meta.url), 'utf8')
const statsSrc = nodeFs.readFileSync(new URL('../plugins/compact-stats.mjs', import.meta.url), 'utf8')

// Decode the single-quoted JS literal opening at `index`, so the assertions run
// against the text the MODEL reads rather than against the source escapes
// (\u0027 is used in the system-prompt section).
function literalAt(index) {
  let out = ''
  for (let i = index + 1; i < src.length; i++) {
    const c = src[i]
    if (c === '\\') {
      const n = src[i + 1]
      if (n === 'u') {
        out += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16))
        i += 5
      } else {
        out += n === 'n' ? '\n' : n
        i += 1
      }
      continue
    }
    if (c === "'") return out
    out += c
  }
  throw new Error('unterminated literal in compact-region.mjs')
}

function literalOpening(marker) {
  const at = src.indexOf("'" + marker)
  assert.ok(at >= 0, 'model-facing literal not found: ' + marker)
  return at
}

const section = literalAt(literalOpening('MANDATORY task lifecycle discipline:'))
const beginDesc = literalAt(literalOpening('Begin a NAMED task.'))
const endDesc = literalAt(literalOpening('End the INNERMOST open task by name:'))

// compact-stats.mjs escapes its apostrophes the same way — decode before pinning.
function decodeIn(text, marker) {
  const at = text.indexOf("'" + marker)
  assert.ok(at >= 0, 'model-facing literal not found: ' + marker)
  let out = ''
  for (let i = at + 1; i < text.length; i++) {
    const c = text[i]
    if (c === '\\') {
      const n = text[i + 1]
      if (n === 'u') {
        out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16))
        i += 5
      } else {
        out += n === 'n' ? '\n' : n
        i += 1
      }
      continue
    }
    if (c === "'") return out
    out += c
  }
  throw new Error('unterminated literal for ' + marker)
}

const recallDesc = decodeIn(statsSrc, 'Regenerate the artifact FILE for one fold:')

test('system-prompt section states the turn-ending rule — a text-only report is a STOP', () => {
  assert.ok(section.includes('TURN-ENDING RULE'), 'the rule is named so it reads as a rule, not as prose')
  assert.ok(
    section.includes('an assistant message with NO tool call ends your step'),
    'the host condition is stated at step granularity — the turn end is hedged (injected notices can revive it)'
  )
  assert.ok(section.includes('a text-only report is a STOP, never a pause'), 'the trap is named explicitly')
  assert.ok(
    section.includes('if the turn still has work, that message must carry a tool call'),
    'the remedy is stated for the continuing case'
  )
  assert.ok(
    section.includes('if you are done or waiting on the user, a text-only report is exactly right'),
    'the legitimate text-only case keeps its exit — the rule must not read as "always add a tool call"'
  )
})

test('"only" is scoped to task-mark calls in every surface that says it', () => {
  assert.ok(section.includes('a limit on task-mark CALLS alone'), 'section scopes the rule')
  assert.ok(
    section.includes('text, reasoning, and any other (non-task-mark) tool call may share the message with the single mark'),
    'section states the scope OPENLY instead of enumerating a whitelist the guard does not implement'
  )
  assert.ok(!section.includes('reads and present'), 'the narrow reads/present enumeration is gone')
  assert.ok(
    section.includes('BOTH calls fail'),
    'the relay failure is stated symmetrically — every mark in the carrying message is rejected, not just the second'
  )
  assert.ok(
    section.includes('names can also fail for other reasons (blocked, unknown, duplicate)'),
    'the relay is not presented as the only execute-time rejection'
  )
  assert.ok(beginDesc.includes('"only" constrains task-mark calls alone'), 'task_begin description scopes the rule')
  assert.ok(endDesc.includes('"only" constrains task-mark calls'), 'task_end description scopes the rule')
  assert.ok(
    src.includes('text beside it is fine)'),
    'the execute-time sibling rejection carries the same scoping in its hint'
  )
})

test('the handoff shape puts the successor task_begin in the SAME message as the report', () => {
  assert.ok(
    section.includes('Hand off by putting the successor task_begin in the FOLLOWING message, TOGETHER with the report'),
    'section states the shape'
  )
  assert.ok(
    section.includes('[report on PR #98 + task_begin "review PR #99"]'),
    'the shape example batches report + successor begin into one message'
  )
  assert.ok(
    section.includes('no message carries TWO task-mark calls; text never blocks a mark'),
    'the example preamble states the constraint the example actually illustrates'
  )
  assert.ok(
    beginDesc.includes('IN THE SAME MESSAGE as the report on the task you just closed'),
    'task_begin description tells the model how to continue straight after a close'
  )
  assert.ok(
    endDesc.includes('that following message is the report AND the successor task_begin TOGETHER'),
    'task_end description tells the model how to continue straight after a close'
  )
})

test('the ambiguous "own message / alone" phrasings are gone', () => {
  for (const banned of [
    'every task-mark call is its own message',
    'as its own FOLLOWING message',
    'as its own message',
    're-issue it alone in the next message',
    'Re-issue task_begin alone in your next message',
    'send the next task_begin as its own message',
    'as the only task-mark call in its message'
  ]) {
    assert.ok(!section.includes(banned), 'ambiguous handoff phrasing still in the section: ' + banned)
    assert.ok(!beginDesc.includes(banned), 'ambiguous handoff phrasing still in task_begin description: ' + banned)
    assert.ok(!endDesc.includes(banned), 'ambiguous handoff phrasing still in task_end description: ' + banned)
  }
  assert.ok(!section.includes('report → task_begin'), 'the two-node report→begin arrow chain is gone from the example')
})

test('the task_end result text carries the same exit', () => {
  assert.ok(
    src.includes('that report message must also carry a tool call'),
    'the result the model reads right after closing names the remedy'
  )
  assert.ok(
    src.includes('the work you just promised never starts'),
    'the result names the consequence of the text-only report'
  )
})

test('the report moment, the fold span and the nudge channel are stated accurately', () => {
  assert.ok(
    section.includes('the first after the task_end result'),
    'the report moment is anchored to the first message after the result, not left indexical'
  )
  assert.ok(
    section.includes('text in the task_end message itself arrives before the result, too early'),
    'the too-early failure mode is named where the report shape is described'
  )
  assert.ok(!section.includes('Runtime context carries lifecycle nudges'), 'the false nudge channel is gone')
  assert.ok(
    section.includes('Lifecycle notices arrive as injected messages'),
    'the nudge channel matches delivery (appended decision messages), not a runtime-context snapshot'
  )
  assert.ok(
    section.includes('just after the last result of the task_begin message'),
    'the section names the parallel-begin-aware span start'
  )
  assert.ok(
    recallDesc.includes('from just after the last result of the task_begin message'),
    'fold_recall describes the same span start (PARALLEL-BEGIN guard)'
  )
  assert.ok(
    src.includes('the span folds automatically at the step boundary after your NEXT message'),
    'the close result anchors its own timing instead of saying "now"'
  )
  for (const banned of [
    'folds automatically at your next step boundary',
    'deliver your report now with full context',
    'the fold fires as soon as it lands'
  ]) {
    assert.ok(!src.includes(banned), 'stale archival timing still in source: ' + banned)
  }
})
