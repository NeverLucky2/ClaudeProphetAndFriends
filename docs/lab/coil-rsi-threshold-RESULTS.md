# Coil RSI-Threshold Backtest — Results

**Verdict: KEEP** — gate1=false gate2=false

Primary T=8; friction 20bps (representative); prereg hash `00e1280e`. Expected: KEEP.

## Per-bucket net edge (holdout)

| bucket | n | win | meanNet | PF |
|---|---|---|---|---|
| [0,5) | 242 | 66.53% | 0.59% | 1.56 |
| [5,8) | 353 | 60.91% | 0.02% | 1.01 |
| [8,10) | 367 | 67.30% | 0.29% | 1.31 |
| [10,15) | 1037 | 62.49% | -0.01% | 0.99 |

## Train kill-gate (shallow − [0,5) diff-CI)

- [5,8): mean 0.03% CI [-0.43%, 0.51%]
- [8,10): mean 0.05% CI [-0.44%, 0.53%]
- [10,15): mean 0.12% CI [-0.40%, 0.62%]
- killed: false

## Phase-2 portfolio (holdout)

- T=5 baseline: net 5.72%, maxDD -2.60%, trades 214
- T=8: net 3.74%, maxDD -4.73%, trades 387
- marginal fills (T=8 vs 5): n=220, net CI [-0.65%, 0.25%] (mean -0.19%)

### Secondary thresholds (exploratory only — not decision-gating)

- T=10: net 7.42%, maxDD -5.42%, trades 485
- T=15: net 7.81%, maxDD -2.81%, trades 611

## Cap-binding (Phase-1 UPPER BOUND)

- fraction of dates with <4 sub-5 names: 98.85% — UPPER BOUND — ignores prior-day open slots; realized count is the Phase-2 fill log

## Limitations

- Survivorship (today's universe; conservative re: false CONSIDER). Daily-close fills. Regime sizing held normal. Earnings = forward 5-trading-bar FMP filter.