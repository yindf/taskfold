# taskfold

[English](README.md) | [中文](README.zh.md)

**taskfold — effectively infinite context for your coding agent.**

Keep long AI coding sessions fast, cheap, and readable: finished work is folded into a short summary, and the full original content is always one call away.

For [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) (DSH).

## Why you want it

Long sessions drown in their own history: every request re-sends hours of finished work — old tool outputs, debug logs, abandoned attempts. Costs climb, the model gets distracted, and eventually the context window fills up.

taskfold fixes this the way a good notebook does. While working, the agent wraps each task with `task_begin("fix the login bug")`. When the task is done, `task_fold` closes it **and** replaces the entire back-and-forth with a short titled summary:

```
Before:  [800 messages of raw debugging…]
After:   "fix the login bug" — summary: what was tried, what failed and why,
          what changed, what the user decided. (~1 screen)
```

The conversation stays readable, every request gets cheaper, and the model keeps the *lessons* without dragging the *transcript* along.

**Nothing is lost.** Every fold saves the exact original messages to a file, and `fold_recall({ fold: N })` can regenerate it at any time. Fold first, look later — like closing a book you can reopen.

## How it works (plain words)

- **Named tasks.** The agent opens a task before starting work and closes it when done. Open tasks survive restarts; closing is well-ordered (innermost first), and a failed close never corrupts anything — just retry.
- **Folding = closing + summarizing in one call.** The summary is written once, while the original span is still in context, so it's accurate — not a "summary of a summary".
- **Summaries keep what matters.** The summarizer is instructed to preserve user decisions and feedback (verbatim where wording matters), pitfalls and *why* things failed, what changed, and the outcome.
- **Gentle guardrails.** If the agent forgets the discipline, a one-line reminder appears in its context until it complies — no noise when the flow is healthy.
- **Cheap on the cache.** Folding only rewrites a middle chunk of history; the stable prefix (system prompt, tools, earlier context) stays cache-friendly.

## What it adds

Four agent tools (plus the reminders above):

| Tool | One-liner |
| --- | --- |
| `task_begin({ name })` | Open a named task. |
| `task_fold({ name })` | Close it and fold its whole span into one titled summary. |
| `list_folds` | List all folds (number, size, title). |
| `fold_recall({ fold })` | Bring back any fold's original content on demand. |

## Install

```sh
dsh plugin --profile <your-profile> add github:yindf/taskfold
```

Restart dsh — every session on that profile gets the tools.

## Supported dsh versions

- **Known to work: `0.1.2-alpha.5`** (the version this plugin is developed and tested against; `dsh`, `dsh-compaction-basic`, and `dsh-llm` ship version-locked, so one number covers the whole surface).
- **Minimum: `0.1.2-alpha.5`.** No older version has been tested; older alphas differ in the compaction-engine internals this plugin builds on.
- **Upper bound: untested, not enforced.** dsh does not yet expose host-version negotiation to plugins, so nothing rejects an incompatible host automatically — on an incompatible dsh, folds degrade (tasks still close, unfolded) rather than corrupt. After each dsh upgrade, re-check this section and update it with test results.

## For maintainers

- Layout: `plugins/` (the two plugin files), `scripts/release.mjs`, `test/` (`node test/*.test.mjs`), `CHANGELOG.md`.
- Releasing: `node scripts/release.mjs draft` → review the CHANGELOG entry → `node scripts/release.mjs release` (CHANGELOG is the single source of truth for versions). If this release changes which dsh versions are supported, update the "Supported dsh versions" section in **both** READMEs before releasing — the release script reminds you.
- Design decisions and history live in `CHANGELOG.md` and the design notes in the source repo.

## License

MIT. Developed against the DeepSeek Harness (`@deepseek-ai/*`, MIT) public packages.
