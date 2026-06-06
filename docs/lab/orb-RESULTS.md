# ORB Backtest — Results

**Verdict: REJECT** — gate_net=false gate_mktrel=false gate_robust=false

Generic daily-bar-free ORB on liquid ETFs. A backtest of generic ORB answers "does ORB carry edge for me", NOT "is the seller legit" (his exact config is unknown + ILM undefinable). A REJECT is not a verdict on the seller, and a 5-min-bar test does not bear on tick-level variants. Prereg hash `a8c19e69`. Gated metric: R-multiple at ETF friction 2bps. Expected: UNCERTAIN.

## Primary gates (R-multiple, holdout, ETF cut)

| gate | n | mean | CI lo | CI hi |
|---|---|---|---|---|
| net (SPY/QQQ/IWM/DIA) | 2782 | 0.031 | -0.034 | 0.096 |
| market-relative (ex-SPY) | 2043 | -0.026 | -0.059 | 0.007 |
- train net R mean: 0.037; train market-relative R mean: -0.010
- holdout distinct entry dates (effective N): 733

## Robustness & intraday texture

- net R mean after dropping top 5 days: 0.016 (vs 0.031 full) — tail-concentration check
- edge by ET hour (net R):
  - 9:00  n=1461  meanR=0.037
  - 10:00  n=1171  meanR=0.025
  - 11:00  n=99  meanR=0.140
  - 12:00  n=21  meanR=-0.331
  - 13:00  n=16  meanR=0.054
  - 14:00  n=10  meanR=-0.450
  - 15:00  n=4  meanR=-0.137
- train→holdout split boundary (last train date): 2023-07-05 — disclose which of 2018-Q4 / 2020 / 2022 vol episodes fall on each side

## Large-cap cut (EXPLORATORY — selected on the dependent variable; NEVER gates)

- holdout net R (AAPL/NVDA/TSLA/AMD/META @ 10bps): n=2125 mean -0.043 CI [-0.083, -0.002] — these names are chosen for the momentum behavior ORB exploits, so this flatters ORB and is not trusted.

## Limitations

- Next-bar-open fill; IEX feed (volume filter dropped; opening-range extrema biased INWARD → flatters ORB, any KEEP needs SIP re-confirm); 5-min granularity (approx intrabar stops); R right-skewed by trend-day winners (hence drop-top-5); ~2016+ window; capacity ignored.