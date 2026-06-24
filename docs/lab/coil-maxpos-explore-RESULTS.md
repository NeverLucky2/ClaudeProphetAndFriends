# Coil max-positions sensitivity — EXPLORATORY read

**Date:** 2026-06-24
**Status:** EXPLORATORY (not pre-registered). Directional read to validate the
2026-06-24 capital reallocation (Coil 4×5% → 7×6%). See
`docs/superpowers/specs/2026-06-24-coil-capital-reallocation-design.md`.
**Script:** `scripts/coil-maxpos-explore.mjs` — thin wrapper over the validated
`simulatePortfolio` (tested in `coil-threshold-portfolio.test.mjs`).
**Data:** `data/lab/coil-threshold-instances.json` (live entry rsi2<5; 20bps friction —
the studies' representative figure). all=468 live signals (train=226, holdout=242).

## Honesty caveats

- **Not holdout-virgin.** This reuses instances already touched by the prior threshold/
  timeout/stop studies, so it cannot claim the read-once discipline those carried. It is a
  deploy-support diagnostic, not a verdict with the same authority.
- Non-compounding fixed-fractional accounting; no bootstrap CI here (the prior studies
  bootstrapped — this is a point-estimate sweep). Direction is consistent across splits.

## Results

### A) Pure concurrency effect (size held at 5%, deploy cap unbinding)

Isolates the count knob — same per-trade size, only the slot ceiling moves.

| maxPos | holdout nTrades | holdout net % | holdout maxDD % | all net % | all maxDD % |
|---|---|---|---|---|---|
| 4 | 214 | +5.72 | −2.60 | +4.74 | −2.80 |
| 5 | 228 | +6.35 | −2.33 | +5.62 | −2.78 |
| 6 | 234 | +6.79 | −2.33 | +6.30 | −3.17 |
| **7** | **236** | **+6.86** | **−2.33** | **+6.22** | **−3.15** |
| 8 | 237 | +6.82 | −2.33 | +6.05 | −3.43 |

### B) Real config change

| config | holdout nTrades | holdout net % | holdout maxDD % | all net % | all maxDD % |
|---|---|---|---|---|---|
| CURRENT 4×5% (cap 24%) | 214 | +5.72 | −2.60 | +4.74 | −2.80 |
| **NEW 7×6% (cap 42%)** | **236** | **+8.24** | **−2.80** | **+7.46** | **−3.77** |

## Verdict (exploratory): the increase is SUPPORTED

1. **4 is not optimal.** The 4-cap binds and leaves signal uncaptured — ~10% more trades
   at 7 (holdout 214→236), with cumulative net rising, not falling.
2. **The ballast / drawdown-clustering fear did not appear.** On the holdout, more
   concurrent slots left maxDD flat-to-better (−2.60→−2.33). Mechanism: with only 4 slots
   the book concentrates in the deepest-oversold (often worst) names; more slots dilute
   that with shallower names that recover, smoothing the curve.
3. **7 is a reasonable stop.** Past 7 (i.e. 8), trades keep rising but net flattens and
   maxDD deepens — diminishing-to-negative marginal positions.
4. **The new config's extra drawdown is the 6% sizing, not the count** (all-split
   −2.80→−3.77 ≈ 1.2× scaling of 5%→6%). That is the one genuine risk knob, and the
   trade is ~+2.7 pts net for ~+0.9 pt drawdown on the full set.

## Follow-up (optional)

A pre-registered max-positions study (own prereg hash, holdout read once, bootstrap CI)
would convert this directional read into a KEEP/CHANGE verdict at the bar the other Coil
studies cleared. Not required to deploy a ceiling change on paper, but cheap to do if the
operator wants the rigor.
