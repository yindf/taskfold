/**
 * The two instruction texts taskfold swaps in at the LLM seam — pure prompt
 * engineering artifacts, exported so tests can pin their structure offline.
 */

/**
 * SPAN-SCOPED summarization instruction for task folds. The stock
 * COMPACTION_INSTRUCTION is a continuity checkpoint ("let another model
 * resume the work"): it asks for the WHOLE conversation's Primary Request /
 * Pending Jobs / Next Step, so a folded task span comes back as a
 * project-wide summary stuffed with background the surrounding context
 * already has — and its Pending/Next-Step sections would contradict the
 * fold's "this task is CLOSED" contract. Our folds want exactly the
 * opposite: what happened IN THE SPAN, with the span's user inputs and
 * pitfalls preserved as first-class sections (v2).
 */
// Boundary semantics shared by BOTH envelopes below: what the span covers
// and what deliberately stays outside it.
const FOLD_BOUNDARY_RULE = 'The span opens just after the \'Task begun\' result and closes with the \'Task ended\' result — the begin call, its opening reasoning, and the \'Task begun\' result itself stay outside the span by design; do not treat their absence as missing work.'

// The sections, structure, and rules every fold summary follows regardless of
// envelope.
const FOLD_SUMMARY_CORE = [
  'Summarize ONLY what the span contains — what was done, tried, decided, and produced. Do NOT restate project background, architecture, goals, or context the messages merely assume: the continuing model already has all of that from outside the span.',
  'Output EXACTLY this structure, terse bullets, "(none)" for empty sections:',
  '## What happened',
  '- [the work performed in this span, in order, one bullet per meaningful step]',
  '## User inputs & decisions',
  '- [the user\'s requests, corrections, rejections, answers, and approvals from THIS span, with the decision each produced; quote verbatim where the exact wording matters]',
  '## Changes',
  '- [exact file paths written or edited, key values, durable identifiers]',
  '## Pitfalls & gotchas',
  '- [failed attempts and WHY they failed, workarounds adopted, environment traps (sandbox denials, platform quirks), and "do not do X again" lessons from this span]',
  '## Outcomes',
  '- [results, verdicts, failures and their meaning; anything a later step must know]',
  'Rules:',
  '- Boundary: What happened = the span\'s actions and decisions in order, including the commands it ran; Changes = only durable artifacts that outlive the span and stay grep-able later (exact file paths written or edited, key values, durable identifiers). If it is not grep-able later, it belongs in What happened, not Changes.',
  '- Budget: the closing rules state THIS fold\u0027s concrete word budget (≈10% of the span\u0027s estimated tokens). Spend it on fidelity, never on padding; a section ends at "(none)" as soon as it is true. Sections get different treatment: What happened keeps every meaningful step as its own bullet (compress phrasing, not facts; merge only same-action repeats); Changes is exhaustive — every file path written or edited, every key value, no selection; Pitfalls & gotchas keeps every failure and its cause; Outcomes keeps every result and verdict; User inputs & decisions keeps every request, correction, and approval. When the budget forces triage, drop narrative connective tissue and restated context first — never anchors, decisions, or failure causes.',
  '- Preserve exact file paths, commands, error strings, identifiers, and numbers. When this summary names files, commands, or errors, keep them precise (paths verbatim) — the reader will only recall the original span if these anchors fail to answer its question, and precise anchors double as grep keywords for that recall.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Pitfalls and their causes are the span\'s most reusable knowledge: never drop why something failed.',
  '- If the deliverable was never sent, a later turn may relay this summary to the user as the task report\'s basis: keep every section accurate and human-readable. If the span already contains the delivered report, Outcomes should cite its conclusions, not restate them.',
  '- Do NOT mention summarization or compaction. Output only the summary text: no tool calls or other actions.'
].join('\n')

/**
 * Build the fold summarization instruction for one of TWO envelopes:
 *  - prefix: false (span-only, the original envelope) — the request carries
 *    ONLY the span messages, so the opening says exactly that.
 *  - prefix: true (prefix-anchored envelope) — the request carries the whole
 *    surface up to the span's end, so the opening must SCOPING the region by
 *    its explicit lifecycle markers: from just after the "Task begun: NAME"
 *    result through the "Task ended: NAME" result. The earlier conversation
 *    is declared CONTEXT ONLY. This envelope makes the request a strict
 *    prefix of the main conversation request → provider prefix-cache reuse
 *    (experiment-measured ~97% cache hit vs 0% for span-only) and supplies
 *    correct full paths (measured 0 path fabrications vs some for span-only).
 */
export function buildFoldInstruction(opts) {
  const o = opts !== null && typeof opts === 'object' ? opts : {}
  const name = typeof o.name === 'string' && o.name.length > 0 ? o.name : '<the task name>'
  if (o.prefix === true) {
    return 'You are summarizing ONE FOLDED SPAN of a longer session; your summary replaces that span for the model that continues this session. The messages above consist of two parts: EARLIER CONVERSATION, then THE TASK SPAN to fold. The boundary between them is explicit — the task span begins immediately after the result message \'Task begun: ' + name + '\' and ends with the result message \'Task ended: ' + name + '\' (the final lifecycle markers in the input). Summarize ONLY that final span. ' + FOLD_BOUNDARY_RULE + ' The earlier conversation before the \'Task begun\' result is CONTEXT ONLY: you may use it to resolve references and confirm full paths, but never summarize it, restate it, or fold any of it into a section — every section below describes the task span alone.'
      + '\n' + FOLD_SUMMARY_CORE
  }
  return 'You are summarizing ONE FOLDED SPAN of a longer session. The messages above are exactly that span; your summary replaces them for the model that continues this session. ' + FOLD_BOUNDARY_RULE
    + '\n' + FOLD_SUMMARY_CORE
}

export const FOLD_SUMMARY_INSTRUCTION = buildFoldInstruction({})

// Stock (non-fold) compaction normally runs the host's terse checkpoint
// instruction. Product ruling: checkpoints carry NO prompt-side caps and
// demand maximal detail — a long context must not lose its facts to terse
// bullets. The sanctioned customization hook (summarize()) is bound to the
// host's own AUTO engine instance, which a plugin cannot replace, so this
// instruction is swapped in at the one neutral seam every compaction call
// crosses: ctx.llm.stream (see compact-region.mjs's apply()).
export const DETAILED_CHECKPOINT_INSTRUCTION = [
  'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of context.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use information-dense bullets. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  '- [the user\'s original and evolving goals, quoted verbatim where the exact wording matters; every request, correction, and approval]',
  '',
  '## Key Technical Concepts',
  '- [technologies, frameworks, patterns, and conventions in play, each with the detail a resuming model needs to act on it]',
  '',
  '## Files and Code',
  '- [every exact path touched: why it matters, key changes, key values, and critical snippets — exhaustive, no selection]',
  '',
  '## Errors and Fixes',
  '- [every error: its exact text, how it was resolved or worked around, plus any related user feedback; keep every failure cause]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet completed]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue — keep every distinct fact as its own bullet]',
  '',
  'Rules:',
  '- There is NO length cap and NO bullet-count cap: be as detailed as the source material supports; compress phrasing, never facts. Distinct facts never share a bullet; drop narrative connective tissue before dropping any fact.',
  '- Write precise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
  '- If the conversation already contains a prior checkpoint block, it is a PRIOR condensation. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.'
].join('\n')
