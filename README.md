# cmpct — Cordis + Compact Region agent preset

An agent preset for [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) (DSH): the standard `cordis` coding-agent composition, plus a family of region-compaction tools.

> **This is a preset, not a marketplace bundle.** It is installed by cloning into `.agent-presets/`, not by `dsh plugin add`. See [Install](#install).

## What it adds

`plugins/compact-region.mjs` registers four model tools inside the preset's `compaction` isolate realm:

| Tool | Purpose |
| --- | --- |
| `compact_inspect` | Read-only listing of the conversation surface: 1-based positions, roles, previews, and valid compaction edges. |
| `compact(start, end)` | Ad-hoc compression of an explicit surface range into one summary node. |
| `task_begin` | Start a **named** task: `task_begin({ name })`. The name is the task's identity — echoed in ordinary tool output (no context injection). |
| `task_end` | Close the task **by name**: `task_end({ name })`. State transition only, returns immediately; its output lists what ended and what remains open. It records the ended task's full span (`task_begin` pair + body + `task_end` pair) for folding; it never folds itself. |
| `task_commit` | Fold the most recently ended task into one summary node, INLINE, labelled by the task's name. Because the `task_end` result is inside the range, the summary reflects the COMPLETED task — no temporal blind spot, no "call task_end" pending. Too-small spans stay as-is. |
| `compact_stats` | Read-only observability: surface length, every committed fold with its estimated shadowed tokens and summary preview, cumulative totals, and unknown-event-type drift warnings. |
| `compact_recall` | Read the ORIGINAL content of folded entries back from the append-only event log. Seqs are stable archive ids; supports a fold manifest, a single entry, a seq range, and a `full` text mode. |

`plugins/compact-stats.mjs` provides `compact_stats` and `compact_recall` (no service dependency). Fold previews skip section headers and stale task-lifecycle lines, so a fold's face is its substance, not boilerplate or resolved-pending noise.

It also injects a task-lifecycle prompt section and a todo bridge through runtime context. There is deliberately NO standing "open task marks" line: depth and the closing reminder already ride in every `task_begin`/`task_end` result text (which the mark projection derives from), so a snapshot echo would fire after every lifecycle call with no new information. Runtime context is reserved for the todo bridge below.

### Engine tiers (realm / self-host)

The fold-capable tools (`compact`, `task_commit`) need a compaction engine. `compact-region.mjs` no longer requires one at load time — `inject` does not list `compaction` (direct property access on an undeclared cordis service THROWS, so the plugin never touches it that way). Instead `engineFor()` resolves lazily, in tiers:

1. **Realm engine** — a composition row (e.g. `dsh-compaction-basic` inside the compaction group) that already registered `ctx.compaction`. Probed via `ctx.get('compaction')`, the inject-free optional accessor; when it answers, the plugin uses that instance and constructs nothing.
2. **Self-host** — no engine registered anywhere visible. The plugin dynamically imports `@deepseek-ai/dsh-compaction-basic` and constructs `new BasicCompactionEngine(ctx, { auto: false })`: no automatic-compaction listeners, no trigger policy — just `compactRegion`. The cordis `Service` base registers the instance as it sees fit, and the plugin caches its own reference so construction happens at most once. Resolution: bare specifier first (works under a `node_modules` tree, e.g. a profile npm install), then a file-URL fallback that walks up from host anchors (`process.argv[1]`, cwd) to the `node_modules` dir containing the engine package — preset directories sit outside any `node_modules` tree, but the running host always does. If both fail, fold-capable tools return an honest "compaction service is unavailable" while `task_begin`/`task_end` and the observability tools keep working.

Because tier 2 needs only host-plane services (`tokenMeter`, `llm` — both injected), the plugin folds in compositions with **no compaction group at all** (validated live on a `minimal`-derived preset: full begin → end → commit cycle through the self-hosted engine). This is also what makes a future profile-level install (`dsh plugin add`) viable in standard mode.


### Archive recall

Folding removes entries from the **surface projection** only — the append-only event log keeps every original event forever, and each `compaction/summary` records the archived seqs (`shadowedSeqs`). `compact_recall` turns that into random access for the model: no args lists every fold; `{ fold: N }` renders the fold's manifest (seq → kind/toolNames/preview for each archived entry); `{ seq }` returns one entry (noting which fold archived it, or that it is still live); `{ from, to }` filters archived seqs; `full: true` raises the per-entry cap from 60 to 4000 chars. Surface positions shift after every fold, so seqs — not positions — are the addressing scheme. Folds predating `shadowedSeqs` report an explicit error instead of pretending to be empty.

**Fold titles**: folds are labelled by the task's NAME — `task_commit` uses the name that closed the ended task (recorded in `lastEnded`, persisted in the projection). `compact_stats`/`compact_recall` extract the label from the folded `task_end` result text (`Task ended: NAME`) and prefer it over the first-line preview; legacy folds carrying an explicit `Title:` line still fall back correctly. Manual `compact()` folds stay untitled. No custom event types are involved.

### Mark persistence (named tasks)

Open tasks are **named derived state**: the `taskMarks` session projection folds harness-native events only — an `assistant/message` carrying `task_begin`/`task_end` tool-call blocks registers a pending intent keyed by callId, and the matching `tool-result` block decides by its rendered text (`Task begun: NAME` pushes a `{ seq, name }` mark; `Task ended: NAME` pops the most-recent mark with that name; failures change nothing). Tasks are closed **by name**, not by an implicit stack position, so mismatched or interleaved ending cannot corrupt other tasks. A successful end-pop also records `lastEnded { beginSeq, endSeq, name }` — the ended task's full span — which `task_commit` folds inline and labels with the name; a `compaction/summary` covering `endSeq` clears the record. Legacy `task/mark` whole-value snapshots (v1 era) act as authoritative reset points, baselining away pre-v2 ghosts. The plugin never appends custom event types. Because the event log is append-only and folds never remove events, names and the pending-fold record survive host restarts, session resume, and compaction. Other host components can read them via `sessionProjections.stateOf(session, 'taskMarks')`. Tasks deliberately do **not** reset at `turn/start`.

### Todo bridge

The plugin reads the stock `todos` projection (registered by the `dsh-tool-todo` row; the `todo_write` tool itself is never wrapped) and nudges pairing through runtime context: when a todo item is in progress without a matching task it asks for `task_begin`; when the in-progress list shrank while tasks remain open it asks for `task_end`. The bridge engages only once the model has written a list in the current turn; todo state is never destroyed or rewritten. Task lifecycle calls themselves produce NO runtime-context snapshots — their outputs already carry the state (what began/ended, what remains open, and the `task_commit` reminder right after an end).

### Lifecycle nudges

Beyond the todo bridge, the context watches for three ways the lifecycle gets skipped, and speaks up only then — a clean begin→work→end→commit flow stays completely silent. Ages are measured in **model rounds** (assistant messages), never raw event seqs: one tool call can append thousands of events, so seq distance is meaningless as time.

Nudges use **hold semantics**: a nudge line renders for as long as its condition holds and retracts the moment it clears (task opened, task closed, fold committed). The snapshot engine is diff-driven, so a held line costs nothing while it waits — an unchanged render produces no new snapshot, and clearing produces exactly one retraction. For that to work, nudge wording past its threshold is deliberately **number-free** ("20+ rounds", never "~23 rounds"): a line whose text changed every round would emit a snapshot every round.

| Signal | Holds while | Retracts when | Asks for |
| --- | --- | --- | --- |
| Work without a task | no open task, ≥3 non-task tool calls in the last 10 rounds, **no fold question open** (no `lastEnded` awaiting commit, and no end/commit outcome within the last 3 rounds — right after a task closes, the pending obligation is `task_commit`, not `task_begin`) | a task begins, the work stops, or the grace expires | `task_begin({ name })` |
| A task left open | the newest open mark is 20+ rounds old | the named task is closed | `task_end({ name })` (names the task) |
| An end never committed | a `lastEnded` record exists and the model's next step after `task_end` was not `task_commit` | `task_commit` folds it | `task_commit` (names the task) |

### Tool-name collisions

Tool names live in a shared registry. If your host composition or another mounted preset already registers `compact`, `task_begin`, `task_end`, `task_commit`, `compact_stats`, `compact_recall`, or `compact_inspect`, the duplicate registration fails — mount only one provider of these names at a time.

## Install

```sh
git clone https://github.com/<you>/cmpct "$(dsb="${DSH_HOME:-$HOME/.dsh}"; echo "$dsb/.agent-presets/cmpct")"
```

Then start a new session on the `cmpct` preset. Presets are plain directories; to update, `git pull` and restart.

> **Trust:** this preset's composition includes the self-referential Cordis toolset. A session running on it can read and modify the harness it runs on — treat it as shell access.

## Layout

```
preset.yml        preset metadata
agent.cordis.yml  the full composition (a copy of the shipped `cordis` preset + compact-region)
plugins/          compact-region.mjs (lifecycle tools) and compact-stats.mjs (stats + recall)
docs/             design notes
test/             offline test suites (node test/*.test.mjs)
```

## Corrupt-edge policy

If an event on the surface is missing (e.g. after an external fold), edge flags are marked unreliable from the break until the next user-message boundary, at which point pairing accounting is re-baselined — a single corrupt spot does not disable compaction for the rest of the session.

## License

MIT. Developed against the DeepSeek Harness (`@deepseek-ai/*`, MIT) public packages.
