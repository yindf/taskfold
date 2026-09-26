<p align="center">
  <img src="https://raw.githubusercontent.com/yindf/taskfold/alpha/assets/banner.png" width="100%" alt="taskfold — effectively infinite context for your coding agent" />
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

> **Latest supported dsh: `0.1.7-alpha.2`.** dsh alpha builds are supported on this branch; dsh rc builds are supported on the [`master` branch](https://github.com/yindf/taskfold/blob/master/README.md#supported-dsh-versions).

## Quickstart

Pick the install line that matches your dsh build's channel — each command fetches the newest release verified on that channel (see [Supported dsh versions](#supported-dsh-versions)):

```sh
# alpha channel — the default branch (alpha)
dsh plugin --profile web add "github:yindf/taskfold#alpha"

# rc channel — the master branch (keep the quotes: # starts a comment in sh)
dsh plugin --profile web add "github:yindf/taskfold#master"
```

Both lines are copy-paste ready: `web` is the profile the DSH Web GUI runs on — swap in your own profile name if you use a different one.

Each branch's README carries its own "Supported dsh versions" record — the alpha channel's current record lives on the [alpha branch](https://github.com/yindf/taskfold/blob/alpha/README.md#supported-dsh-versions).

Also on npm as [`dsh-taskfold`](https://www.npmjs.com/package/dsh-taskfold) — prebuilt, so it skips dsh's `allowBuilds` build approval — though the npm copy can lag behind the channel branches.

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

<img src="https://raw.githubusercontent.com/yindf/taskfold/alpha/assets/screenshot-tasks.png" width="100%" alt="the live task stack, docked above the composer: nested open tasks with the innermost highlighted, and one folding row per task that has already ended">

<img src="https://raw.githubusercontent.com/yindf/taskfold/alpha/assets/screenshot-tasks-collapsed.png" width="100%" alt="the same stack collapsed to one line, next to the task-stack line the lifecycle hint hands to the model">

## Other ways to install

Every release attaches a prebuilt `dsh-taskfold-<version>.tgz`. Plugin storefronts offer that asset — or the npm package — instead of the build-from-source command, which also skips dsh's `allowBuilds` approval step — see the [latest release](https://github.com/yindf/taskfold/releases/latest).

## Supported dsh versions

- **alpha channel — supported through `0.1.7-alpha.2`** (verified 2026-09-23 on 0.34.7, no code change needed: the offline suite — 194 tests, all green; a host-API probe against the real `dsh-compaction-basic`/`dsh-llm` packages — 12/12, the same pinned seams; a byte-level seam diff alpha.1→alpha.2 across all nine packages — eight are version-only bumps, the only implementation change sits in `dsh-tools` (an additive optional `projectContent` hook on tool definitions), which the plugin never imports: its entire dynamic host-import surface is `dsh-compaction-basic` + `dsh-llm`, both byte-identical this round; `SESSION_FORMAT_VERSION` stays 4 with no new migration edge, so v4 remains the only live grammar; and a live fold on a real 0.1.7-alpha.2 session — the tfverify headless twin rerun against the upgraded host — where a full task cycle (begin → parallel reads → end → text-only report) folded at turn end in 22.1 s and passed `verify-cache`: 87.8% prefix-cache hit, tail +488. The upgraded GUI host itself opened and closed this round's task marks correctly on first try. The 0.1.7-alpha.1 breakage story (session format v4 flattening) lives in CHANGELOG 0.34.7.)
- **rc channel — use the `#master` install** (`dsh plugin --profile web add "github:yindf/taskfold#master"`, the master branch); the rc build's supported-version record lives in [master's README](https://github.com/yindf/taskfold/blob/master/README.md#supported-dsh-versions).
- **Bounds: enforced floor, untested ceiling.** Since this release the plugin declares its host surface in `peerDependencies` (`@deepseek-ai/dsh`, `@deepseek-ai/dsh-compaction-basic`, `@deepseek-ai/dsh-llm`, all `^0.1.7-alpha.2`): dsh 0.1.7 hosts check those ranges at install and at startup/recomposition, so an incompatible host now gets the bundle skipped with an `incompatible-version` verdict instead of loading it. Hosts older than the check itself negotiate nothing — on those, folds degrade (tasks still close, unfolded) rather than corrupt. After each dsh upgrade, re-check this section and update it with test results.
- **Optional hook: `agent/turn-stopping`** — since 0.26.0 the archive drain also runs at turn end, folding turn-final deliverables while the provider prefix cache is still hot. Hosts without the hook simply keep the previous pre-step-only semantics (folds still happen, one turn later); the registration is wrapped so its absence never breaks `apply()`.

## For maintainers

- Layout: `plugins/` (the two mounted rows `compact-region.mjs` and `compact-stats.mjs`, plus the shared plain modules they import — `events.mjs`, `task-marks.mjs`, `fold-instruction.mjs`, `fold-engine.mjs`, `fold-drain.mjs`, `lifecycle-nudges.mjs`, `lifecycle-injection.mjs`, `span-preview.mjs`, plus the browser half: `task-stack-ui.mjs` — the dock's source of truth, generated into `taskfold-client.mjs` by `scripts/build-client.mjs`), `scripts/release.mjs`, `scripts/verify-cache.mjs` and `scripts/build-client.mjs`, `test/` (`npm test`), `assets/` (README banner, the social-preview image to upload in repo settings, and the store screenshots listed in `screenshots.json`), `docs/` (`docs/README.md` index plus the `docs/design/` notes and `docs/adr/` decisions — deliberately kept out of the npm package), `CHANGELOG.md`.
- Releasing: `node scripts/release.mjs draft` → review the CHANGELOG entry → `node scripts/release.mjs release` (CHANGELOG is the single source of truth for versions). **Channel branches** (since 0.34.6): `master` carries only rc-channel releases — it stays at the newest verified-rc version; alpha-channel releases happen on the `alpha` branch, whose commits and tags carry the alpha-verified work (run draft/release ON the `alpha` branch; the script pushes the current branch and the tag). If this release changes which dsh versions are supported, update the "Supported dsh versions" section in **both** READMEs (README.md + README.zh.md) before releasing — the release script reminds you. Each branch records **only its own build's** verification: one entry for its home channel with the newest verified version (delete superseded entries), and for the other channel a **link** to the other branch's README — never a copied version number.
- **Fold cache verification is part of the flow.** After every dsh upgrade — and before any release that touches the fold envelope — run `node scripts/verify-cache.mjs --since-restart` against a live session log, and record the numbers in the CHANGELOG entry. It exits non-zero when a fold's summarizer call re-pays its span — the test is `uncached − span > --tail-budget`, i.e. a positive tail, which is the signature of the prefix envelope no longer matching the host's summarization input. The offline suite pins the structural precondition (one system message, strict prefix); only a live log can show the actual cache read. When the running host cannot hot-reload the mounted plugin (the 0.1.7 round's GUI host could not), a one-shot headless twin of the web profile provides the live fold — the recipe (profile layout, prompt shape) is in the 0.34.7 CHANGELOG entry.
- Design decisions and history live in `CHANGELOG.md` and in `docs/` (`docs/README.md` is the index; the `docs/design/` notes and `docs/adr/` decisions ship with the repo, not with the npm package).

## If this saves you tokens

A star helps other dsh users find it — in this ecosystem, that is how a plugin gets discovered. Numbers from your own sessions are welcome in [Discussions](https://github.com/yindf/taskfold/discussions).

## License

MIT. Developed against the DeepSeek Harness (`@deepseek-ai/*`, MIT) public packages.
