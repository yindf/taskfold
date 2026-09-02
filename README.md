# taskfold

[English](README.md) | [中文](README.zh.md)

Keeps long coding-agent sessions lean: wrap work in named tasks and, when one is done, fold its whole span into a short titled summary. The conversation stays readable, context costs stay low, and every fold's original content can be read back on demand. For [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) (DSH).

Install as a plugin bundle:

- `dsh plugin add` into a profile — the tool family lands on the host plane and every session, on every preset, gets it. The compaction engine is self-hosted when the session's composition provides none.

## What it adds

Four model tools:

| Tool | Purpose |
| --- | --- |
| `task_begin({ name })` | Begin a **named** task. The name is the identity; state rides in the tool output, no context injection. A name already open is rejected; names must not contain " —". |
| `task_fold({ name })` | Close the **innermost** open task by name AND fold its span (begin pair + body) into one summary node titled by the name — one call does both. LIFO: newer open tasks block older ones; a blocked or unknown name fails atomically (retry after closing the newer task). Output carries remaining tasks, the fold number, and the **span artifact** path. Too-small spans — or an unavailable engine / a shadowed mark — still end the task, unfolded. |
| `list_folds` | Fold index: every committed fold (1-based chronological number, tokens, title/preview) plus session totals — the fold numbers `fold_recall` consumes. |
| `fold_recall({ fold })` | Regenerate a fold's span artifact file when the temp copy has been cleaned. One parameter. |

`plugins/compact-region.mjs` provides the lifecycle tools; `plugins/compact-stats.mjs` provides the fold index + recall (no service dependency).

### Span artifacts (exact original context)

Every successful fold writes the span's **exact original request context** — the same messages the model was sent, derived by the harness's own `session.deriveEventMessage(session.eventAt(seq))` pair (the same API the engine's summarizer replays) — as a JSON file to the OS temp dir (`taskfold-artifacts/`), including reasoning blocks, tool-call arguments, and tool results verbatim. The `task_fold` output carries the path; the model reads/greps it with any file tool. Temp files are conveniences, not the source of truth: the append-only log is, so `fold_recall({ fold: N })` regenerates any artifact on demand.

### Engine (scoped, self-hosted)

Explicit folds (`task_fold`) always run through the plugin's own `ScopedEngine extends BasicCompactionEngine`: only `summarize()` is overridden — replacing the stock continuity-checkpoint instruction with a **span-scoped** one (summarize only what the span contains, for the continuing model; never restate project background) that also DECLARES the task closed (the span cannot contain its own ending, so the instruction compensates) — while locking, validation, stability checks, and the commit path stay stock. The LLM call replays the same prefix (provider cache reuse preserved); only the appended instruction differs.

A composition row's engine (`dsh-compaction-basic`) is deliberately left to serve **auto** compaction (pressure/overflow), where checkpoint semantics are exactly right. The two instances stay mutually exclusive through the durable event-log lock. Constructed on a shim ctx (no service-registration collisions) with `auto: false`, resolved by bare specifier first (profile installs), then a file-URL fallback walking up from host anchors to the engine package's `node_modules`.

Tier independence needs only host-plane services (`tokenMeter`, `llm`), so the plugin folds in compositions with **no compaction group at all** — validated live on a `minimal`-derived preset and via profile-level install. If the engine package cannot be resolved at all, `task_fold` degrades gracefully: the task still closes, unfolded (the resolution result is cached for the process lifetime). Compatible with dsh 0.1.2-alpha.4's on-demand session APIs (`snapshotEvents()`; older versions' `session.events` still honored).

### State model

- Open tasks are **named derived state**: the `taskMarks` session projection folds harness-native events only — tool-call blocks register pending intents, tool-result text (`Task begun: NAME` / `Task folded: NAME`) pushes/pops by name. Closing is LIFO at the tool layer (only the innermost open task can close; the projection itself stays name-keyed so pre-LIFO logs replay unchanged); a failed `task_fold` changes nothing (atomic end-and-fold).
- Marks survive host restarts, session resume, and compaction (append-only log). Nameless legacy marks self-heal away at projection load.

### Lifecycle nudges (hold semantics)

A clean begin→work→end flow stays completely silent. When the flow is skipped, a nudge line appears and **holds** (renders every round, byte-stable) until its condition clears — the diff-driven snapshot engine means a held line costs nothing while it waits, and clearing produces exactly one retraction. Ages are measured in **model rounds**, never raw event seqs.

| Signal | Holds while | Asks for |
| --- | --- | --- |
| Work without a task | no open task, ≥3 non-task tool calls in the last 10 rounds (3-round grace after a task_fold) | `task_begin({ name })` |
| A task left open | any open mark is 20+ rounds old (the oldest one is named) | `task_fold({ name })` |

A todo bridge additionally reports state transitions: the round right after the model calls `todo_write` (detected statelessly from the event log), a transient line appears — `Todo bridge: todos changed; open tasks: …` — asking the model to keep task marks in sync (`task_begin` for new work, `task_fold` for finished work) and retracting on the next round. It is a status report, not a conditional nag: the decision stays with the model, and the stock `todo_write` tool is never wrapped.

## Install

**Plugin bundle** (any profile; tools available in every session):

```sh
dsh plugin --profile web add github:yindf/taskfold
```

Restart dsh after the install.

## Layout

```
package.json      npm manifest + dsh.bundle.patch declaration
cordis.patch.yml  host-plane bundle patch (plugin install path)
plugins/          compact-region.mjs, compact-stats.mjs
test/             offline suites (node test/*.test.mjs)
CHANGELOG.md      release history
```

## License

MIT. Developed against the DeepSeek Harness (`@deepseek-ai/*`, MIT) public packages.
