# Scoped summaries — acceptance notes

## Why
Stock compaction instruction produces a project-wide checkpoint for every
fold; task folds want a summary of the span only.

## Mechanism
- `ScopedEngine extends BasicCompactionEngine`, overriding `summarize()` —
  the only replaced part is the appended instruction; locking, validation,
  stability checks and the commit path stay stock.
- Realm engine (preset row) keeps serving AUTO compaction with the stock
  checkpoint instruction; explicit folds (task_commit / compact) use the
  scoped instance. The durable lock through the event log keeps them
  mutually exclusive.

## Instruction shape
Audience is the continuing model (no human persona). Sections: What
happened / Changes / Outcomes. Recall pointer lives in the TOOL OUTPUT with
filled seqs, not in the summary.

## Acceptance
Fold this very task and check: summary mentions only this span's work; no
project background; output carries `Archived seqs A..B`.
