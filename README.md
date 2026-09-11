<p align="center">
  <img src="https://raw.githubusercontent.com/yindf/taskfold/master/assets/banner.png" width="100%" alt="taskfold — effectively infinite context for your coding agent" />
</p>

<p align="center"><b>effectively infinite context for your coding agent</b></p>

<p align="center">
  <a href="README.zh.md">简体中文</a> ·
  <a href="https://github.com/yindf/taskfold/releases/latest">Releases</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

<p align="center">
  <a href="https://github.com/yindf/taskfold/releases/latest"><img src="https://img.shields.io/github/v/release/yindf/taskfold?style=flat-square&color=4c8dff" alt="Latest release"></a>
  <a href="https://www.npmjs.com/package/dsh-taskfold"><img src="https://img.shields.io/npm/v/dsh-taskfold?style=flat-square&color=cb3837" alt="npm"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT license"></a>
  <a href="https://github.com/topics/dsh-plugin"><img src="https://img.shields.io/badge/DeepSeek%20Harness-plugin-4c8dff?style=flat-square" alt="DeepSeek Harness plugin"></a>
</p>

Keep long AI coding sessions fast, cheap, and readable: finished work is folded into a short summary, and the full original content is always one call away.

For [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) (DSH).

## Quickstart

```sh
dsh plugin --profile <your-profile> add dsh-taskfold
```

Published on npm as [`dsh-taskfold`](https://www.npmjs.com/package/dsh-taskfold) — prebuilt, so it skips dsh's `allowBuilds` build approval. Straight from GitHub also works: `add github:yindf/taskfold`.

Restart dsh — every session on that profile gets the tools. The agent then wraps its work in named tasks:

```
task_begin("fix the login bug")   … the work …   task_end("fix the login bug")
```

and that whole span collapses into one titled summary, still readable back with `fold_recall`.

## Why you want it

Long sessions drown in their own history: every request re-sends hours of finished work — old tool outputs, debug logs, abandoned attempts. Costs climb, the model gets distracted, and eventually the context window fills up.

taskfold fixes this the way a good notebook does. While working, the agent wraps each task with `task_begin("fix the login bug")`. When the task is done, `task_end` closes it **and** replaces the entire back-and-forth with a short titled summary:

```
Before:  [800 messages of raw debugging…]
After:   "fix the login bug" — summary: what was tried, what failed and why,
          what changed, what the user decided. (~1 screen)
```

The conversation stays readable, every request gets cheaper, and the model keeps the *lessons* without dragging the *transcript* along.

**Nothing is lost.** Every fold saves the exact original messages to a file, and `fold_recall({ fold: N })` can regenerate it at any time. Fold first, look later — like closing a book you can reopen.

## How it relates to dsh's built-in compaction

Same goal, different moment — and they compose.

- **dsh's built-in compaction is automatic and pressure-driven.** It fires when the window is nearly full, picks a range by token pressure, and replaces it with a summary; the original events stay in the session log, shadowed rather than deleted.
- **taskfold is explicit and task-scoped.** You fold each finished task as you go, so the summary is written while its span is still in context — accurate by construction — and it is titled, so the session stays navigable.
- **Because you fold early, the window rarely fills.** In the measured session below the peak was 20.7% instead of 59.5%, so pressure compaction fires later, or not at all — and when it does fire, there is less left to summarize.
- **Every fold is addressable.** `fold_recall({ fold: N })` returns the exact original messages, not a re-summary.

## How it works (plain words)

- **Named tasks.** The agent opens a task before starting work and closes it when done. Open tasks survive restarts; closing is well-ordered (innermost first), and a failed close never corrupts anything — just retry.
- **Folding = closing + summarizing in one call.** The summary is written once, while the original span is still in context, so it's accurate — not a "summary of a summary".
- **Summaries keep what matters.** The summarizer is instructed to preserve user decisions and feedback (verbatim where wording matters), pitfalls and *why* things failed, what changed, and the outcome.
- **Gentle guardrails.** If the agent forgets the discipline, a short hint appears in its context. Hints are events, not state: one is published only when the condition appears or its wording changes, nothing is published once the condition clears (the model already complied and does not need to be told), and there is no wrapper, supersession header, or expiry notice — no noise when the flow is healthy.
- **Cheap on the cache.** Folding only rewrites a middle chunk of history; the stable prefix (system prompt, tools, earlier context) stays cache-friendly.

## What it saves (measured)

One real session — 411 model steps, 26 folds — read from the harness's own usage records:

| | Without folding | With taskfold |
| --- | --- | --- |
| Total prompt tokens | 142,654,308 | 52,127,098 (**−63.5%**) |
| Largest single request | 594,909 | 206,896 (−65%) |
| Context window used at peak | 59.5% | 20.7% |

The mechanism: folding moved **441,100 tokens** of finished work off the surface. Because that history would otherwise be re-sent on every later request, it added up to **90,527,210 tokens never sent**. Producing the 26 summaries cost 3,550,270 tokens (3.9% of the saving, and most of it cache reads); the biggest single fold took 40,422 tokens out of the conversation in one call.

Most of those tokens would have been cache *reads* rather than fresh input — cheaper, but still billed and still occupying the window. In longer sessions that is the difference between staying inside the context window and not.

One session, one task shape — your numbers will differ. The mechanism is the point: finished work leaves the surface, the stable prefix stays cached, and the model keeps the lessons instead of the transcript.

## What it adds

Four agent tools (plus the reminders above):

| Tool | One-liner |
| --- | --- |
| `task_begin({ name })` | Open a named task. |
| `task_end({ name })` | Close it and fold its whole span into one titled summary. |
| `list_folds` | List all folds (number, size, title). |
| `fold_recall({ fold })` | Bring back any fold's original content on demand. |

In the Web GUI, the current open-task stack also shows as a live dock above the composer (like the todo panel): outermost first, the innermost task highlighted, with the closing/pending counts — read straight from the session's `taskMarks` projection, no extra events.

<img src="https://raw.githubusercontent.com/yindf/taskfold/master/assets/screenshot-tasks.png" width="100%" alt="the live task stack, docked above the composer: nested open tasks with the innermost highlighted, and one folding row per task that has already ended">

<img src="https://raw.githubusercontent.com/yindf/taskfold/master/assets/screenshot-tasks-collapsed.png" width="100%" alt="the same stack collapsed to one line, next to the task-stack line the lifecycle hint hands to the model">

## Other ways to install

Every release attaches a prebuilt `dsh-taskfold-<version>.tgz`. Plugin storefronts offer that asset — or the npm package — instead of the build-from-source command, which also skips dsh's `allowBuilds` approval step — see the [latest release](https://github.com/yindf/taskfold/releases/latest).

## Supported dsh versions

- **alpha channel — supported through `0.1.5-alpha.2`** (verified 2026-09-10: the offline suite — 117 tests, all green; a host-API probe against the real `dsh-compaction-basic`/`dsh-llm`/`dsh-session` packages — engine class export, the `summarize` hook, `BlockAssembler`, the session surface/`deriveEventMessage` API, and `ScopedEngine` construction through the plugin's own shim context; an end-to-end fold through the real engine and assembler — prefix-anchored envelope, fenced span index with true line numbers, span bytes untouched, archive footer; a seam audit of 25 runtime assertions confirming `agent/pre-step`, `agent/turn-stopping`, `sessionProjections.register`/`stateOf`, `systemPrompt.section`/`context`, `tools.register`, and the `dsh-compaction-basic` compaction discriminator all keep their shapes; and live folding on the running 0.1.5-alpha.2 host, where the mounted plugin copy is byte-identical to this repo's HEAD blobs. No code change was needed. The host-side API drift found in the previous round persists: `dsh-session` still does not export `decodeStorageRecord`/`packChunkRuns`, which this plugin never uses — it imports only `dsh-compaction-basic` and `dsh-llm` — so the offline region-transaction replay that relied on them stays out of the verification chain; the live fold covers that path instead).
- **rc channel — supported through `0.1.5-rc.2`** (verified 2026-09-11 on 0.34.1: the offline suite — 162 tests, all green; a byte-level seam audit of all 240 first-party `@deepseek-ai` packages between `0.1.5-rc.1` and `0.1.5-rc.2` — 231 differ only in their `package.json` version fields, 7 change implementation files (the message-feedback group: `dsh-client-ui-message-feedback`, `dsh-message-feedback`, `dsh-command-feedback`, `dsh-client-ui-chat`, `dsh-client-ui-deliverables`, `dsh-client-ui-sidebar`, plus the `dsh-web-frontend` shell), no package is added or removed, and the two this plugin imports — `dsh-compaction-basic` and `dsh-llm` — are byte-identical in implementation; a host-API probe against the real rc.2 packages — engine class export, its `summarize` prototype, subclassing, and `BlockAssembler` with `push`/`blocks`; a client-contract sweep across both builds — `conversation.input.dock`, `useProjection`, `__ModuleLoader__`, and `slots.inject` all identical, with the dock's owner `dsh-client-ui-conversation`, the reference consumer `dsh-client-ui-goal`, and the bundle registry `dsh-client-modules` byte-identical; and live folding on the running 0.1.5-rc.2 host, where the mounted plugin copy is byte-identical to this repo's v0.34.0 tag blobs — 1/1 fold passes `verify-cache --since-restart` (98.6% prefix-cache hit). No code change was needed; the record it supersedes — `0.1.5-rc.1` — stood as written). `dsh`, `dsh-compaction-basic`, and `dsh-llm` ship version-locked, so one number covers the whole surface.
- **Upper bound: untested, not enforced.** dsh does not yet expose host-version negotiation to plugins, so nothing rejects an incompatible host automatically — on an incompatible dsh, folds degrade (tasks still close, unfolded) rather than corrupt. After each dsh upgrade, re-check this section and update it with test results.
- **Optional hook: `agent/turn-stopping`** — since 0.26.0 the archive drain also runs at turn end, folding turn-final deliverables while the provider prefix cache is still hot. Hosts without the hook simply keep the previous pre-step-only semantics (folds still happen, one turn later); the registration is wrapped so its absence never breaks `apply()`.

## For maintainers

- Layout: `plugins/` (the two mounted rows `compact-region.mjs` and `compact-stats.mjs`, plus the shared plain modules they import — `events.mjs`, `task-marks.mjs`, `fold-instruction.mjs`, `fold-engine.mjs`, `fold-drain.mjs`, `lifecycle-nudges.mjs`, `lifecycle-injection.mjs`, `span-preview.mjs`, plus the browser half: `task-stack-ui.mjs` — the dock's source of truth, generated into `taskfold-client.mjs` by `scripts/build-client.mjs`), `scripts/release.mjs`, `scripts/verify-cache.mjs` and `scripts/build-client.mjs`, `test/` (`npm test`), `assets/` (README banner, the social-preview image to upload in repo settings, and the store screenshots listed in `screenshots.json`), `docs/` (`docs/README.md` index plus the `docs/design/` notes and `docs/adr/` decisions — deliberately kept out of the npm package), `CHANGELOG.md`.
- Releasing: `node scripts/release.mjs draft` → review the CHANGELOG entry → `node scripts/release.mjs release` (CHANGELOG is the single source of truth for versions). If this release changes which dsh versions are supported, update the "Supported dsh versions" section in **both** READMEs before releasing — the release script reminds you. Keep that section to **one line per channel**: the newest verified `alpha`, then the newest verified `rc`; delete historical alpha/rc entries instead of listing them.
- **Fold cache verification is part of the flow.** After every dsh upgrade — and before any release that touches the fold envelope — run `node scripts/verify-cache.mjs --since-restart` against a live session log, and record the numbers in the CHANGELOG entry. It exits non-zero when a fold's summarizer call re-pays its span — the test is `uncached − span > --tail-budget`, i.e. a positive tail, which is the signature of the prefix envelope no longer matching the host's summarization input. The offline suite pins the structural precondition (one system message, strict prefix); only a live log can show the actual cache read.
- Design decisions and history live in `CHANGELOG.md` and in `docs/` (`docs/README.md` is the index; the `docs/design/` notes and `docs/adr/` decisions ship with the repo, not with the npm package).

## If this saves you tokens

A star helps other dsh users find it — in this ecosystem, that is how a plugin gets discovered. Numbers from your own sessions are welcome in [Discussions](https://github.com/yindf/taskfold/discussions).

## License

MIT. Developed against the DeepSeek Harness (`@deepseek-ai/*`, MIT) public packages.
