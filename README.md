# cmpct

[English](README.md) | [中文](README.zh.md)

Task-lifecycle conversation compaction for [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) (DSH): **named tasks** whose full span folds into one summary node, ad-hoc region compaction, archive recall, and hold-semantics lifecycle nudges.

Installable two ways:

- **As a plugin bundle** (recommended): `dsh plugin add` into a profile — the tool family lands on the host plane and every session, on every preset, gets it. The compaction engine is self-hosted when the session's composition provides none.
- **As an agent preset**: clone into `.agent-presets/` — the full `cordis` coding-agent composition plus the cmpct tools inside the compaction realm.

## What it adds

Seven model tools:

| Tool | Purpose |
| --- | --- |
| `task_begin({ name })` | Begin a **named** task. The name is the identity; state rides in the tool output, no context injection. |
| `task_end({ name })` | Close the task **by name** (terminal, state transition only). Records the ended span (`task_begin` pair + body + `task_end` pair) for folding. |
| `task_commit` | Fold the ended task's full span into one summary node titled by the task name. The `task_end` result is inside the range, so the summary sees the COMPLETED task — no stale "call task_end" pending. Too-small spans are reported and durably abandoned. |
| `compact_inspect` | Read-only surface listing: 1-based positions, roles, previews, valid compaction edges. |
| `compact(start, end)` | Ad-hoc compression of an explicit surface range into one summary node. |
| `compact_stats` | Observability: surface length, every committed fold (tokens, preview, title), cumulative totals, drift warnings. |
| `compact_recall` | Read the ORIGINAL content of folded entries back from the append-only event log — fold manifests, single entries, seq ranges, `full` text mode. |

`plugins/compact-region.mjs` provides the five lifecycle/region tools; `plugins/compact-stats.mjs` provides stats + recall (no service dependency).

### Engine tiers (realm / self-host)

The fold-capable tools (`compact`, `task_commit`) resolve a compaction engine lazily:

1. **Realm engine** — a composition row (`dsh-compaction-basic`) that already registered `ctx.compaction`. Probed via `ctx.get('compaction')`; when it answers, nothing is constructed.
2. **Self-host** — `new BasicCompactionEngine(ctx, { auto: false })`: no automatic-compaction listeners, no trigger policy, just `compactRegion`. Resolved by bare specifier first (profile installs), then a file-URL fallback walking up from host anchors to the engine package's `node_modules`.

Tier 2 needs only host-plane services (`tokenMeter`, `llm`), so the plugin folds in compositions with **no compaction group at all** — validated live on a `minimal`-derived preset and via profile-level install. Compatible with dsh 0.1.2-alpha.4's on-demand session APIs (`snapshotEvents()`; older versions' `session.events` still honored).

### State model

- Open tasks are **named derived state**: the `taskMarks` session projection folds harness-native events only — tool-call blocks register pending intents, tool-result text (`Task begun: NAME` / `Task ended: NAME`) pushes/pops by name. Closing by name cannot corrupt other tasks; failures change nothing.
- A successful end records `lastEnded { beginSeq, endSeq, name }` (persisted, restart-safe); `task_commit` folds that span; a covering `compaction/summary` — or a terminal too-small verdict — clears the record.
- Marks survive host restarts, session resume, and compaction (append-only log). Nameless legacy marks self-heal away at projection load.

### Lifecycle nudges (hold semantics)

A clean begin→work→end→commit flow stays completely silent. When the flow is skipped, a nudge line appears and **holds** (renders every round, byte-stable) until its condition clears — the diff-driven snapshot engine means a held line costs nothing while it waits, and clearing produces exactly one retraction. Ages are measured in **model rounds**, never raw event seqs.

| Signal | Holds while | Asks for |
| --- | --- | --- |
| Work without a task | no open task, ≥3 non-task tool calls in the last 10 rounds, and no fold question open (3-round grace after any end/commit outcome) | `task_begin({ name })` |
| A task left open | the newest open mark is 20+ rounds old | `task_end({ name })` |
| An end never committed | the step after `task_end` was not `task_commit` | `task_commit` |

A todo bridge additionally pairs in-progress todo items with task marks (the stock `todo_write` tool is never wrapped).

## Install

**Plugin bundle** (any profile; tools available in every session):

```sh
dsh plugin --profile web add github:<you>/cmpct
```

**Agent preset** (full `cordis` composition + cmpct):

```sh
git clone https://github.com/<you>/cmpct "$(dsb="${DSH_HOME:-$HOME/.dsh}"; echo "$dsb/.agent-presets/cmpct")"
```

Restart dsh after either. Do not mount both in the same process — tool names live in a shared registry and duplicate registration fails.

> **Trust:** the preset form ships the self-referential Cordis toolset — a session on it can read and modify the harness it runs on. Treat it as shell access. The plugin-bundle form carries tools only.

## Layout

```
package.json      npm manifest + dsh.bundle.patch declaration
cordis.patch.yml  host-plane bundle patch (plugin install path)
preset.yml        preset metadata
agent.cordis.yml  full composition (preset path)
plugins/          compact-region.mjs, compact-stats.mjs
test/             offline suites (node test/*.test.mjs) — 32 tests
CHANGELOG.md      release history
```

## Corrupt-edge policy

If a surface event goes missing (e.g. after an external fold), edge flags are marked unreliable from the break until the next user-message boundary, where pairing accounting is re-baselined — one corrupt spot never disables compaction for the rest of the session.

## License

MIT. Developed against the DeepSeek Harness (`@deepseek-ai/*`, MIT) public packages.
