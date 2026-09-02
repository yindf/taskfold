# taskfold

[English](README.md) | [中文](README.zh.md)

Keeps long coding-agent sessions lean: wrap work in named tasks and, when one is done, fold its whole span into a short titled summary. The conversation stays readable, context costs stay low, and every fold's original content can be read back on demand. For [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) (DSH).

Installable two ways:

- **As a plugin bundle** (recommended): `dsh plugin add` into a profile — the tool family lands on the host plane and every session, on every preset, gets it. The compaction engine is self-hosted when the session's composition provides none.
- **As an agent preset**: clone into `.agent-presets/` — the full `cordis` coding-agent composition plus the taskfold tools inside the compaction realm.

## What it adds

Seven model tools:

| Tool | Purpose |
| --- | --- |
| `task_begin({ name })` | Begin a **named** task. The name is the identity; state rides in the tool output, no context injection. |
| `task_fold({ name })` | Close the task **by name AND fold its span** (begin pair + body) into one summary node titled by the name — one call does both. Failure is atomic: the mark stays, retry. Output carries remaining tasks, the fold number, and the **span artifact** path. Too-small spans end the task but stay unfolded. |
| `list_folds` | Fold index: every committed fold (number, tokens, title/preview) plus session totals — the fold numbers `fold_recall` consumes. |
| `fold_recall({ fold })` | Regenerate a fold's span artifact file when the temp copy has been cleaned. One parameter. |

`plugins/compact-region.mjs` provides the lifecycle tools; `plugins/compact-stats.mjs` provides the fold index + recall (no service dependency).

### Span artifacts (exact original context)

Every successful fold writes the span's **exact original request context** — the same messages the model was sent, derived by the harness's own `session.deriveEventMessage(session.eventAt(seq))` pair (the same API the engine's summarizer replays) — as a JSON file to the OS temp dir (`taskfold-artifacts/`), including reasoning blocks, tool-call arguments, and tool results verbatim. The `task_fold` output carries the path; the model reads/greps it with any file tool. Temp files are conveniences, not the source of truth: the append-only log is, so `fold_recall({ fold: N })` regenerates any artifact on demand.

### Engine (scoped, self-hosted)

Explicit folds (`task_fold`) always run through the plugin's own `ScopedEngine extends BasicCompactionEngine`: only `summarize()` is overridden — replacing the stock continuity-checkpoint instruction with a **span-scoped** one (summarize only what the span contains, for the continuing model; never restate project background) that also DECLARES the task closed (the span cannot contain its own ending, so the instruction compensates) — while locking, validation, stability checks, and the commit path stay stock. The LLM call replays the same prefix (provider cache reuse preserved); only the appended instruction differs.

A composition row's engine (`dsh-compaction-basic`) is deliberately left to serve **auto** compaction (pressure/overflow), where checkpoint semantics are exactly right. The two instances stay mutually exclusive through the durable event-log lock. Constructed on a shim ctx (no service-registration collisions) with `auto: false`, resolved by bare specifier first (profile installs), then a file-URL fallback walking up from host anchors to the engine package's `node_modules`.

Tier independence needs only host-plane services (`tokenMeter`, `llm`), so the plugin folds in compositions with **no compaction group at all** — validated live on a `minimal`-derived preset and via profile-level install. Compatible with dsh 0.1.2-alpha.4's on-demand session APIs (`snapshotEvents()`; older versions' `session.events` still honored).

### State model

- Open tasks are **named derived state**: the `taskMarks` session projection folds harness-native events only — tool-call blocks register pending intents, tool-result text (`Task begun: NAME` / `Task folded: NAME`) pushes/pops by name. Closing by name cannot corrupt other tasks; a failed `task_fold` changes nothing (atomic end-and-fold).
- Marks survive host restarts, session resume, and compaction (append-only log). Nameless legacy marks self-heal away at projection load.

### Lifecycle nudges (hold semantics)

A clean begin→work→end flow stays completely silent. When the flow is skipped, a nudge line appears and **holds** (renders every round, byte-stable) until its condition clears — the diff-driven snapshot engine means a held line costs nothing while it waits, and clearing produces exactly one retraction. Ages are measured in **model rounds**, never raw event seqs.

| Signal | Holds while | Asks for |
| --- | --- | --- |
| Work without a task | no open task, ≥3 non-task tool calls in the last 10 rounds (3-round grace after a task_fold) | `task_begin({ name })` |
| A task left open | the newest open mark is 20+ rounds old | `task_fold({ name })` |

A todo bridge additionally pairs in-progress todo items with task marks (the stock `todo_write` tool is never wrapped).

## Install

**Plugin bundle** (any profile; tools available in every session):

```sh
dsh plugin --profile web add github:yindf/taskfold
```

**Agent preset** (full `cordis` composition + taskfold):

```sh
git clone https://github.com/yindf/taskfold "$(dsb="${DSH_HOME:-$HOME/.dsh}"; echo "$dsb/.agent-presets/taskfold")"
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
