# cmpct — Cordis + Compact Region agent preset

An agent preset for [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) (DSH): the standard `cordis` coding-agent composition, plus a family of region-compaction tools.

> **This is a preset, not a marketplace bundle.** It is installed by cloning into `.agent-presets/`, not by `dsh plugin add`. See [Install](#install).

## What it adds

`plugins/compact-region.mjs` registers four model tools inside the preset's `compaction` isolate realm:

| Tool | Purpose |
| --- | --- |
| `compact_inspect` | Read-only listing of the conversation surface: 1-based positions, roles, previews, and valid compaction edges. |
| `compact(start, end)` | Ad-hoc compression of an explicit surface range into one summary node. |
| `task_begin` | Push a task mark onto the session's LIFO stack. |
| `task_end` | Always closes the innermost task. If its span is large enough, it is compacted into one summary node automatically; if the span is empty or too small to be worth summarizing, the task still ends and the result reports that nothing was compacted. Optional `title` (short imperative name) labels the fold in `compact_stats`/`compact_recall` listings. |
| `compact_stats` | Read-only observability: surface length, every committed fold with its estimated shadowed tokens and summary preview, cumulative totals, and unknown-event-type drift warnings. |
| `compact_recall` | Read the ORIGINAL content of folded entries back from the append-only event log. Seqs are stable archive ids; supports a fold manifest, a single entry, a seq range, and a `full` text mode. |

`plugins/compact-stats.mjs` provides `compact_stats` and `compact_recall` (no service dependency).

It also injects a task-lifecycle prompt section. There is deliberately NO standing "open task marks" runtime-context line: depth and the closing reminder already ride in every `task_begin`/`task_end` result text (which the mark projection derives from), so a snapshot echo would fire after every lifecycle call with no new information. Runtime context is reserved for the todo bridge below.

### Archive recall

Folding removes entries from the **surface projection** only — the append-only event log keeps every original event forever, and each `compaction/summary` records the archived seqs (`shadowedSeqs`). `compact_recall` turns that into random access for the model: no args lists every fold; `{ fold: N }` renders the fold's manifest (seq → kind/toolNames/preview for each archived entry); `{ seq }` returns one entry (noting which fold archived it, or that it is still live); `{ from, to }` filters archived seqs; `full: true` raises the per-entry cap from 60 to 4000 chars. Surface positions shift after every fold, so seqs — not positions — are the addressing scheme. Folds predating `shadowedSeqs` report an explicit error instead of pretending to be empty.

**Fold titles**: `task_end({ title })` renders a `Title:` line into its own native tool-result event; `compact_stats`/`compact_recall` extract it and label the fold their `compactRegion` committed (listings prefer the title over the first-line preview). Manual `compact()` folds and untitled task folds fall back to the preview. No custom event types are involved.

### Mark-stack persistence

The open-mark stack is **derived state**: the `taskMarks` session projection folds harness-native events only — an `assistant/message` carrying `task_begin`/`task_end` tool-call blocks registers a pending intent keyed by callId, and the matching `tool-result` block decides by its rendered text (success prefixes push/pop; failures and transient errors change nothing). Legacy `task/mark` whole-value snapshots (v1 era) act as authoritative reset points in the fold, baselining away pre-v2 ghosts such as the v0-era `task_abort` that mutated only plugin memory. The plugin never appends custom event types: the harness read side refuses unknown event types that are not marked `ignorable`, and the write side has no API to set that flag (the v1 design made sessions unloadable on 0.1.2-alpha.3). Because the event log is append-only and folds never remove events, marks survive host restarts, session resume, and compaction. Other host components can read the stack via `sessionProjections.stateOf(session, 'taskMarks')`. Unlike the stock `todos` projection, marks deliberately do **not** reset at `turn/start` — tasks span user turns.

### Todo bridge

The plugin reads the stock `todos` projection (registered by the `dsh-tool-todo` row; the `todo_write` tool itself is never wrapped) and nudges pairing through runtime context: when a todo item is in progress without a matching task mark it asks for `task_begin`; when the in-progress list shrank while marks remain open it asks for `task_end`. The bridge engages only once the model has written a list in the current turn, todo state is never destroyed or rewritten, and parallel `in_progress` items map to the mark stack by count. Note the inherent push-cycle: with todos in play, the nudge appears after `todo_write` and its quiet retraction lands as a snapshot right after the complying `task_begin`/`task_end` — turning a signal off is itself a signal. Without todos involved, task lifecycle calls produce no runtime-context snapshots at all.

### Tool-name collisions

Tool names live in a shared registry. If your host composition or another mounted preset already registers `compact`, `task_begin`, `task_end`, `compact_stats`, `compact_recall`, or `compact_inspect`, the duplicate registration fails — mount only one provider of these names at a time.

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
