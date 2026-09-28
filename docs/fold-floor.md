# The fold floor: why tokens, why 2000

The Settings-page field `minSpanTokens` decides which closed tasks fold and
which close unfolded. This document records the measurement behind the
default value (2000 tokens) so the number can be audited and revisited
instead of taken on faith.

## Why a floor at all

A fold is a trade, not a free win. One summarization call is billed per
fold:

- **cost (input):** the whole span's content is sent to the model;
- **cost (output):** the summary itself, which has a *fixed* overhead —
  title, sections, the Fold archive footer — that does not shrink with the
  span;
- **gain:** the span minus the summary is no longer re-sent on every
  subsequent call of the session.

For large spans the trade is wildly profitable (measured compression
1–8%). For small spans the fixed overhead eats the gain: folding a
500-token span once produced a 499-token summary — a 95% "compression"
that paid a full call to save nothing. The floor exists to settle those
spans **before any call is billed**.

## Why tokens, not node counts

A call's cost scales with the span's token mass, not with how many
messages carry it (one tool result can outweigh twenty short turns).
Node counts therefore measure the wrong thing. The pre-call count is a
CJK-aware character heuristic (see `plugins/fold-settings.mjs`; the
round constants 0.75 tokens per CJK char and 4 chars per token already
EMBED the calibration below — no further coefficient is applied); the
engine's post-hoc `shadowedTokenCount` remains the exact figure in fold
bookkeeping.

## The data

Full-population measurement over the two weeks of session logs on this
machine (engine-reported `shadowedTokenCount` for every committed fold;
summary sizes from the committed summary text; the heuristic tracked the
measured spans at a ratio of 0.9293, i.e. estimates read ~7% low):

| Group                        | Folds | Shadowed tokens | Mean span | Median span | Mean summary | Compression |
| ---------------------------- | ----: | ---------------: | --------: | ----------: | -----------: | ----------: |
| dsh-exp workspaces           |    87 |       2,110,450 |    24,258 |      18,300 |       ~1,400 |        ~5%  |
| CSharpMCP                    |    41 |       1,238,900 |    30,217 |      24,500 |       ~1,600 |        ~4%  |
| img2ui / MasterGoUI / up …   |    38 |         851,300 |    22,403 |      15,900 |       ~1,300 |        ~5%  |
| remaining scattered sessions |    28 |         532,040 |    19,001 |      12,400 |       ~1,250 |        ~6%  |
| **total**                    | **194** | **4,732,690** | **24,395** | **17,600** | **~1,400** | **~5.6%**  |

Distribution shape:

- **Large folds (> 10k tokens):** compression steady at **1–8%**,
  summaries 800–2,000 tokens. Unambiguously worth it.
- **Small folds (< 2k tokens):** the summary's fixed overhead
  (**~500–1,400 tokens**) dominates; worst measured sample 525 → 499
  (95%).

## The break-even arithmetic

With `f` = the summary's fixed overhead (~800 tokens, conservative),
`r` = the output/input price ratio (~3 for current provider pricing),
and `c` = the variable compression rate (~5% observed):

```
break-even span ≈ f × (1 + r·c) / (1 − c) ≈ 800 × 1.15 / 0.95 ≈ 970 tokens
```

The 2000 default keeps roughly **2× margin** over that break-even point —
headroom for the estimator's error, unusually verbose summaries, and the
fact that small spans are more common near the floor than the two-week
sample suggests. A conservative deployment can use 3000; anything above
~5000 starts forgoing folds that are measurably profitable.

## Revisiting the number

The floor is live-editable on the Plugins page and lowering it reopens
already-settled spans, so tuning costs nothing. If the summary template
shrinks (smaller `f`) or pricing moves (`r`), re-derive from the formula
above — the constant lives in `DEFAULT_MIN_SPAN_TOKENS`
(`plugins/fold-settings.mjs`).
