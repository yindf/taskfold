# Design: `compact_stats` — session compaction observability tool

Status: draft (awaiting adversarial review + user approval)

## Goal & success criteria

The preset can compress the surface but cannot answer "what did compaction do for me?"
`compact_stats` is a read-only model tool that reports, for the CURRENT session:

- current surface length (live nodes) and total event count;
- every fold committed this session: position seq of the summary node, estimated
  shadowed tokens, and a short preview of its summary;
- totals: folds count, cumulative shadowed tokens.

Success = calling it right after a `compact`/`task_end` reports that fold with
matching numbers; calling it on a fresh session reports zeros, not an error.

## Non-goals

- No writes, no state, no new services; the tool never triggers compaction.
- No cross-session aggregation (per-session only, like the rest of the preset).

## Modules & files

| Module | File | Change |
| --- | --- | --- |
| Tool plugin | `plugins/compact-stats.mjs` | NEW. Plain Cordis plugin, `inject: ['tools']` only. |
| Composition row | `agent.cordis.yml` | NEW row inside the existing `compaction` realm. The tool has no service dependency; the realm is purely a placement convention (tools registered from realm rows reach the agent's catalog, as compact-region's do), and the row would work unchanged at any layer. |
| Docs | `README.md` | Tool table + collision list += `compact_stats`. |
| Tests | `test/compact-stats.test.mjs` | NEW. Offline fixture test; no harness needed. |

## Interface contract

Tool `compact_stats`, parameters `{}` (nothing). Result (rendered to text by
`output.render`, machine shape returned by `execute`):

```jsonc
{
  "ok": true,
  "surfaceLength": 42,        // session.surface.nodes.length
  "eventCount": 137,          // session.events.length (live event log)
  "folds": [                  // oldest → newest
    { "seq": 113, "shadowedTokenCount": 2845, "preview": "## Primary Request..." }
  ],
  "totals": { "folds": 1, "shadowedTokens": 2845 },
  "unknownEventTypes": []     // see degradation policy below
}
```

Preview limit: 60 chars, aligned with compact-region's `PREVIEW_LIMIT`.

Failure mode: only `agent` context missing or unreadable session →
`{ ok: false, error }`; an empty history is NOT an error (zeros).

## Degradation policy (distinguishable, never silent)

The fold event shape is an internal contract of `dsh-compaction-basic`. If the
event stream contains types outside the known set (enumerated beside the
predicate), `unknownEventTypes` lists them and the rendered output carries a
warning: fold accounting may be incomplete. "No folds" and "could not look for
folds" are therefore distinguishable. Silence is never used as a fallback.

## Data source & discovery plan

Authoritative source: the LIVE session event log, `exec.agent.session.events` —
the same source compact-region's `readSurface` already indexes. Events survive
folds (the surface is a projection), so history needs no disk reads and no
second internal contract with dsh-session-persistence's file layout; memory is
the authority (the "persistence" error class exists precisely because disk
checkpoints may lag).

Fold-shape discovery: read the `dsh-compaction-basic` source in the DSH
installation to pin the exact commit event type/fields for THIS version; the
predicate encodes that shape with the observed fields documented beside it.

Resume semantics: stats derive from whatever event log the session currently
holds. After a host restart + resume, counts include exactly the events the
session reloaded — if persistence dropped events, stats drop with them (no
attempt to reconcile against disk).

## Dependency direction

`compact-stats.mjs` → `ctx.tools` (registration only) + `exec.agent.session`
(runtime argument of execute). It does NOT inject `compaction`, does not read
`markers`, and shares no state with compact-region — the two plugins stay
independently removable. Test module imports the predicate/parsing helpers from
the plugin file via named exports (the default export remains the Cordis
plugin; named exports are pure functions).

## Implementation order

1. Probe: read `dsh-compaction-basic` source in the DSH installation; pin the
   fold/commit event type and fields (plus the known-benign event-type set).
2. `plugins/compact-stats.mjs`: pure helpers (fold detection + preview) as named
   exports; tool object; `ctx.tools.register`.
3. `agent.cordis.yml` row + README.
4. `test/compact-stats.test.mjs`: fixture events (real shapes from step 1) →
   assert detection, totals, empty-history zeros, unknown-type warning; `node --test`.
5. Live verification deferred until next host restart (preset rows mount at
   process start); offline tests + syntax gate the merge.

## Edge cases

- Session with folds whose summary nodes were themselves compacted later
  (nested folds): every committed fold event still counts, even if its node is
  no longer on the surface.
- Very large event lists: single linear pass, no nested scans (O(n)).
- `shadowedTokenCount` missing on old events → counted as 0, flagged in preview.
