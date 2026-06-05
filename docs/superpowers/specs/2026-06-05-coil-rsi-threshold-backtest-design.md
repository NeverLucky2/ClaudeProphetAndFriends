# Coil RSI-Threshold Backtest (read-only, pre-registered) — Design

**Date:** 2026-06-05
**Status:** Revised after methodology review → implementation plan next
**Owner:** operator (lab experiment; never touches live Coil)

---

## Problem / motivation

Coil only enters on RSI(2) **< 5** (deep oversold). A WATCH near-miss (KO, RSI(2) 8.29 on
2026-06-04) bounced +2.6% the next day — the expected cost of a strict filter. The operator
wants to **measure** whether loosening the RSI(2) entry threshold would improve Coil, as a
lab experiment, **not** a live change. The operator prefers Coil's current stricter strategy;
this study must be trustworthy enough to either justify a change or (the expected result)
confirm "keep RSI<5."

**Hard constraint: read-only.** No edits to `TRADING_RULES_MEANREV.md`, the Go services, or
any live config. Output is reports + lab artifacts only.

### Framing insight that shapes the experiment

Coil sorts candidates by RSI ascending and takes the **4 most-oversold** (max 4 positions).
On days with ≥4 sub-5 names, a looser threshold changes nothing. Looser only adds trades
when fewer than 4 names are below 5 — and even then only the specific shallow names that win
a free slot. So the decision must rest on the **realized marginal trades** (what a 5→T move
actually admits under the cap), not on the raw edge of the [5,T) candidate pool.

---

## Phases, kill-gate, and the single holdout read

**Phase 1 — per-trade edge by RSI bucket (descriptive).** Over ~6yr of the 80-name
`MEANREV_UNIVERSE`, enumerate Coil-faithful entries (see *Enumeration* below), simulate
Coil's *real* exits, bucket each trade by entry RSI(2) — **[0–5), [5–8), [8–10), [10–15)** —
and compute realized **friction-net** mean return / win-rate / profit-factor per bucket, with
a date-block bootstrap CI **on the difference vs the [0–5) baseline**. This is descriptive: it
builds intuition and drives the kill-gate.

**Kill-gate runs on the TRAIN split only** (in-sample, may be inspected freely): if the
shallow buckets' difference-vs-baseline CIs sit clearly below 0 on train, stop and report
"keep RSI<5" — do not proceed to the holdout verdict.

**Phase 2 — portfolio simulation (decision).** Replay the actual book under threshold
variants **T ∈ {5, 8, 10, 15}** with Coil's portfolio rules (≤4 positions, 5% equity each,
24% cap, most-oversold-first, one per ticker), producing an equity curve and a **fill log**
(every trade actually taken at each T). The fill log yields the **marginal trades** (present
at T, absent at T=5) that the decision rule needs.

**The holdout is read exactly once.** A single frozen scoring pass computes *all* holdout
statistics — Phase-1 buckets, the cap-binding upper bound, and the Phase-2 fills/metrics for
every T — and writes one artifact. The kill-gate (train) and the decision rule (holdout) are
then applied to frozen outputs; no peek-adjust-peek.

---

## Pre-registration, primary threshold, and decision rule

A committed artifact `data/lab/coil-threshold-prereg.json` fixes — **before** the holdout
scoring pass — the hypothesis, buckets, the **single primary threshold T=8**, the metrics,
bootstrap params (block length, iterations, seed), the decision rule, and the **expected
outcome (the null: looser does not improve)**. History is split **chronologically 50/50**
(reuse `chronoSplit`). The scorer **refuses to score the holdout on a prereg-hash mismatch**
(reuse `verifyPrereg` from `coil-eventstudy-prereg.mjs`).

**Primary vs secondary (controls family-wise error).** Only **T=8** is decision-gated — the
smallest loosening and exactly the band a WATCH name like KO (RSI 8.29) sits in. **T=10 and
T=15 are secondary/exploratory**: reported for color, never used to declare an improvement.
(This avoids inflating the false-CONSIDER rate across three nested CI gates.)

**Pre-registered decision rule (primary T=8, evaluated on the frozen holdout):** loosening to
T=8 is an *improvement* only if **both** hold —
1. **Marginal-trade edge:** the trades in the Phase-2 fill log that are **present at T=8 but
   absent at T=5** have a friction-net mean-return date-block-bootstrap **95% CI on their mean
   that lies entirely above 0** (the trades the loosening actually adds are profitable after
   costs), **AND**
2. **Portfolio improvement:** the Phase-2 sim at T=8 shows **higher friction-net total
   return** than baseline (T=5) **and max drawdown ≤ baseline ×1.1**.

Otherwise the verdict is **KEEP RSI<5**. Expected: KEEP. Both conditions now read the **same
realized-fill universe** (the Phase-2 log), so they cannot disagree about population.

**Power floor (not the same as a null).** If the holdout marginal-fill population has **n < 30**,
condition (1)'s CI will be wide and default to KEEP — but the report must label this
**"underpowered / inconclusive,"** distinct from "looser is genuinely no better."

---

## Exit simulator (the one new core piece) — fidelity model

**Verified:** Coil's −7% stop and +10% take-profit are **resting broker bracket orders**
(`position_manager.go` `placeStopLossOrder`/`placeTakeProfitOrder`; live rows carry
`stop_loss_order_id`). So the stop triggers **intraday**, and the intraday model below is
faithful (not an approximation that would stop deep-bucket names early).

For each entry at signal bar `d`, simulate exits on subsequent daily bars `k = 1, 2, …`;
first trigger wins; precedence within a bar:

1. **−7% stop (intraday, gap-honest):** stop = `entry × 0.93`.
   - if `open[d+k] ≤ stop` → fill at `open[d+k]` (gap-through), reason `stop`;
   - else if `low[d+k] ≤ stop` → fill at `stop`, reason `stop`.
2. **RSI(2) > 70** (closes through `d+k`) → exit `close[d+k]`, reason `rsi_mean_cross`.
3. **close > SMA5** (SMA5 through `d+k`) → exit `close[d+k]`, reason `sma5_cross`.
4. **5-day time stop:** at `k = 5` if still open → exit `close[d+5]`, reason `time_stop`.

**Conventions (operator-approved):**
- **Entry fill = signal-day close** `close[d]` (Coil fills ~15:45; the daily close is the
  cleanest proxy, applied identically to every bucket so comparisons stay fair).
- **No lookahead:** entry predicate uses `closes[0..d]`; every exit check at `d+k` uses only
  data through `d+k`.
- **Right-censoring is a near-non-issue** (the 5-day time stop forces an exit on all but the
  final ~4 bars per name); censored trades are excluded and counted.
- Returns are per-share `(exit − entry)/entry`, then friction-adjusted.

---

## Enumeration (Coil-faithful) and the earnings filter

**Fresh-signals-only (mirrors one-per-ticker Coil).** Live Coil holds the first signal in a
name and never averages down or re-enters while a position is open. So Phase 1 enumerates a
new entry in a ticker **only when no simulated position in that ticker is open** at that date
(walk each name's bars; on a fired+eligible signal, open a simulated trade, skip further
signals until it exits). This prevents near-duplicate inflation of `n` and the bias toward
persistently-oversold names that enumerating *every* consecutive signal would cause.

**Earnings exclusion = Coil's real forward filter, via FMP historical earnings.** Coil skips
an entry only when earnings fall in the **next 5 trading days** (`HasEarningsWithinTradingDays`;
*past* earnings, `distance < 0`, are **not** excluded — Coil does trade post-earnings
gap-downs). The backtest replicates exactly this:
- A one-time fetch (`scripts/coil-threshold-earnings.mjs`, FMP `/stable/earnings-calendar`
  over the window, filtered to the 80 names) writes `data/lab/coil-earnings-dates.json` =
  `{ ticker: [earnings dates] }`.
- At signal bar `d`, exclude the entry iff the ticker has an earnings date within the next 5
  **trading** bars `(date[d], date[d+5]]` (the ticker's own bar dates *are* the trading
  calendar — no separate holiday calendar needed).
- This correctly **keeps** post-earnings gap-down entries (Coil takes them) and **drops** only
  pre-earnings ones — unlike a blanket gap proxy, which would mis-drop the former.

(Optional descriptive color, not decision-gating: flag entries whose entry-day overnight gap
exceeds ~7% as "post-earnings-ish" and report each bucket's stats split, to see how much of
the deep bucket is post-earnings mean-reversion. Deferred unless cheap.)

---

## Bootstrap (honest CIs under correlation)

Three correlation sources: (a) market-wide selloffs fire many names same-day with
beta-correlated returns; (b) overlapping ≤5-day holds across nearby dates; (c) same-name
duplicates — **handled** by fresh-signals-only enumeration above.

The bootstrap **resamples whole calendar date-blocks** (so same-day trades move together)
with **block length = 15 trading sessions** — comfortably ≫ the 5-day max hold, so a block
absorbs the within-trade and adjacent-entry overlap. Reuse the `mulberry32` + date-block
idiom from `coil-eventstudy-score.mjs`; CIs are computed on the **difference** (bucket −
baseline, or marginal-fill mean) so the kill-gate and decision rule both test a difference
sitting clear of 0, not a CI-vs-point-estimate comparison.

---

## Friction

Round-trip cost in basis points subtracted from each trade's gross return. Oversold entry
days have wide spreads, so the **representative number is 20 bps** round trip; **10 bps** is
reported as an optimistic floor and **30 bps** as a stress ceiling. The decision rule uses the
**20 bps** net. Reuse the project's stocks friction profile if one exists; else this stated
assumption.

---

## Metrics

**Phase 1 (per bucket, train & holdout):** **n** (always reported), win rate, mean & median
return (gross + net@20bps), profit factor, avg/median days held, exit-reason mix, worst
trade, and a date-block bootstrap **95% CI on the mean-net difference vs [0–5)**.

**Cap-binding stat (Phase 1, labeled an UPPER BOUND):** fraction of signal dates with <4
sub-5 names. This *over*states how often looser adds a trade (it ignores that prior-day open
positions already occupy slots); the **realized** frequency comes only from the Phase-2 fill
log. The ≥4-sub-5 direction is exact; the <4 side is the upper bound.

**Phase 2 (per variant T):** total net return, CAGR, max drawdown, # trades, trades/yr, win
rate, profit factor, average deployed %; plus the **marginal-fill set** (T vs T=5) with its n
and net-return CI for the decision rule.

---

## Components & files

**Reuses (unchanged):** `coil-eventstudy-bars.mjs` (`loadBars`, `parseBarsWithVolume`,
`indexByDate`), `coil-meanrev-signal.mjs` (`wilderRSI`, `sma`, existing `entryFires`),
`MEANREV_UNIVERSE` + `chronoSplit` from `coil-eventstudy-build.mjs`, and the bootstrap/prereg
idioms from `coil-eventstudy-{score,prereg}.mjs`.

**New (each focused, unit-tested via TDD):**
- `scripts/coil-threshold-exitsim.mjs` — pure exit simulator `simulateTrade(bars, entryIdx)`
  → `{ entry, exit, exitReason, daysHeld, grossReturn, censored }`; plus
  `entryFiresAt(closes, idx, rsiMax)` (relaxes **only** the RSI bound; SMA200/SMA5 gates
  unchanged) alongside the untouched `entryFires`.
- `scripts/coil-threshold-earnings.mjs` — one-time FMP historical-earnings fetch →
  `data/lab/coil-earnings-dates.json` (soft-fails to "no exclusion + loud warning" if FMP is
  unavailable, so the rest can still run with the caveat surfaced).
- `scripts/coil-threshold-build.mjs` — fresh-signal enumeration across the universe at the
  widest threshold (RSI<15) with the earnings filter applied, simulate each trade, tag bucket,
  chrono train/holdout split → `data/lab/coil-threshold-instances.json`.
- `scripts/coil-threshold-portfolio.mjs` — Phase-2 sim per variant T; emits equity curve +
  fill log.
- `scripts/coil-threshold-score.mjs` — train kill-gate + the single frozen holdout pass +
  decision rule; refuses holdout on prereg-hash mismatch.
- `data/lab/coil-threshold-prereg.json` — committed pre-registration.

**Output:** `docs/lab/coil-rsi-threshold-RESULTS.md` — per-bucket table (train+holdout, with
n), cap-binding upper bound, Phase-2 variant comparison, marginal-fill decision detail, and
the pre-registered **KEEP / CONSIDER / UNDERPOWERED** verdict.

---

## Data, universe, and known limitations (disclosed in the report)

- **Data:** `data/bar-cache/` daily bars (~6yr), IEX-adjusted; ≥210-bar warmup; SPY available
  for optional market-adjusted context (secondary, deferred — YAGNI).
- **Universe:** the current 80-name `MEANREV_UNIVERSE`.
- **Survivorship bias** — universe is *today's* large-caps. Direction is **conservative for our
  expected KEEP**: deep dips that never recovered (and later delisted out of today's universe)
  are disproportionately missing, which flatters the [0–5) baseline and biases *against*
  looser — i.e., it cannot manufacture a false CONSIDER. Stated, not corrected.
- **Daily-close fills**; the entry idealization is identical across buckets so it can't bias
  the comparison.
- **Phase-2 simplification (applied identically across all T, so the comparison stays fair):**
  regime/bear-mode sizing held at normal (live `ENABLE_REGIME_GATE` defaults off). Disclosed.
  (The earnings filter is **not** simplified away — it is faithfully applied per above.)

---

## Testing (TDD, node:test)

- **exit-sim:** each exit reason triggers; precedence within a bar; intraday-stop gap-through
  (open below stop → fill at open); time-stop at exactly k=5; censored trade at series end;
  no-lookahead.
- **entryFiresAt monotonicity:** at rsiMax=5 the fired set equals `entryFires`; at rsiMax=15
  the fired set is a **superset** containing every rsiMax=5 entry; SMA200/SMA5 still exclude
  names that violate them at every rsiMax.
- **fresh-signal dedup:** consecutive same-name signals while a sim position is open produce
  exactly one trade; a new trade only after the prior exits.
- **earnings filter:** entry dropped iff an earnings date falls in `(date[d], date[d+5]]`; a
  *past* earnings date does **not** drop the entry.
- **metrics:** win-rate, profit-factor, mean/median, friction (gross→net@20bps).
- **bootstrap:** determinism under fixed seed; difference-CI ordering (lo ≤ mean ≤ hi);
  block length honored.
- **prereg:** hash verify passes on match; scorer refuses holdout on mismatch.
- **portfolio:** cap binds at 4; one-per-ticker; 5% sizing; exits free slots; marginal-fill
  set (T vs T=5) computed correctly; equity/drawdown math on a small synthetic fixture.

---

## Confirmed-fine (reviewer-verified, not changing)

Right-censoring (forced out by the 5-day stop); the signal-from-close/fill-at-close
idealization (identical across buckets → comparison-neutral); RSI>70-vs-SMA5 precedence
(attribution-only — both exit at the same close, return identical); survivorship direction
(conservative, as above).

## Out of scope / deferred

Any live strategy change; point-in-time universe membership; intraday fills; alternative exit
rules; short side; non-RSI entry variants; SPY-relative returns beyond optional context.
