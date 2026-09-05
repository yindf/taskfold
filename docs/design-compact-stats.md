# Design: fold observability — `list_folds` / `fold_recall`

Status: shipped. This note records the design AS BUILT (0.22.x) and replaces
the original `compact_stats` draft, which described a single `compact_stats`
tool with an `unknownEventTypes` output field — that field was dropped in
review (see Degradation policy) and the tool shipped as two.

## Goal & success criteria

The preset can compress the surface but cannot answer "what did compaction do
for me?" Two read-only model tools answer it for the CURRENT session:

- `list_folds` — current surface length (live nodes) and total event count;
  every fold committed this session: chronological fold number, position seq
  of the summary node, estimated shadowed tokens, title or summary preview;
  totals (folds, cumulative shadowed tokens).
- `fold_recall` — regenerate (or single out, via the `line` overload) the
  ORIGINAL content of any folded span on demand.

Success = calling `list_folds` right after a fold commits reports that fold
with matching numbers; calling it on a fresh session reports zeros, not an
error; `fold_recall({ fold: N })` round-trips the exact original messages.

## Non-goals

- No writes, no state, no new services; neither tool ever triggers
  compaction. (`fold_recall` writes ONE diagnostic JSONL artifact file —
  session-local or OS-tmp fallback — and nothing else.)
- No cross-session aggregation (per-session only, like the rest of the
  bundle).

## Modules & files

| Module | File | Role |
| --- | --- | --- |
| Tool plugin | `plugins/compact-stats.mjs` | Ships both tools. Plain Cordis plugin, `inject: ['tools']` only. |
| Shared helpers | `plugins/span-preview.mjs`, `plugins/events.mjs` | Preview rendering + artifact writing; cross-version event-log access. Plain modules, not bundle rows. |
| Mount | `cordis.patch.yml` | Host-plane rows (`cmpct-stats`; sibling `cmpct-region`). |
| Tests | `test/compact-stats.test.mjs` | Offline fixtures; no harness needed (`npm test`). |

## Interface contract

`list_folds`, parameters `{}`. Machine shape returned by `execute`, rendered
to text by `output.render`:

```jsonc
{
  "ok": true,
  "surfaceLength": 42,        // session.surface.nodes.length
  "eventCount": 137,          // sessionEvents(session).length (live log)
  "folds": [                  // oldest → newest; index+1 IS the fold number
    { "seq": 113, "shadowedTokenCount": 2845, "preview": "- investigated…",
      "title": "fix the login bug" /* …range/provider/model when present */ }
  ],
  "totals": { "folds": 1, "shadowedTokens": 2845 }
}
```

`fold_recall`, parameters `{ fold, line? }`. Without `line`: writes the
span's messages (role + content blocks, provenance stripped) as JSONL into
the session's own artifact directory and returns the file path plus the
complete span preview. With `line`: returns ONLY that 1-based message, no
file written — line numbers match the span preview and the artifact.

Failure mode: only `agent` context missing or unreadable session →
`{ ok: false, error }`; an empty history is NOT an error (zeros).

## Fold numbering

Chronological, 1-based, derived from event order: the number `list_folds`
prints is exactly the number `fold_recall({ fold: N })` validates and exactly
what the fold archive section counts. The event-log seq is a secondary
annotation only — never pass it to `fold_recall`. Titles come from the
in-flight `task_fold` call's arguments (inline folds, temporal correlation)
or, for deferred folds that commit at a later step boundary, from the
summary's own forced `# <name>` heading.

## Degradation policy (distinguishable, never silent)

Fold accounting keys on the single native `compaction/summary` event type
only — no exhaustive known-type list. The draft's `unknownEventTypes`
enumeration coupled the plugin to every harness event type and drifted on
every upgrade, so it was removed deliberately: unknown event types are simply
invisible to fold accounting, and "no folds" stays distinguishable from
"errors" because malformed fold events degrade field-by-field (missing token
count → 0 plus a `shadowedTokenCountMissing` flag rendered in the list)
rather than throwing.

## Data source

Authoritative source: the LIVE event log via the cross-version
`sessionEvents()` accessor (`session.events` array on dsh ≤0.1.2-alpha.3,
`session.snapshotEvents()` after). Events survive folds — the surface is a
projection — so history needs no disk reads and no second internal contract
with the persistence layer's file layout. Resume semantics: stats derive from
whatever event log the session currently holds; if persistence dropped
events, stats drop with them (no reconciliation against disk).

## Dependency direction

`compact-stats.mjs` → `ctx.tools` (registration only) + `exec.agent.session`
(runtime argument of execute). It does NOT inject `compaction`, and shares no
state with compact-region — the two mounted plugins stay independently
removable; the pure helpers they both use (span-preview.mjs, events.mjs) are
plain modules that add no bundle rows. Test modules import the pure helpers
via named exports (the default export remains the Cordis plugin).

## Edge cases

- Nested folds (a summary node later compacted itself): every committed
  fold event still counts, even if its node is no longer on the surface.
- Very large event lists: single linear pass per collect, no nested scans
  (O(n)).
- `shadowedTokenCount` missing on old events → counted as 0, flagged in the
  rendered line.
