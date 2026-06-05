# Coil Exit-Timeout Backtest (read-only, pre-registered) — Design

**Date:** 2026-06-05
**Status:** Revised after external methodology review → implementation plan next
**Owner:** operator (lab experiment; never touches live Coil)
**Sibling:** `2026-06-05-coil-rsi-threshold-backtest-design.md` (this study reuses its harness)

---

## Problem / motivation

Coil exits a position on the first of: −7% stop (intraday bracket), RSI(2) > 70, close > SMA5,
or a **5-trading-day time stop**. Inspecting Coil's closed book, the operator noticed its
small losers (e.g. WMT −3.46%, UNH −1.08%) tend to keep mean-reverting *after* Coil exits —
suggesting the **5-day time stop may be cutting trades before the reversion completes**. The
question: would **extending the time stop** improve Coil — measured honestly, net of friction,
tail risk, and the **opportunity cost** of holding a slot longer?

This is a **lab experiment, not a live change**. The operator prefers Coil's current strategy
and expects the null (extending does not help); the study must be trustworthy enough to either
justify a change or confirm "keep the 5-day stop."

**Hard constraint: read-only.** No edits to `TRADING_RULES_MEANREV.md`, the Go services, or any
live config. Output is reports + lab artifacts only.

**The −7% stop is sacrosanct.** Per the operator decision, the stop and the two reversion exits
(RSI(2) > 70, close > SMA5) are **unchanged**. The *only* knob that moves is `maxHold`. This
study cannot and will not recommend loosening the stop.

### Framing insights that shape the experiment

1. **The affected population is a paired set, not a fresh one.** Raising `maxHold` from 5 to T
   can only change the outcome of a trade that reached the **5-day time stop still open**. Any
   trade that already exited via −7% stop / RSI>70 / SMA5 within 5 days fires that same exit at
   the same bar regardless of `maxHold`. So the "marginal" trades are the **same entries**,
   simulated to day 5 vs day T — a **paired** comparison. This is more powerful than the
   sibling RSI study's fresh-population test and exactly answers "does more time help the
   trades the timeout actually cuts short?"

2. **Per-trade edge and portfolio edge can genuinely diverge — this is the crux.** A trade held
   to day 7–10 occupies one of Coil's 4 slots and can block a fresh, more-oversold entry. So
   even if the held-longer trades earn more *individually*, total portfolio return can *fall*
   from reduced turnover / slot starvation. The per-trade buckets build intuition; the
   **portfolio simulation is decisive.**

3. **The 5-day stop is an implicit tight exit for the stuck population, and `Δ_T` has an
   asymmetric left tail — the mean alone hides it.** A `time_stop@5` trade is, by construction, a
   position that spent five days never hitting −7%, never RSI>70, never closing above SMA5 — a
   stuck, meandering name, usually a small loser (the WMT/UNH pattern). Extend it and exactly
   three things happen: it **bounces** (RSI>70 or SMA5-cross fires on a modest recovery →
   bounded gain ~+1–4%), it **meanders** to the day-T close (small Δ either sign), or it **keeps
   falling to −7% and stops out** — a trade sitting at −2% on day 5 that converts to a −7%
   stop-out is a `Δ` of ~−5%. So `Δ_T` is a cluster of modest positives plus a **fat left tail
   of stop-conversions**, and the **mean can be positive while the change introduces exactly the
   loosened-margin tail the time stop exists to prevent**. For a tight-margin operator the
   headline number is therefore the **stop-conversion count and its summed drag**, not the mean;
   the decision rule below adds a tail-robustness gate so a mean propped up by a few big bounces
   over a systematic conversion tail does **not** read as EXTEND.

---

## Phases, kill-gate, and the single holdout read

**Phase 1 — paired per-trade delta (descriptive).** Over ~6yr of the 80-name `MEANREV_UNIVERSE`,
enumerate Coil-faithful entries at the **live RSI(2) < 5** (production `entryFires`). For each
entry, simulate the trade under `maxHold ∈ {5, 7, 8, 10}`. Restrict to the **paired marginal
set** = entries whose `exitReason == 'time_stop'` at `maxHold = 5`, and compute the per-trade
**friction-net return delta** `Δ_T = net(return@T) − net(return@5)` with a date-block bootstrap
**95% CI on mean(Δ_T)**. Descriptive: builds intuition and drives the kill-gate.

**Kill-gate runs on the TRAIN split only** (in-sample, may be inspected freely): if the primary
variant's `mean(Δ_7)` CI sits clearly below 0 on train, stop and report "keep 5-day stop" — do
not proceed to the holdout verdict.

**Phase 2 — portfolio simulation (decision).** Replay the actual book under each `maxHold`
variant with Coil's portfolio rules (≤4 positions, 5% equity each, 24% cap, most-oversold-first,
one per ticker), producing an equity curve, a fill log, and **turnover / average-deployed /
slot-occupancy / blocked-signal** statistics (the opportunity-cost signal). The entry *rule* is
identical across variants (RSI<5), but the **realized entry set is endogenous to `maxHold`**: in
a 4-slot capped book, a longer hold occupies a slot longer and can block fresh sub-5 signals, so
which entries actually get taken differs by variant. **That endogeneity is the opportunity-cost
channel (framing insight #2) — it must not be assumed away.** An equity-curve difference between
variants reflects *both* the changed exit timing *and* the changed realized entry set; the
blocked-signal metrics below decompose the second channel so it is legible rather than implicit.

**The holdout is read exactly once.** A single frozen scoring pass computes *all* holdout
statistics — Phase-1 paired deltas for every T, and the Phase-2 fills/metrics for every T — and
writes one artifact. The kill-gate (train) and the decision rule (holdout) are then applied to
frozen outputs; no peek-adjust-peek.

---

## Pre-registration, primary variant, and decision rule

A committed artifact `data/lab/coil-timeout-prereg.json` fixes — **before** the holdout scoring
pass — the hypothesis, variants, the **single primary `maxHold = 7` (+2 days)**, the metrics,
bootstrap params (block length 15, iterations, seed), the decision rule, and the **expected
outcome (the null: extending does not improve)**. History is split **chronologically 50/50**
(reuse `chronoSplit`). The scorer **refuses to score the holdout on a prereg-hash mismatch**
(reuse `verifyThresholdPrereg` from `coil-threshold-prereg.mjs`).

**Primary vs secondary (controls family-wise error).** Only **`maxHold = 7`** is decision-gated
— the smallest extension *in our variant set* and a deliberately conservative choice (note +2 is
a choice, not the floor: +1/`maxHold=6` is smaller but not tested, as the operator picked +2).
**`maxHold ∈ {8, 10}` are secondary/exploratory:** reported for color, never used to declare an
improvement. (This avoids inflating the false-positive rate across nested CI gates — mirrors the
RSI study's T=8-only gate.)

**Single-primary discipline binds the back end too (no post-hoc promotion).** A **KEEP at
`maxHold=7` does not mean "extension never helps"** — the motivating reversion may simply unfold
over a longer horizon than +2 days. If `maxHold ∈ {8, 10}` look strong in the secondary color,
that is **grounds to pre-register a fresh study with that horizon as the new primary, never to
retro-promote the secondary into this study's verdict.** The report states this explicitly so a
juicy exploratory number does not get over-read.

**Pre-registered decision rule (primary `maxHold = 7`, evaluated on the frozen holdout):**
extending to 7 days is a clean **EXTEND** only if **all three** hold —
1. **(1a) Paired marginal edge:** over the holdout trades that exited via `time_stop` at
   `maxHold=5`, the per-trade delta `Δ_7 = net(return@7) − net(return@5)` has a date-block
   bootstrap **95% CI on its mean entirely above 0** (the trades the extension keeps open earn
   more price-return). **AND**
2. **(1b) Edge is not tail-funded:** recompute `mean(Δ_7)` with the **upside winsorized at its
   90th percentile** (cap the few large bounces); the winsorized CI must **still clear 0**. This
   rejects the framing-insight-#3 failure mode where a handful of big bounces outweigh a
   systematic tail of stop-conversions. **AND**
3. **(2) Portfolio improvement:** the Phase-2 sim at `maxHold=7` shows **higher friction-net
   total return** than baseline (`maxHold=5`) **and max drawdown ≤ baseline ×1.1**.

**Why winsorize the upside rather than gate on a CVaR-no-deterioration test:** by construction
the `maxHold=5` marginal population has *zero* stop-outs (they're all time-stops), so *any*
extension that adds even one stop-conversion makes a naive worst-quantile CVaR strictly worse —
a CVaR-no-deterioration gate would mechanically force KEEP regardless of the data and the study
could never detect a real improvement. Winsorizing the upside instead asks the right question:
"is the edge broad, or is it a thin margin of a few bounces sitting on top of a fat conversion
tail?" The **stop-conversion count and summed drag are reported as the headline operator number
regardless** (see Metrics) — for the tight-margin thesis that count is the read; the gates make
it decision-binding.

Otherwise the verdict is **KEEP 5-day stop**, with the failing condition named. Distinct labels:
- (1a) fails → **KEEP** (no per-trade edge).
- (1a) passes but **(1b) fails → "KEEP — edge is tail-funded"** (an edge exists but it is funded
  by a few bounces over a stop-conversion tail; not actionable for a tight-margin operator).
- (2) fails → **"KEEP — opportunity cost dominates"** (per-trade edge real, but slot starvation
  sinks the book).

Expected: KEEP. The three conditions are **aligned in spirit but not byte-identical in
population** — (1a)/(1b) score the paired `maxHold=5` marginal set; (2) scores the per-variant
realized book (whose entry set is endogenous to `maxHold`, per Phase 2). They can therefore
legitimately point different directions — that divergence is *informative* (edge vs
opportunity-cost), not a contradiction — so the spec does **not** claim they read one identical
population.

**Power floor (not the same as a null).** If the holdout has **`n_delta@7` < 30** non-censored
paired trades, conditions (1a)/(1b) will be wide and default to KEEP — labeled
**"underpowered / inconclusive,"** distinct from "extending is genuinely no better."
(`n_delta@7` ≤ `n_paired`; see Metrics for the censoring distinction.)

---

## Exit simulator (reused as-is — no new core piece)

`simulateTrade(bars, entryIdx, { stopPct, maxHold, rsiExit })` already exists in
`coil-threshold-exitsim.mjs` and **already parametrizes `maxHold`** (default 5). The timeout
study calls it with `maxHold ∈ {5,7,8,10}` and changes nothing else. Its verified fidelity
model (unchanged):

1. **−7% stop (intraday, gap-honest):** `stop = entry × 0.93`; open ≤ stop → fill at open
   (gap-through), else low ≤ stop → fill at stop; reason `stop`.
2. **RSI(2) > 70** (closes through `d+k`) → exit `close[d+k]`, reason `rsi_mean_cross`.
3. **close > SMA5** → exit `close[d+k]`, reason `sma5_cross`.
4. **`maxHold`-day time stop:** at `k = maxHold` if still open → exit `close[d+maxHold]`,
   reason `time_stop`.

**Conventions (operator-approved, inherited from the sibling):** entry fill = signal-day close;
no lookahead (exit checks at `d+k` use only bars[0..d+k]); censored trades (series ends before
exit) excluded and counted; returns per-share `(exit − entry)/entry`, then friction-adjusted.

**Paired-delta property (the testable core, covered by a unit test):** for a fixed entry, the
result of `simulateTrade` is **identical for all `maxHold ≥ k`** when the trade exits at bar `k`
via `stop`/`rsi_mean_cross`/`sma5_cross`. Only trades that reach `time_stop` at `maxHold=5`
can differ at larger `maxHold`. The build relies on this to isolate the marginal set.

---

## Enumeration (Coil-faithful) and the earnings filter

**Entry at the live RSI(2) < 5.** This study tests the *current* strategy's exit, so entries are
the strict production set (`entryFires`, i.e. `entryFiresAt(closes, idx, 5)`), **not** a loosened
threshold. The entry question is the separate sibling study.

**Fresh-signals-only (mirrors one-per-ticker Coil).** Enumerate a new entry in a ticker only when
no simulated position in that ticker is open at that date (walk each name's bars; on a
fired+eligible signal, open a simulated trade, skip further signals until it exits). Prevents
near-duplicate inflation of `n`. **Note:** because hold length varies by `maxHold`, the
fresh-signal *gap* differs slightly across variants in Phase 2 (a longer hold can suppress a
nearby re-entry). Phase 1's paired delta is computed on the **shared `maxHold=5` entry set** (so
the pairing is exact); Phase 2 enumerates per-variant faithfully (so the portfolio reflects the
real turnover consequence). This split is intentional and disclosed.

**Earnings exclusion = Coil's real forward filter.** Reuse `data/lab/coil-earnings-dates.json`
(already produced by the sibling via `coil-threshold-earnings.mjs`, FMP `/stable/earnings-calendar`).
At signal bar `d`, exclude the entry iff the ticker has an earnings date within the next 5
**trading** bars `(date[d], date[d+5]]`; *past* earnings are not excluded (Coil trades
post-earnings gap-downs). Identical to the sibling; soft-fails to "no exclusion + loud warning"
if the file is absent.

---

## Bootstrap (honest CIs under correlation)

Reuse `bootstrapMeanCI(rows, { iterations, seed, blockSessions })` from
`coil-threshold-metrics.mjs`, fed the **per-trade paired deltas** (each row carrying its entry
date so whole calendar **date-blocks** resample together). **Block length = 15 trading sessions**
— comfortably ≫ the ≤10-day max hold, so a block absorbs within-trade and adjacent-entry
overlap. The CI is on the **mean delta** (a difference already, so the gate is "CI clear of 0,"
not a CI-vs-point comparison). Correlation sources handled: same-day market selloffs (date-block),
overlapping holds (block ≫ hold), same-name duplicates (fresh-signal enumeration).

---

## Friction

Round-trip cost in basis points via `applyFriction` (a flat per-trade deduction). **Key
consequence:** because a fixed flat bps applies once per trade and extending a hold does **not**
add a round trip (it's still one entry + one exit), the friction term **cancels exactly** in the
per-trade paired delta: `Δ_T(net@b) = (gross@T − b) − (gross@5 − b) = gross@T − gross@5` for any
bps `b`. So **conditions (1a)/(1b) are friction-invariant** — they measure whether the cut-short
trades earn more *price* return when held longer, the correct per-trade question. Friction's real
bite is at the **portfolio level (condition 2 / Phase 2)**, where a longer hold means **fewer
realized trades → fewer round trips paid**, traded off against fewer fresh opportunities. The Phase-2 sim
charges one round trip per realized trade and is reported at **20 bps** (representative; oversold
days have wide spreads), with **10 bps** floor / **30 bps** ceiling as sensitivity. The 20 bps
net is what the decision rule uses for condition (2).

---

## Metrics

**Phase 1 (paired, train & holdout).** Two distinct counts, always reported separately so the
denominator is never ambiguous:
- **`n_paired`** — size of the marginal set, *fixed by the day-5 outcome* (`exitReason ==
  'time_stop'` at `maxHold=5`).
- **`n_delta@T`** — the subset of `n_paired` with enough forward bars to reach their `T`-exit
  without censoring (a `time_stop@5` trade with only 5–9 forward bars left can censor at larger
  `T`). All `Δ_T` statistics are computed over `n_delta@T`; censored members are excluded and
  counted. `n_delta@T ≤ n_paired`.

For each T over `n_delta@T`: mean & median `Δ_T` (friction-invariant per the Friction section —
gross delta = net delta); the **winsorized-upside mean `Δ_T`** (condition 1b input); the
date-block bootstrap **95% CI on mean(`Δ_T`)** (raw and winsorized).

**Headline tail decomposition (the operator number).** Partition `n_delta@T` by what the
extension did, with each branch's count and summed `Δ` contribution:
- **bounce** — exits via `rsi_mean_cross` / `sma5_cross` after day 5 (the intended upside);
- **meander** — exits via the new `time_stop@T` (small `Δ`, either sign);
- **stop-conversion** — exits via `−7% stop` after day 5 (`exitReason` flips `time_stop@5` →
  `stop@T`). Report **`n_convert@T`** and **`dragSum@T`** (summed `Δ` of the conversion branch,
  the magnitude of loosened-margin damage). Plus the full `Δ_T` distribution as deciles and the
  worst trade.

**Phase 2 (per variant T):** total net return, CAGR, max drawdown, # trades, trades/yr, win
rate, profit factor, average deployed % / slot-occupancy / turnover; the equity curve; and the
baseline-vs-T comparison the decision rule needs.

**Blocked-signal accounting (makes opportunity cost legible — the verdict hinges on how often
the cap actually binds).** Average-deployed-% alone cannot tell you which world you're in, so
report directly: of the fresh sub-5 signals that arrived during the sim, **how many hit zero
free slots specifically because a held-longer trade was still occupying one** (i.e. blocked at
T but not at baseline=5) — the **`blocked@T`** count — and the **counterfactual quality of those
blocked signals**: their entry RSI(2) and their realized forward return had they been taken. If
Coil typically runs with free slots, `blocked@7` is near zero, extension costs almost nothing,
and the per-trade effect dominates; if the cap binds often, opportunity cost dominates and a
positive paired delta can still lose at the portfolio level (condition 2). This count is what
disambiguates the two worlds.

---

## Components & files

**Reused (unchanged, imported):**
- `coil-threshold-exitsim.mjs` — `simulateTrade` (with `maxHold`), `entryFiresAt`.
- `coil-threshold-metrics.mjs` — `applyFriction`, `mean`, `median`, `winRate`, `profitFactor`,
  `bootstrapMeanCI`.
- `coil-threshold-prereg.mjs` — `verifyThresholdPrereg` (hash refuse-on-mismatch).
- `coil-threshold-earnings.mjs` + `data/lab/coil-earnings-dates.json` — forward earnings filter.
- `coil-eventstudy-bars.mjs` (`loadBars`, parsing, `indexByDate`), `coil-meanrev-signal.mjs`
  (`wilderRSI`, `sma`, `entryFires`), `MEANREV_UNIVERSE` + `chronoSplit` from
  `coil-eventstudy-build.mjs`.

**New (each focused, unit-tested via TDD):**
- `scripts/coil-timeout-build.mjs` — fresh-signal enumeration at RSI<5 with the earnings filter;
  for each entry simulate under `maxHold ∈ {5,7,8,10}`; tag the paired marginal set
  (`time_stop@5`); per entry/T record the exit branch (bounce / meander / stop-conversion),
  `Δ_T`, and a censored flag (drives `n_delta@T`); chrono train/holdout split →
  `data/lab/coil-timeout-instances.json`.
- `scripts/coil-timeout-portfolio.mjs` — Phase-2 book sim per variant; emits equity curve, fill
  log, turnover/slot-occupancy stats.
- `scripts/coil-timeout-score.mjs` — train kill-gate + single frozen holdout pass + three-part
  decision rule (1a raw paired-Δ CI via `bootstrapMeanCI`, 1b winsorized-upside paired-Δ CI, 2
  portfolio improvement), the tail decomposition (`n_convert`/`dragSum`), `blocked@T`, and the
  drawdown-episode placement; refuses holdout on prereg hash mismatch.
- `data/lab/coil-timeout-prereg.json` — committed pre-registration (variants, primary
  `maxHold=7`, metrics, bootstrap params, **winsorize percentile = 90 for condition 1b**, the
  three-part decision rule (1a edge / 1b not-tail-funded / 2 portfolio), expected null).

**Output:** `docs/lab/coil-exit-timeout-RESULTS.md` — paired-delta table (train+holdout, with
`n_paired` and `n_delta@T`), the **tail decomposition** (bounce / meander / stop-conversion with
`n_convert@T` + `dragSum@T` as the headline operator number), the full `Δ_T` distribution,
Phase-2 variant comparison (incl. turnover/slot-occupancy/`blocked@T` + blocked-signal
counterfactuals), the **train-vs-holdout drawdown-episode placement** (so condition 2's exercise
is auditable), the no-retro-promote note, and the pre-registered verdict — one of **EXTEND /
KEEP / KEEP-edge-tail-funded / KEEP-opportunity-cost / UNDERPOWERED**, with condition (2) flagged
**untested** if no major drawdown episode fell in the holdout.

---

## Data, universe, and known limitations (disclosed in the report)

- **Data:** `data/bar-cache/` daily bars (~6yr), IEX-adjusted; ≥210-bar warmup.
- **Universe:** the current 80-name `MEANREV_UNIVERSE`.
- **Survivorship bias** — universe is *today's* large-caps. Direction is **conservative for our
  expected KEEP**: deep dips that never recovered (and later delisted) are disproportionately
  missing, which flatters the held-longer trades and biases *toward* EXTEND — i.e. it could
  manufacture a false EXTEND. **This is the opposite of the sibling study's safe direction, so
  it is called out prominently:** a borderline EXTEND verdict must be read with this caveat, and
  the report states it cannot be relied on without point-in-time membership (out of scope).
- **Daily-close fills**; identical across variants → comparison-neutral.
- **Phase-2 simplification (applied identically across all T):** regime/bear-mode sizing held at
  normal (live `ENABLE_REGIME_GATE` defaults off). Disclosed. The earnings filter is faithfully
  applied (not simplified).
- **Condition (2)'s drawdown gate is only as good as the stress in the holdout half.** Extension's
  worst case is a correlated tail — a slow market-wide bleed where many held-longer trades fall to
  their −7% stops together (the time stop's real job is time-based de-risking out of such a
  decline). That tail lives in max-drawdown, so condition (2) is the right backstop — *but a single
  chronological 50/50 split is one draw of where the stress sits.* If the major drawdown episodes
  (e.g. 2020 crash, 2022 bear) land in **train** and the holdout is comparatively calm, condition
  (2) passes **without ever being exercised**, and a borderline EXTEND would be exactly the false
  positive the survivorship caveat already worries about. **The report must list which major
  drawdown episodes fall in holdout vs train**; if no material episode falls in holdout, condition
  (2) is labeled **"untested"** and a borderline EXTEND is treated as *unconfirmed*. (A walk-forward
  / multi-split DD check is the fix if the gate proves untested — deferred to keep the
  single-holdout-read discipline unless this caveat actually bites.)

---

## Testing (TDD, node:test)

- **paired-invariance:** for a fixed entry that exits via stop/rsi/sma5 at bar k≤5, `simulateTrade`
  returns identical results for `maxHold ∈ {5,7,8,10}`; only a `time_stop@5` trade differs.
- **delta correctness:** `Δ_T` computed only over the paired marginal set; gross→net@20bps; the
  fixed round-trip cost cancels in the delta (no double-charge for a longer hold).
- **censoring counts:** `n_paired` fixed by the day-5 outcome; a `time_stop@5` trade with too few
  forward bars to reach its `T`-exit is excluded from `n_delta@T` and counted censored;
  `n_delta@T ≤ n_paired`.
- **tail decomposition:** a synthetic marginal trade that converts `time_stop@5 → stop@T` lands in
  the stop-conversion branch and contributes its (negative) `Δ` to `dragSum@T`; a post-day-5
  RSI/SMA5 exit lands in bounce; the branch counts sum to `n_delta@T`.
- **winsorized edge (1b):** capping the upside at p90 lowers `mean(Δ_T)`; a fixture whose positive
  mean is driven by a few large bounces over a conversion tail fails (1b) while passing (1a).
- **build:** fresh-signal dedup; earnings filter drops iff earnings in `(date[d], date[d+5]]`;
  chrono split partitions instances 50/50 by date.
- **bootstrap:** determinism under fixed seed; CI ordering (lo ≤ mean ≤ hi); block length honored;
  date-block resampling moves same-day trades together.
- **prereg:** `verifyThresholdPrereg` passes on match; scorer refuses holdout on mismatch.
- **portfolio:** cap binds at 4; one-per-ticker; 5% sizing; a longer hold demonstrably suppresses
  a nearby re-entry and increments `blocked@T` (with the blocked signal's RSI + counterfactual
  forward return recorded); equity/drawdown math on a small synthetic fixture.
- **decision rule:** clean EXTEND only when (1a)+(1b)+(2) all pass; distinct KEEP labels for
  (1a)-fail, (1b)-fail ("edge is tail-funded"), and (2)-fail ("opportunity cost dominates");
  `n_delta@7 < 30` → KEEP-underpowered; holdout with no major drawdown episode → condition (2)
  flagged "untested."

---

## Confirmed-fine (reviewer-verified, not changing)

The exit simulator and its fidelity model (reused from the sibling, already verified against
`position_manager.go`); the signal-from-close / fill-at-close idealization (identical across
variants → comparison-neutral); RSI>70-vs-SMA5 precedence (attribution-only; same close, same
return); the earnings filter and FMP data file (reused unchanged).

## Out of scope / deferred

Any live strategy change; point-in-time universe membership; intraday fills; loosening the −7%
stop or the RSI>70/SMA5 exits; entry-threshold variants (the sibling study); short side;
SPY-relative returns; combined entry×exit grid (only after both single-axis studies resolve).
