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
  boundary after the deliverable) use the scoped instance. The durable lock
  through the event log keeps them mutually exclusive.
- Two envelopes, chosen per fold: span-only (the request carries exactly the
  span) and prefix-anchored (surface prefix + span + a scoping instruction
  that brackets the region by its explicit lifecycle markers — a strict
  prefix of the main conversation request, so the provider prefix cache
  reuses it; measured ~97% hit vs 0%, and 0 path fabrications). Any anomaly
  falls back to the span-only envelope.

## Instruction shape

Audience is the continuing model (no human persona). Five sections: What
happened / User inputs & decisions / Changes / Pitfalls & gotchas / Outcomes,
plus a per-fold word budget (~10% of the span's estimated tokens) and — when
the closing declaration is available — a forced `# <task name>` heading and
"this fold CLOSES the task" rules. A scope-adherence guard rejects any
summary whose heading is not the closing task's name.

Recall pointers live INSIDE the committed summary node: its trailing
`## Fold archive` section carries the fold number, the JSONL artifact path,
and the complete span preview (preview line N = artifact line N). No separate
notice message is injected.

## Acceptance

Fold this very task and check: the summary mentions only this span's work; no
project background; its heading is `# <the closing task name>`; the node ends
with a Fold archive section whose span runs from just after the 'Task begun'
result through the 'Task ended' result; `list_folds` numbers the fold and
`fold_recall({ fold })` round-trips the original span.
