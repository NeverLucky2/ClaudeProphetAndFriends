# News→Direction Prediction Program — Summary & Closeout

**Concluded:** 2026-05-31 — **STOPPED** after a deliberate effort-vs-yield call.
**One-line result:** No news-based signal cleared the bar for a large, options-viable directional edge; the per-category follow-on was shown *testable* but its expected yield (mostly arbitraged signals, needing forward confirmation to act) did not justify continuing.

This program ran as a chain of pre-registered, cheap-to-kill experiments. Each stage's job was to honestly refute, not to manufacture a positive. It worked: every stage either FAILed cleanly or stopped on an honest cost/value judgment.

## The arc

| Stage | Question | Outcome | Artifacts |
|---|---|---|---|
| **Stage 1** | Does a catalyst-triggered, sentiment+price-state signal predict 3-day direction on the underlying, by enough to matter (HR₀=0.55)? | **FAIL → STOP.** Holdout HR=58.4% but not distinguishable from the options-viable null (binomial p=0.114; clustering-robust bootstrap p5=0.515<0.55). Options (Stage 2) never built. | `docs/lab/stage1-RESULTS.md`; spec/plan `…2026-05-31-directional-signal-stage1*` |
| **SP1** | Of ~25 news *categories*, which have enough events to be testable at power? | **Qualified GO** (refuted the prediction it'd just restate Stage 1). ~8 testable incl. novel ones (analyst×3, legal, antitrust, product, restructuring); `tariff` dropped (macro-inflated, 1 headline → 36/57 tickers); guidance/earnings_miss too rare. | `docs/lab/category-frequencies-RESULTS.md` |
| **SP2** | Do those categories actually predict direction (pre-registered direction per category, untouched 2016–2021)? | **DESIGNED, then STOPPED.** Low expected yield: 4/6 gated categories are arbitraged analyst signals; even a PASS needs forward confirmation to act. | spec `…2026-05-31-news-category-directional-test-design.md` (not implemented; carries required corrections) |

## Why it stopped (honest accounting)
- Stage 1 already showed no large directional edge in the news+state signal.
- The per-category version's testable winners are dominated by **analyst actions** — among the most arbitraged relationships in markets (expected to be priced).
- The genuinely novel, less-arbitraged categories (`legal_action`, `antitrust`) were the only real upside, and even a PASS on pre-2022 data would be "true then," not "tradeable now" — requiring a separate forward-confirmation study before any action.
- Net: continuing was a growing data-engineering cost against a low-probability, non-actionable-without-more-work payoff. Stop is the higher-EV choice.

## Methodological lessons worth keeping (reusable tooling shipped to `main`)
- **Pre-registration that bites:** hash-locked artifact + a scorer that *refuses* to run the holdout on mismatch (`stage1-prereg.mjs` / `stage1-score.mjs`). Froze before scoring; scored once.
- **Cheap feasibility gates first:** count n before building the powered test (Stage 1 feasibility; SP1). Killed dead ends for the price of an API probe.
- **Selecting-on-the-outcome is the cardinal sin:** measure hit rate over the *full unconditional firing base*, never "find the news near the big moves."
- **Cluster-initiation dedup is a validity fix, not cosmetic:** follow-up coverage post-dates the move it would "predict."
- **Multiple comparisons need fixed-K Bonferroni** (committed outcome-blind), not iterate-to-fixed-point.
- **Survivorship bias is direction-asymmetric** (the SP2 catch): today's-winners universe inflates up-bets and deflates down-bets → market-adjust returns; "a FAIL is strong" is not uniformly true.
- **Data-source reality:** FMP starter has no historical news; Alpaca/Benzinga news (free, ~2015+) replaced it and made the whole pipeline FMP-free.

## Reusable assets on `main` (independent of the verdict)
Node scoring stack (`binomial-stats`, `stage1-bootstrap`, `stage1-prereg`, `stage1-score`), bar helpers + lookahead-guarded forward returns, the orchestrator, Alpaca historical news fetch + IEX bar backfill, the hardened catalyst trigger + multi-label news categorizer (`scripts/stage1_*`, `scripts/sp2`-spec-only). Evidence preserved under `data/lab/` (force-committed).

## If ever revisited
Apply the corrections box in the SP2 spec first (market-adjusted returns, K=6, aligned bootstrap, regime flag, mandatory forward confirmation). And prefer a **forward** out-of-sample window over the pre-burned 2016–2021 — the real protection was never the "untouched" window; it was theory-driven directions + outcome-blind selection + forward confirmation.
