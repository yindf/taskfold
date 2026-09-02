# Changelog

All notable changes to this project are documented per commit series; versions
here follow the preset/plugin generations (not npm releases yet).

## 0.2.1 — nested folds own their full span (current)

- **Region runs to the last surface node**: a task's final body message now
  folds into its OWN fold instead of leaking into the parent's span artifact;
  nested folds each recall their complete original context. Explicit task
  folds need no live-edge margin (auto compaction keeps its own).
- **Self-fold defense**: if a host commits the in-flight step before tool
  execution, the assistant message carrying the `task_fold` call itself is
  excluded from the region (`foldDecision` takes an optional `events`
  argument).
- **Nesting guidance in prompts**: the system-prompt section and the
  `task_begin` description now tell the model tasks nest hierarchically
  (innermost folds first; every fold keeps its own recallable context).

## 0.2.0 — review-hardening generation

External code review triage: no deterministic data-loss bugs, but semantic
edges, comment drift, and dead code — all addressed.

- **LIFO closing at the tool layer** (`closeTarget`/`foldDecision` pure
  exports): only the innermost open task can close; the projection stays
  name-keyed so pre-LIFO logs replay byte-identically.
- **Graceful unfold degradation**: when the engine cannot be resolved or the
  begin mark was shadowed by another fold, `task_fold` still closes the task
  (`unfolded: 'engine' | 'anchor'`) — no more permanent retry loops.
- **Fold numbering contract**: `list_folds` renders chronological `#N (seq X)`
  — the exact domain `fold_recall` validates; `task_fold` reports the same
  chronological number.
- **Name hygiene**: `validTaskName` rejects empty names and those containing
  the ` — ` separator; `task_begin` also rejects reopening an already-open
  name; legacy logs with separator-bearing names match by exact equality.
- **Per-session closing declarations**: the `__closingTask` engine field
  became an apply-scoped map keyed by session id (no cross-session title
  pollution in single-process multi-session hosts).
- **Todo bridge v2**: replaced the two counting nudges with a transient,
  stateless status line rendered the round after any `todo_write` —
  `Todo bridge: todos changed; open tasks: …` — reporting the open-task
  roster; the model decides begin/fold.
- **Hygiene**: ~70 lines of dead surface-indexing removed (readSurface/
  classify/indexEvents), stale header/NOTE comments rewritten (engine is
  always the plugin-built ScopedEngine), version annotations unified;
  nudge-2 now scans all open marks for the oldest.
- Tests 21 + 11 offline suites; no reducer or stateVersion change.

## 0.1.0 — plugin bundle generation

The preset grew into an installable dsh plugin bundle while keeping the
agent-preset install path.

- **Bundle packaging** (`30b8b1d`): `package.json` with `dsh.bundle.patch`
  declaration plus a host-plane `cordis.patch.yml`; `dsh plugin add` installs
  the tool family globally for every preset's sessions.
- **Self-hosted engine tier** (`ee67f56`, `65a00f6`, `c28d1a9`): `compaction`
  dropped from `inject`; `engineFor()` resolves a realm engine via
  `ctx.get('compaction')`, else lazily constructs
  `BasicCompactionEngine(ctx, { auto: false })` with a file-URL resolution
  fallback that walks up from host anchors. Validated live on a
  minimal-derived preset with no compaction rows at all.
- **Hold-semantics nudges** (`353935b`, `6cc390d`, `63d0633`): lifecycle
  nudges render while their condition holds and retract when it clears;
  cooldown machinery removed. Byte-stable wording ("20+ rounds") so a held
  line emits zero snapshots. The uncommitted backstop appears immediately
  once the step after `task_end` misses `task_commit`; the begin-nudge is
  suppressed while a fold question is open (pending `lastEnded` or a 3-round
  post-outcome grace).
- **Too-small abandonment** (`0f28656`, `bd30f3e`): a
  `task_commit failed (summary)` verdict durably abandons the ended record
  (the span never grows after end), so the backstop nudge cannot hold forever.
  Landed with a `stateVersion` bump after learning that BEHAVIOR changes —
  not just shape changes — require the bump for persisted rows to re-fold.
- **dsh 0.1.2-alpha.4 compatibility** (`3fa52fd`): `Session.events` replaced
  by on-demand APIs; both plugins read the log through a cross-version
  `sessionEvents()` accessor (`snapshotEvents()` on alpha.4+, array before).

## Named tasks generation

- **Named task lifecycle** (`102d260`): `task_begin({ name })` /
  `task_end({ name })` — identity by name, LIFO only within a name; a
  mismatched close cannot corrupt other tasks. `task_commit` folds the full
  span (begin pair + body + end pair) and labels the fold with the task name.
- **Two-tool end/commit split** (`c70ca87`): `task_end` is a pure state
  transition whose output carries the whole status (zero context injection);
  `task_commit` performs the explicit inline fold. The async follow-up fold
  (listener/timer/maintenance) line of designs was explored and abandoned —
  terminal blockers: append reentrancy, whole-surface stability assertion,
  and the agent active-work paradox.
- **Phantom self-heal** (`89713eb`): projection v6 drops unclosable nameless
  legacy marks at load; legacy `task/mark` snapshot coercion no longer
  creates them.
- **Output-carried state** (`cc4cb49`): the standing "open task marks"
  runtime-context line and the immediate lastEnded nudge removed — tool
  outputs are the sole lifecycle surface; runtime context keeps only the
  todo bridge.

## Region compaction generation

- Manual `compact(start, end)` / `compact_inspect` with pairing-balanced
  edges and corrupt-edge re-baselining; `compact_stats` / `compact_recall`
  observability over the append-only log (fold manifests, seq-addressed
  archive recall, title extraction from task names).
- Task marks as a **derived** session projection folding harness-native
  events only — no custom event types; marks survive restarts, resume, and
  compaction. The v1 whole-value `task/mark` events survive only as legacy
  reset points for pre-v2 ghosts.
