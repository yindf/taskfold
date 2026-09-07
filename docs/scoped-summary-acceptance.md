# Scoped summaries — acceptance notes

Status: shipped (span-only envelope from the start; prefix-anchored envelope
since 0.22.0). Updated to describe the mechanism as built — the original
draft predated the v9 full-deferred closes and named tools that no longer
exist (`task_commit`/`compact`).

## Why

Stock compaction instruction produces a project-wide continuity checkpoint
for every fold; task folds want a summary of the span only — and a CLOSED
task's summary must never carry Pending Jobs / Next Step sections that
contradict the close.

## Mechanism

- `ScopedEngine extends BasicCompactionEngine` (fold-engine.mjs), overriding
  only `summarize()` — locking, validation, stability checks and the commit
  path stay stock.
- The AUTO engine (realm row, if any) keeps serving pressure/overflow
  compaction with the stock checkpoint instruction — which taskfold rewrites
  to the detailed variant at the `ctx.llm.stream` seam (compact-region.mjs).
  Explicit task folds (task_end's queued archive, drained at the next step
  boundary after the deliverable — or, since 0.26.0, at the turn-stopping
  boundary right after a turn-final deliverable, while the provider prefix
  cache is still hot) use the scoped instance. The durable lock
  through the event log keeps them mutually exclusive.
- Two envelopes, chosen per fold: span-only (the request carries exactly the
  span) and prefix-anchored (surface prefix + span + a scoping instruction
  that brackets the region by its explicit lifecycle markers — a strict
  prefix of the main conversation request, so the provider prefix cache
  reuses it; measured ~97% hit vs 0%, and 0 path fabrications). Any anomaly
  falls back to the span-only envelope. The instruction's tail carries the
  span message index (a fenced, numbered, one-line-per-message listing
  rendered by the same `renderSpanPreview` that serves `fold_recall`); it
  rides the always-fresh instruction message, so the cached prefix is
  untouched.

## Instruction shape

Audience is the continuing model (no human persona). Five sections: What
happened / User inputs & decisions / Changes / Pitfalls & gotchas / Outcomes.
There is NO word budget (removed in 0.29.0): coverage is governed by
structure alone — a numeric granularity rule (one bullet per INTENT — a
coherent purpose or phase, typically 3-5 steps, hard ceiling of 10 steps per
bullet, no separator-packing of distinct intents; small intents keep their
own bullets), and a Reasoning rule makes the span's thinking blocks the
primary source of decision rationale: every What-happened bullet ENDS with
an explicit why: clause naming the deciding consideration plus the strongest
rejected alternative (action-only bullets are failures; an in-span polished
report must not be echoed in place of the deliberation that produced it),
with settled conclusions distinguished from passing guesses — and, when the
closing declaration is available, a forced
`# <task name>` heading
(the instruction prints the exact required line verbatim with a one-line
copy rule — no translation or reformatting, whatever language the summary
body uses) and
"this fold CLOSES the task" rules. A scope-adherence guard scores the
summary's first heading against the closing task's name with a lenient
normalized similarity (typographic drift passes); only a genuinely foreign
heading — drift into the earlier conversation — is rejected and retried.

Citation rules (0.26.0): the summarizer must copy message line numbers from
the instruction-tail span message index (never count messages), cite source
files only with file names and tool-visible line numbers (never estimated
from memory), fall back to a short verbatim quote when no anchor resolves,
and never mirror the index into the summary. Grounding: three fresh-context
controlled arms on a 52-message artifact — index arm 100% correct
message-level citations; control arm (no index, counting) 100% at that size;
perturbed arm (+1 index labels) followed the printed labels in 37/37
citations, proving index-copy over counting. What-happened bullets may
cluster consecutive steps into phase bullets carrying `L<N>-<M>`.

Recall pointers live INSIDE the committed summary node: its trailing
`## Fold archive` section carries the fold number, the message count, the
JSONL artifact path, and a compact archive footer — the head and tail of the
span preview with TRUE line numbers (preview line N = artifact line N); the
complete index stays one `fold_recall({ fold })` away. No separate notice
message is injected.

## Acceptance

Fold this very task and check: the summary mentions only this span's work; no
project background; its heading is `# <the closing task name>`; the node ends
with a Fold archive section whose span runs from just after the 'Task begun'
result through the 'Task ended' result; `list_folds` numbers the fold and
`fold_recall({ fold })` round-trips the original span; `fold_recall({ fold,
from, to })` returns a cited `L<N>-<M>` slice of exact originals in one call
(inclusive 1-based line numbers, ≤10 lines, no file written).
