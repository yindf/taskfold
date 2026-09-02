# Changelog

All notable changes to this project are documented per commit series; versions
here follow the preset/plugin generations (not npm releases yet).

## 0.1.0 — plugin bundle generation (current)

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
