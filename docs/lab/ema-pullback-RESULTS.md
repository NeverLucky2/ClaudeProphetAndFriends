# EMA-Pullback Backtest — Results

**Verdict: REJECT** — gate_alpha=false gate_robust=false

This tests a **daily mechanical adaptation** (fleet runs daily). The author's claim spans down to 400-tick; a daily REJECT does **not** debunk the intraday strategy. Prereg hash `83a5ea75`. Decision metric: beta-adjusted residual at 20bps. Expected: REJECT.

## Beta-adjusted holdout alpha (PRIMARY gate)

| benchmark | n | mean | CI lo | CI hi |
|---|---|---|---|---|
| SPY | 3682 | -0.27% | -0.38% | -0.16% |
| QQQ | 3682 | -0.31% | -0.42% | -0.20% |
- train alpha (SPY-hedged) mean: -0.26%

## Author-window decontamination (trailing 24mo, from 2024-06-01)

- holdout FROM 2024-06-01 (author's likely in-sample): SPY -0.21% CI [-0.53%, 0.09%] (n=782); QQQ -0.17% CI [-0.50%, 0.14%]
- holdout EXCLUDING trailing (independent): SPY -0.29% CI [-0.40%, -0.17%] (n=2900)
- A pass concentrated in the trailing window reads as "reproduces the author's own backtest", not independent confirmation.

## Beta-adjusted alpha by year (SPY-hedged; regime visibility)

| year | n | mean |
|---|---|---|
| 2016 | 55 | -0.20% |
| 2017 | 323 | -0.34% |
| 2018 | 462 | -0.38% |
| 2019 | 372 | -0.42% |
| 2020 | 382 | -0.53% |
| 2021 | 400 | -0.29% |
| 2022 | 368 | -0.02% |
| 2023 | 399 | -0.04% |
| 2024 | 368 | -0.17% |
| 2025 | 401 | -0.01% |
| 2026 | 152 | -0.94% |

## Raw net by side (descriptive — NOT the gate)

| side | n | win | mean | avgWin | avgLoss |
|---|---|---|---|---|---|
| long | 2216 | 52.71% | -0.02% | 2.80% | -3.16% |
| short | 1466 | 47.61% | -0.46% | 3.03% | -3.62% |
| all | 3682 | 50.68% | -0.19% | 2.88% | -3.35% |

- distinct entry dates (effective N): 1672
- same-bar both-touched booked-as-loss: 0.03%

## Ballast lens (§6) — deferred

- The downside/conditional-beta ballast lens needs a strategy equity-curve return series the per-trade design does not produce, and only matters on a KEEP-CANDIDATE verdict. Deferred until/unless the strategy clears the alpha gate; revisit with a proper equity-curve build then.

## Limitations

- Signal-day-close fill; large-cap survivorship flatters longs (discount KEEP on that cut); daily bars only (intraday out of scope); CCI proxy ablation-only; train-frozen betas; flat short borrow; no regime sizing.