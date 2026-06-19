# Reduced-EOV Backtest — Design / Pre-Registration

**Date:** 2026-06-19
**Status:** pre-registration (design approved; gate *values* frozen at `eov-prereg` time)
**Type:** lab-only pre-registered backtest. Read-only. **No deployment.**
**Origin:** Barclays "Impact of Retail Options Trading" (14 Sep 2020). See memory
`barclays-retail-options-paper-evaluated`. Sibling of the EMA / ORB studies.

## 1. Objective & hypotheses

Test whether **reduced-EOV** (call-volume intensity) has *tradable forward* predictive
power on the underlying stocks of heavily-optioned mega-caps, in **either** direction.

- **H_mom:** high lagged-EOV → positive forward returns (dealer short-gamma hedging
  pressure persists into the next sessions).
- **H_rev:** high lagged-EOV → negative forward returns (retail call-chasing top-ticks;
  the move reverts).

Because both are plausible, the direction is **not** pre-committed; instead it is fixed
in-sample (train) and must be independently confirmed out-of-sample (holdout) — see §5. This
avoids selecting the sign post-hoc.

**Honest prior: REJECT.** The paper's EOV↔return relationship is *contemporaneous*
(same-day), explicitly not a forecast; and we can only build it at **half strength**
(the `CallVol/CallOI` half is unavailable — see §7). We expect no surviving forward edge.
This pre-registration exists to kill (or, improbably, flag) the idea honestly, not to
confirm it.

## 2. Signal definition

For each name `n` and trading day `T`:

- `CallVol(n,T)` = Σ daily-bar `volume` over **every** call contract on name `n`'s
  underlying root (standard **and** adjusted) that prints a bar on day `T`, across active
  **and** inactive/expired contracts. A contract contributes only on days it actually trades
  (a daily bar with `v>0`), which naturally bounds it to `[listing, expiration]`.
- `reducedEOV(n,T) = CallVol(n,T) / mean( CallVol(n, T-21 .. T-1) )`
  — trailing **21 trading-day** average, **excluding** day T. Undefined (and the name-day is
  dropped) if fewer than 21 valid prior observations, if the trailing mean is 0, or if T is
  in a split-exclusion window (§4).
- Each day, **cross-sectionally percentile-rank** `reducedEOV` across the **valid** names
  that day → `EOVrank(n,T) ∈ [0,1]`. A formation date is skipped entirely if fewer than
  **12** names are valid.

This is **only** the `CallVol / trailing-1M-CallVol` half of the paper's EOV. The paper's
full EOV averages this with `CallVol / CallOI`; the OI half is omitted because open interest
is unavailable on this account (see §7). The study tests a **proxy**, and the verdict
language must say so.

## 3. Universe (paper-derived, fixed)

20 names = paper's Top-20-by-option-volume-increase + the 8 call-spread names, mapped to
current tickers, filtered to names still liquid/optionable in 2024–26:

```
AAPL MSFT NVDA AMZN GOOGL META TSLA AMD NFLX ADBE
BABA SHOP PYPL ROKU MRNA BA WMT JPM ZM EBAY
```

Dropped: `GOOG` (share-class dupe of GOOGL); `SQ` (messy 2024 ticker change to XYZ).
The list is fixed in advance — **not** selected on the dependent variable. Implementation
must confirm each name has Alpaca options-bar coverage spanning the window; any name with
gappy early coverage is flagged in RESULTS (its early name-days will simply be invalid per
§2, not silently zero).

## 4. Construction & forward returns

- **Timing.** The day-`T` signal is known only **after** T's close → **enter at T+1 open**,
  hold `h ∈ {1, 3, 5}` trading days, **exit at the open** of day `T+1+h`. Open-to-open, so
  the fill price is realistic for an after-close signal. No same-day lookahead.
- **Adjusted prices (required).** Stock bars are pulled split/dividend-adjusted
  (Alpaca `adjustment=all`). Forward returns and all betas use adjusted prices, so a split
  cannot masquerade as a return.
- **Split-volume exclusion (required).** A split inflates contract *volume* mechanically
  (e.g. NVDA 10:1, Jun 2024). For each split in-window (fetched from corporate actions), the
  affected name's EOV is **invalid** from the split day through **split + 21 trading days**
  (until the trailing-mean window is fully post-split). This prevents a split from
  manufacturing a spurious top-EOV rank.
- **Overlap handling.** Daily formation with `h>1` yields overlapping, autocorrelated
  returns. All CIs use a **moving-block bootstrap** over the **time axis** (block length =
  `h`, 10,000 resamples, fixed RNG seed recorded in `eov-prereg.json` for reproducibility),
  95% confidence. For the pooled long-only metric the resampling unit is the **date-block**
  (all names within a sampled block are kept together), so cross-sectional co-movement is
  preserved rather than treated as independent name-days (which would understate the CI).
  Point estimates are plain means. (Non-overlapping formation rejected — discards 2/3 of an
  already-short sample.)
- **Betas.** OLS, estimated on the **train period only** and applied to the holdout (a
  holdout-estimated beta would absorb alpha). One `β̂_spread` for the spread-vs-QQQ
  regression; one `β̂_n` per name for the long-only leg. Assumes beta stability over ~2 yr
  (noted §7). QQQ return windows are matched to each trade's exact `h`-day open-to-open
  window.
- **Primary construction (research):** long-short = equal-weight **top-5** `EOVrank` minus
  equal-weight **bottom-5**, formed each day. Dollar-neutral but **not** beta-neutral by
  construction (high-EOV names tend to be higher beta) → it is **beta-neutralized** before
  gating: `spread_resid_t = spread_t − β̂_spread · QQQ_t`.
- **Deployable construction:** the **long-only** leg actually holdable given the fleet can't
  short single names — top-5 if the edge is momentum, bottom-5 if reversal. Scored as pooled
  per-name beta-adjusted alpha `α_n = mean(r_n − β̂_n · QQQ)`.
- **Friction.** Net of the repo's existing equity friction profile (spread + slippage),
  applied per leg per rebalance with **no netting** of overlapping holds. This deliberately
  *overstates* turnover cost — a conservative bias toward REJECT, which is the safe direction.

## 5. Gates — train→holdout replication, beta-neutral dual gate

Replaces ORB's single-pass dual gate with an explicit in-sample/out-of-sample replication,
because the direction is data-derived. Confirmatory cell: **long-short, `h = 3`**.

**Stage 1 — establish direction on train (in-sample).**
- Compute daily `spread_resid` (beta-neutralized, §4) at h=3 over the train window.
- `d* := sign(mean train spread_resid)` (momentum if `+`, reversal if `−`).
- **Train must itself be non-null:** the train `spread_resid` one-sided CI (direction `d*`)
  must exclude 0. If it doesn't, there is no credible in-sample signal to confirm →
  **REJECT (NO-SIGNAL)**. This stops a direction being defined from train noise.

**Stage 2 — confirm on holdout (out-of-sample), `d*` fixed from Stage 1.**
- **Gate A — cross-sectional, beta-neutral:** holdout friction-net `spread_resid`, one-sided
  block-bootstrap CI in direction `d*`, excludes 0.
- **Gate B — deployable long-only, beta-adjusted:** the holdable long leg's pooled per-name
  `α_n` (friction-net, beta-adjusted), one-sided CI **> 0**. Ensures the edge survives
  long-only after beta, not just as an un-shortable spread.
- **Robustness (supportive, non-gating):** `spread_resid` carries the same sign `d*` at both
  h=1 and h=5.

**Power floor.** UNDERPOWERED if the holdout has **< 100 distinct formation dates** (Gate A)
or the long leg has **< 200 pooled name-trades** (Gate B).

**Verdict.**
- **KEEP-CANDIDATE** ⟺ Stage-1 train signal present ∧ Gate A ∧ Gate B ∧ not UNDERPOWERED.
  Report the direction (momentum/reversal) per `d*`.
- Otherwise **REJECT** (or **UNDERPOWERED** if the data floor fails).

**Multiple-comparison control.** The confirmatory family is exactly {Stage-1 train, Gate A,
Gate B} at h=3 in the single train-derived direction. Other horizons, the raw
(non-beta-adjusted) spread, the opposite direction, and per-name breakdowns are
**exploratory/descriptive** and **cannot promote a REJECT to KEEP**.

A KEEP-CANDIDATE does **not** authorize deployment. Because the holdout is short (§7) and the
signal is half-strength, the only sanctioned next step after a KEEP is **forward
paper-collection confirmation** — never direct agent wiring.

## 6. Holdout

- Window: **~Feb 2024** (Alpaca options-data inception) → present (~2.3 yrs).
- Split on the sorted list of **valid formation dates** (post warm-up and split exclusions),
  chronological: **train = earliest 70%**, **holdout = most recent 30%**. The first ~21
  trading days are consumed by the trailing-mean warm-up. The exact split date and the count
  of valid formation dates are computed and **frozen in `eov-prereg.json`**.
- `eov-score` refuses to run on a prereg-hash mismatch (exit 4), so
  gates/split/horizon/seed cannot be edited after seeing holdout results. `d*` is derived by
  a frozen *rule* (sign of train `spread_resid`), computed at score time from train data only
  — no holdout leakage.

## 7. Known limitations (carried verbatim into RESULTS)

1. **Half-signal:** no open interest → only the volume-intensity half of EOV. Tests a proxy.
2. **Short history:** ~2.3 yrs; holdout ~8 months. Thin for a clean out-of-sample read; the
   power floor and the train→holdout replication guard against over-reading.
3. **Enumeration/survivorship:** `CallVol` depends on how completely Alpaca's `status=inactive`
   query returns long-expired contracts. A *time-varying* completeness (more complete
   recently) would bias the ratio; a *constant* per-name undercount cancels in the ratio. The
   build emits a contract-count-per-name-per-month table; a visible ramp is flagged in RESULTS.
4. **Data-quality check:** confirm Alpaca options-bar `volume` is consolidated OPRA volume,
   not a single-venue subset. If single-venue, `CallVol` is a biased proxy — note in RESULTS.
5. **Beta stability:** train-estimated betas are applied to the holdout; structural beta
   shifts would mis-adjust. Reported, not corrected (rolling betas eat the short sample).
6. **Universe drift:** fixed 20-name list; BABA (ADR), ZM, ROKU, MRNA are lighter / more
   idiosyncratic than the mega-cap core.
7. **Lab-only, no deployment.** No agent, config, or strategy file is touched by this study.

## 8. Pipeline & artifacts (Node `.mjs`, ORB-style)

Scripts under `scripts/`, run in order:

| # | Script | Output | Notes |
|---|--------|--------|-------|
| 1 | `eov-fetch-contracts.mjs` | `data/lab/eov-contracts/<name>.json` | enumerate call contracts (Alpaca `/v2/options/contracts`, `status=active` **and** `inactive`, paginated) over the window |
| 2 | `eov-fetch-bars.mjs` | `data/lab/eov-volume-cache/<name>.json` | batch daily option bars for all contracts → aggregate per-name daily `CallVol`; resumable cache |
| 3 | `eov-fetch-stockbars.mjs` | `data/lab/eov-stockbars/` | **split/div-adjusted** (`adjustment=all`) daily stock bars: 20 names + QQQ + SPY |
| 4 | `eov-fetch-corpactions.mjs` | `data/lab/eov-splits.json` | in-window stock splits per name (for §4 exclusion windows) |
| 5 | `eov-build.mjs` | `data/lab/eov-instances.json` + integrity report | EOV panel (§2) + forward returns (§4) + contract-count integrity table (§7.3) |
| 6 | `eov-prereg.mjs` | `data/lab/eov-prereg.json` (hash-locked) | freeze cell, horizons, split fraction, confidence, resamples, **RNG seed**, gate rules — **MUST precede scoring** |
| 7 | `eov-score.mjs` | `docs/lab/eov-RESULTS.md` (+ VERDICT, carries prereg hash) | refuses on hash mismatch (exit 4); Stage-1 direction + Stage-2 gates on frozen holdout |

- Tests: `node --test scripts/eov-*.test.mjs`. Cover at minimum: EOV math + warm-up drop,
  split-window exclusion, cross-sectional rank with <12-name skip, open-to-open forward
  return, beta-neutralization, moving-block bootstrap (seeded → deterministic), prereg
  hash-lock refusal, train/holdout split boundary.
- `data/lab/*` (contracts, bars, stockbars, splits, instances, prereg) is **git-ignored**.
- **Committed:** `docs/lab/eov-RESULTS.md` (carries the prereg hash) + `docs/lab/eov-RUNBOOK.md`.
- Alpaca creds read from `.env` in the run directory (copy project-root `.env` into the
  worktree, as the ORB runbook documents).

## 9. Out of scope (YAGNI)

- No GEX / dealer-gamma-by-strike modeling (needs OI + greeks panel — unavailable).
- No options-execution simulation (the trade is in the **stock**, not options).
- No parameter grid / ablation (single confirmatory cell; horizons are the only sweep, and
  the off-cells are exploratory-only).
- No netted-turnover friction variant (the no-netting overstatement is intentionally
  conservative).
- No live data clock, no agent wiring, no dashboard.
