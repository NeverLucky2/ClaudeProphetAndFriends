# Coil Exit-Timeout Backtest — Results

**Verdict: KEEP** — no per-trade edge (gate1a CI not > 0)

Primary maxHold=7; friction 20bps; prereg hash `4b1a6f8e`. Expected: KEEP.

## Paired marginal edge (holdout, primary T=7)

- n_paired=120, n_delta@7=120
- Δ mean 0.15%, CI [-0.22%, 0.52%] (gate1a false)
- winsorized-upside Δ CI [-0.25%, 0.42%] (gate1b false)

### Tail decomposition (the operator number)

- bounce: n=63, sum 89.49%
- meander: n=49, sum -43.88%
- **stop-conversion: n=8, drag -27.78%**

## Phase-2 portfolio (holdout)

- maxHold=5: net 2.69%, maxDD -5.58%, trades 395
- maxHold=7: net 3.10%, maxDD -5.32%, trades 371 (gate2 true)
- blocked-by-extension (filled@5, lost@7): 41 — mean counterfactual net 0.41%

## Drawdown-episode placement (condition 2 audit)

- split boundary 2024-01-04
- baseline deepest DD — train -3.45% @2022-11-11; holdout -5.58% @2025-11-21
- condition (2) exercised by a holdout drawdown

### Secondary maxHold (exploratory only — never gates; no post-hoc promotion)

- maxHold=8: Δ CI [-0.24%, 0.65%], portfolio net 3.53%, n_convert 13
- maxHold=10: Δ CI [-0.19%, 0.80%], portfolio net 3.82%, n_convert 16

## Limitations

- Survivorship (today's universe) biases TOWARD extend — a borderline EXTEND is not actionable without point-in-time membership. Daily-close fills. Regime sizing held normal. Earnings = forward 5-trading-bar FMP filter. KEEP@7 does not mean extension never helps at a longer horizon (pre-register a fresh study to test that).