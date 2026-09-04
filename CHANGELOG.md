# Changelog

All notable changes to this project are documented per commit series; versions
here follow the preset/plugin generations (not npm releases yet).

## 0.18.2 — Fold archive preview renders as a fenced code block (2026-09-04)

- **Fix**: the archive section used single newlines between preview lines;
  markdown renderers collapse single line breaks into one paragraph, so the
  whole preview read as a mashed blob. The metadata bullet now sits after a
  blank line and the span preview lives in a fenced code block, which
  preserves the one-message-per-line layout everywhere (GUI, model context,
  plain text).

## 0.18.1 — budget-aware Fold archive preview (small spans fold again) (2026-09-04)

- **Fix**: 0.18.0's unconditional 30-line preview made small spans' framed
  summary exceed the shadowed content — the engine's "summary is not smaller"
  check rejected the fold, which the plugin classified as a summary failure
  and silently settled (observed live: a 497-token task never folded, no
  warning). The archive preview now scales with the span: metadata +
  preview stay under ~15% of the span's estimated size (30-line cap
  unchanged); tiny spans get the metadata bullet plus a pointer to the
  artifact instead of inline lines, and fold normally.

## 0.18.0 — Fold archive: a proper summary section with the span preview (2026-09-04)

- **Features**: the metadata appended inside each committed summary node is
  now a section formatted like the summary's own five, restoring the
  per-message preview that 0.17.0 had dropped:

      ## Fold archive
      - fold #N · originals (JSONL, one message per line): <path>
      Span preview (N messages, one per line — …):
        1 assistant: …
        2 tool: …

  Preview line N maps to artifact line N. The bare footer line form from
  0.17.0 is gone; prompts (task_end description, lifecycle section)
  describe the section accordingly.

## 0.17.0 — fold metadata lives inside the summary node; no notice messages (2026-09-04)

- **Behavior**: the scoped summarize override — the last stop before the
  engine commits — now computes the fold number (per-session summary count
  + 1) and writes the JSONL artifact from `input.messages` (the engine's own
  span derivation), then appends a footer line to the summary text:
  `[fold #N · originals (JSONL, one message per line): <path>]`. The
  committed summary node carries its own recall handles.
- **Removed**: the separate one-shot fold-notice message and all its
  machinery (pre-step message append, context-callback drain queue, plugin
  source/id shaping) — the ordering, injection-timing, and message-shape
  problems disappear with it. `foldRegion` reports tokens only; the
  spanMessages helper is gone (the artifact is written inside summarize).
- Prompts (task_end description, lifecycle section) updated to describe the
  embedded footer. If the engine rejects a commit after summarize, the
  pre-written artifact becomes an orphan temp file — harmless.

## 0.16.1 — fix corrupt session: notice messages need an id (2026-09-04)

- **Fix**: the host commits every pre-step decision message as a
  `user/message` session event VERBATIM, and load-time validation rejects a
  message event without a string `id` ("session event at seq N lacks an
  identified message") — marking the WHOLE stored session corrupt and making
  its history unloadable. The 0.15.2 notice shape `{role, content, source}`
  still lacked that `id`, so every session that received a same-request fold
  notice under 0.15.2+ became unloadable after restart (one such session
  bricked at seq 379458). Notice messages now carry `id: randomUUID()`,
  matching the host's own `createUserMessage` contract.

## 0.16.0 — fold region is exactly begin..end, deliverable stays on the surface (2026-09-04)

- **Behavior**: the deferred fold's region is now [begin anchor .. the
  task_end result's own seq] INCLUSIVE — previously it ran to the last
  surface node at fold time, sweeping in the deliverable and any post-end
  steps. Everything written after the end (the report, probes, later turns)
  stays on the surface untouched; a later task's own [begin..end] region
  swallows those leftovers in turn. The deliverable gate is unchanged (fold
  still fires only at the first step boundary after the deliverable lands);
  if the close result itself was shadowed by AUTO compaction the entry drops.

## 0.15.2 — fix crash: appended notice messages need a source (2026-09-04)

- **Fix**: v0.15.1's same-request notice appended bare `{role, content}`
  messages to the pre-step decision. The host commits every decision message
  as a user/message event, and its runtime-context projection then reads
  `message.source.kind` on each — the missing `source` crashed every step
  with "Cannot read properties of undefined (reading 'kind')". Notice
  messages now carry `source: {kind: 'plugin', plugin: 'dsh-taskfold'}`: not
  the system-prompt snapshots' identity (never suppressed), and the notice —
  including its artifact path — survives durably in history.

## 0.15.1 — fold notices arrive in the same request as the fold (2026-09-04)

- **Fix**: the host assembles a step's context BEFORE dispatching the
  pre-step waterfall, so a fold committed inside the hook could only surface
  its notice at the NEXT assembly — one step late. The listener now appends
  the notice (fold number, tokens, artifact path, per-message preview) as a
  user message to the waterfall decision's messages (defensively copied), so
  the model sees it in the very request the fold committed in. The
  context-callback queue remains as a fallback when the decision cannot be
  augmented (e.g., rejected decisions), with no double delivery.

## 0.15.0 — task_end for the model, system-only folds with old-style output (2026-09-04)

- **Behavior**: the model-facing close tool is renamed `task_fold` →
  `task_end` (closes the task, queues archival; success text now reads
  "Task ended: …"). Folding is executed ONLY by the system at the next step
  boundary — the manual "call task_fold again to force the fold" escape
  hatch is removed, and failed auto-folds just retry (nudge wording updated).
- **Behavior**: the system-executed fold now produces the old-style output
  the model used to get from task_fold: the JSONL artifact is written, and a
  ONE-SHOT runtime-context notice reports the fold — fold number, token
  count, artifact path, and the per-message preview — retracting on the next
  render.
- **Compat**: legacy logs with 'Task folded: ' results replay identically
  (reducer, grace scan, and intent registration accept both prefixes and
  both tool names); prompts (section, descriptions, todo bridge, nudges)
  updated to the task_end vocabulary.

## 0.14.1 — fix host crash: pre-step listener must follow the waterfall contract (2026-09-04)

- **Fix**: v0.14.0's `agent/pre-step` listener returned undefined and never
  called `next()`, so the host's waterfall decision was undefined and every
  step crashed with "Cannot read properties of undefined (reading 'kind')".
  The listener now awaits deferred folds inside the hook (as the engine's own
  AUTO compaction does) and always returns `next()`.

## 0.14.0 — full-deferred folds: queue on close, auto-fold after the deliverable (2026-09-04)

- **Behavior (design `docs/design/deferred-report-fold.md` v5)**: `task_fold`
  now closes the task and QUEUES archival; the span folds AUTOMATICALLY at
  the next agent step boundary after the task's deliverable text lands
  (possibly mid-turn). Every deliverable — user report or subagent report —
  is written with full uncompressed context; folding never precedes it.
- **Mechanism**: `taskMarks` state v9 adds `pendingArchives` (registered on
  close, dropped when a compaction event shadows the anchor); the
  `deferredArchivePlan` pure function implements the deliverable gate
  (reasoning/tool-calls are not deliverables; out-of-order deliverables defer
  behind the successor anchor; region ends before any still-open/pending
  successor); an `agent/pre-step` handler folds gated entries innermost
  first, re-reading state before each, with a 120s summarization signal guard.
- **Escape hatch & safety**: calling task_fold again for a queued task forces
  the fold immediately; a HOLD runtime-context warning appears while an
  auto-fold keeps failing (engine busy etc.); too-small spans settle without
  folding. `list_folds` titles deferred folds via the summary's `# <name>`
  heading (in-flight-call correlation kept as the primary path).
- **Cleanup**: `foldDecision` (superseded by closeTarget + deferredArchivePlan)
  removed with its tests; tool and system-prompt copy rewritten for the new
  contract. State v8 → v9 (mismatch = full replay, old logs byte-stable).

## 0.13.0 — deliver-then-fold contract (2026-09-04)

- **Behavior**: the closing order is inverted and unified. When a task's work
  is done, the report or deliverable (to the user, or a subagent's report to
  its parent) is written FIRST, with full context, in its own step — then
  task_fold is called immediately, alone in a step, folding the span with the
  deliverable included. This removes the fold-first/relay ordering that made
  deliverables derive from compressed summaries (the subagent quality issue),
  keeps done-state dwell at zero (no context interleaving, minimal KV-cache
  invalidation), and absorbs the v0.12.0 delegation exemption into one rule.
  Deliver and fold must be SEPARATE steps (a deliverable sharing the
  task_fold message falls outside the fold).
- `task_fold`'s result now carries a deviation check instead of a relay
  instruction: only if the deliverable was never sent in an earlier step (and
  no tasks remain open) does it direct writing one from the fold summaries.
- Fold summaries: delivered reports inside the span are cited, not restated;
  the relay rule stays as fallback for never-sent deliverables.
- Mechanism unchanged (foldDecision/execute/boundary fallback identical to
  0.12.0); design converged over a four-round adversarial review
  (docs/design/lazy-fold.md).

## 0.12.0 — five-round prompt overhaul + delegation deliverable carve-out (2026-09-04)

- **Prompt (five-round adversarial review, fully landed)**: granularity rule
  (a task produces a verifiable outcome; single reads/greps are steps; when in
  doubt it is a task), bookmark-not-deadline suspension semantics, detour
  wrapping folded into the multi-part MUST, dedup of LIFO/exception detail
  between section and descriptions (~40% fixed overhead cut), summary budgets
  (80–150 words typical / 250 large / 300 cap; User inputs uncapped by
  design), What-happened vs Changes boundary (grep-able), on-demand recall
  recipe with dependency line ("when a new task depends on a folded task,
  recall it before starting"), nudge-2 three-way branch (done / blocked /
  genuinely waiting), todo bridge granularity fix, relay text synced.
- **Prompt (timing fix)**: a delegation's final deliverable (a subagent's
  report to its parent) is composed and sent with FULL context BEFORE
  folding — fold afterwards as the archival last action. Evidence: the
  five-round reviewer's own artifacts showed every deliverable was written
  post-fold from the summary alone (round 1: 47 KB of reading compressed
  before its review was composed). Fold-first now applies only to interactive
  closing reports to the human user.
  - five-round prompt review — granularity rule, bookmark semantics, dedup, summary budget, dependency recall

## 0.11.0 — runtime-context snapshots read harness: in the preview (2026-09-04)

- **Features**: plugin-injected messages (runtime-context snapshots, sandbox
  and approval policy lines, lifecycle nudges) arrive as user-role messages;
  the preview now labels them `NN harness: …` via their `source.kind ===
  'plugin'` provenance. Three-way distinction at a glance: `user:` genuine
  human input, `tool:` tool results, `harness:` environment snapshots.

## 0.10.0 — preview distinguishes tool results from user input (2026-09-04)

- **Features**: harness tool results arrive as user-role messages, which made
  them indistinguishable from genuine user input in the span preview. A
  message whose blocks are all tool-results now reads `NN tool: ←…`; real
  user text (and runtime-context snapshots) keeps `NN user: …`. Mixed-block
  messages keep their original role label.

## 0.9.0 — teach the model the recall path (2026-09-04)

- **Prompt**: the lifecycle section now carries the full recall recipe —
  `list_folds` (title + fold number index) → `fold_recall({ fold: N })`
  (regenerates the span's original messages as JSONL) → read/grep it; when a
  fold summary lacks a needed detail, recall instead of guessing or asking
  the user.
- **Prompt**: fold summaries keep their anchors (file paths, commands, error
  strings) precise — paths verbatim — so they answer most questions alone and
  double as grep keywords when recall is needed.

## 0.8.0 — common preview glyphs: ← for results, ↵ for line breaks (2026-09-04)

- **Fix**: the preview used rare glyphs that read oddly (hollow double-stroke
  `⇐`, and `⏎`). Tool results now use the common left arrow `←`, and original
  line breaks render as `↵` (the return-key symbol). Tool calls keep `→`.

## 0.7.0 — JSONL artifacts slim to role + content (2026-09-04)

- **Breaking (artifact shape only)**: each JSONL line is now the message
  reduced to `{role, content}` — full original content blocks, no host
  provenance metadata (`source`, `replayState` with provider/model/responseId,
  message ids). Recall serves content recovery; audit metadata stays in the
  durable event log. Lines get shorter and easier to read back before the read
  tool's truncation. Preview/line-number contract unchanged; existing `.jsonl`
  artifacts with metadata remain valid JSONL and still parse.

## 0.6.1 — pwsh brief falls back to the command when description is missing (2026-09-04)

- **Fix**: `description` is model-provided and can be absent or empty; the
  pwsh call brief now falls back to a slice of the command itself instead of
  rendering `→pwsh ‹›`.

## 0.6.0 — web-UI-style briefs for common tools in the span preview (2026-09-04)

- **Features**: preview fragments are now tool-aware (one line per message is
  unchanged — the JSONL line mapping contract holds):
  - `read`/`write`: full file path on the call side; the result side shows a
    content excerpt instead of repeating the path header.
  - `edit`: path plus a line delta (`→edit p.mjs +4 -2`) computed from the
    old/new strings.
  - `grep`: call shows the pattern (and include filter); result collapses to
    match stats (`⇐5 matches · 2 files`).
  - `pwsh`: call shows the command's description (`→pwsh ‹Run live probe›`).
  - Unknown tools keep the generic `→name(args)` / `⇐excerpt` form; results
  correlate with their call via toolCallId, degrading safely without the map.

## 0.5.2 — relay instruction moved to its own line (2026-09-04)

- **Fix**: in `task_fold`'s success output, the relay instruction was appended
  to the last span-preview line with only a space, reading as if it were part
  of the folded message. It now starts on its own line after the preview.

## 0.5.1 — span preview marks original line breaks with ⏎ (2026-09-04)

- **Fix**: preview lines flattened ALL whitespace, so multi-line tool results
  read as if a line break were missing. Newlines inside a block now render as a
  visible `⏎` marker — the preview stays one line per message, but the model
  can see where the original line breaks were.

## 0.5.0 — span preview in fold output, JSONL artifacts (2026-09-04)

- **Behavior**: `task_fold`'s result now carries a one-line-per-message
  preview of the folded span — every folded message summarized as a single
  numbered line (`NN role: [think]… →tool(args) ⇐result`, whitespace
  flattened, clipped), capped at 30 lines with an overflow pointer.
- **Artifact format change**: span artifacts are now **JSONL** — one message
  per line, in the exact order and numbering of the preview lines, so the
  model can map a preview line straight to its full original by line number.
  `fold_recall` regenerates the same JSONL format and also prints the
  preview. Old `.json` artifacts already on disk remain readable.
- New shared module `plugins/span-preview.mjs` (single source for both
  plugins, keeps preview and file numbering in lockstep); 4 new tests
  (51 total).

## 0.4.3 — supported-dsh-versions declaration + release-flow reminder (2026-09-03)

- **Docs**: both READMEs gain a "Supported dsh versions" section — known-good
  `0.1.2-alpha.5`, minimum `0.1.2-alpha.5` (older alphas differ in the
  compaction-engine internals), upper bound untested/unenforced (dsh has no
  host-version negotiation yet; incompatible hosts degrade, never corrupt).
- **Tooling**: `release` flow now shepherds that section — `draft` prints a
  reminder to update it when compatibility changes, and `release` warns if
  either README is missing the section entirely.

## 0.4.2 — README rewritten around benefits, "effectively infinite context" tagline (2026-09-03)

- **Docs**: both READMEs rewritten — lead with a one-line value proposition and
  the tagline "taskfold — effectively infinite context for your coding agent",
  explain the mechanism in plain words (fold finished tasks into summaries,
  recall originals on demand), and trim implementation detail (the old deep
  dive remains in git history).

## 0.4.1 — closing report becomes conditional (2026-09-03)

- **Behavior**: the closing report is now conditional, not mandatory. After a
  successful fold, a report is written only when the user is still owed one;
  skip it when the outcome was already reported during the work, and never
  write one for an inner subtask fold — continue the surrounding work instead.
- The relay instruction in `task_fold`'s success text now carries the same
  condition, and the lifecycle section spells out the skip rules.

## 0.4.0 — fold-first closing contract (2026-09-03)

- **Behavior**: the task lifecycle section now orders the closing sequence —
  when a task's work is done, `task_fold` is the FIRST closing action, and the
  user-facing closing report is written AFTER the fold, based on the fold
  summary node then present in context. This resolves the double-summary
  conflict: no more "summary of a summary" (fold-then-report from memory) and
  no more reports swallowed into their own fold (report-then-fold).
- `task_fold` success text ends with an explicit relay instruction (summary
  node in context — adapt wording for the user, no second summary layer);
  degraded paths (tooSmall/unfolded) stay unchanged.
- `FOLD_SUMMARY_INSTRUCTION` gains a rule that the summary doubles as the
  user-facing closing report basis and must stay human-readable; test pins it.

## 0.3.0 — release flow script (2026-09-03)

- **Release tooling** (`scripts/release.mjs`, offline-tested in
  `test/release.test.mjs`): CHANGELOG.md is the single source of truth for the
  version; `package.json` is synced by the script, never by hand — the 0.1.0
  desync cannot recur.
  - `draft`: groups commits since the last version tag (Conventional Commit
    prefixes) into a dated draft entry prepended to CHANGELOG.md for human
    review.
  - `release`: reads the top CHANGELOG version, syncs package.json, commits,
    tags `vX.Y.Z`, pushes master and the tag; a push blocked by the
    environment enters a PENDING state and re-running resumes it.
  - `status`: reports current version, CHANGELOG/package.json agreement, and
    unpushed commits/tags.
- README (en/zh): "Release flow" usage section.
- Fix: the package.json version rewrite regex missed the key's closing quote
  (`"(version)\s*:` never matched `"version":`), which aborted the first real
  `release` run mid-way; corrected and verified against the live file.

## 0.2.3 — mandatory-tone lifecycle section

- **System prompt section rewritten from descriptive to mandatory**: opens with
  "MANDATORY task lifecycle discipline: every discrete task MUST be wrapped in
  task marks"; unmarked tool work on a discrete task and leaving a finished
  task open are both named protocol violations; multi-module work MUST be
  split into nested subtasks; runtime-context nudges are "binding, not
  advisory". Dropped the `## Task lifecycle compaction` heading (the section
  now reads as directives, not documentation).

## 0.2.2 — fold summaries keep user inputs and pitfalls

- **Five-section fold instruction** (`FOLD_SUMMARY_INSTRUCTION`, exported for
  offline tests): fold summaries now carry `## User inputs & decisions` (the
  user's requests, corrections, answers, approvals from the span, verbatim
  where wording matters) and `## Pitfalls & gotchas` (failed attempts and why,
  workarounds, environment traps, "don't do X again" lessons) as first-class
  sections alongside What happened / Changes / Outcomes.
- Borrowed rule from the stock checkpoint instruction, reworded for folds:
  capture user feedback faithfully, especially corrections; never drop why
  something failed. Continuity-checkpoint sections (Pending Jobs / Current
  Work / Next Step) stay banned — they contradict the fold's CLOSED-task
  contract.

## 0.2.1 — nested folds own their full span

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
