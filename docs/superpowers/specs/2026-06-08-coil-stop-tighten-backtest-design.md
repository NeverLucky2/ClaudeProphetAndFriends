# Coil Stop-Tightening Backtest (read-only, pre-registered) — Design

**Date:** 2026-06-08
**Status:** Design approved → implementation plan next
**Owner:** operator (lab experiment; never touches live Coil)
**Sibling / harness source:** `2026-06-05-coil-exit-timeout-backtest-design.md` (the **mirror twin** — that
study held the stop fixed and moved `maxHold`; this one holds `maxHold` fixed and moves the stop).
Reuses the exit-timeout / RSI-threshold harness wholesale.

---

## Problem / motivation

Coil exits a position on the first of: **−7% stop** (intraday bracket), RSI(2) > 70, close > SMA5, or a
5-trading-day time stop. The operator watched a fresh entry (DE) drift down intraday after the fill and
asked whether Coil should "cut losers faster" — sell a deteriorating position sooner instead of holding to
the daily-bar mean-reversion exit.

Two facts reframed that idea before this study:

1. **Coil's rule-based sell signals cannot change intraday.** RSI(2), SMA-5, and the time stop are all
   computed on the *prior completed daily bar* (`close[t-1]`); they are frozen until the close. A
   morning/midday beat running Coil's existing logic would reach the identical conclusion it reaches at
   15:45 — a no-op. The only thing that moves intraday is price, and the catastrophe channel is already
   handled: every Coil position carries a live **−7% broker-side hard stop** that fires automatically on
   any tick, faster than any beat could.
2. **"Cut losers faster" is therefore a *tighter fixed stop*, not a new beat.** A price threshold is a
   broker-bracket parameter (`stop_loss_pct`), watched continuously at zero token cost and zero discretion.
   A second daily LLM beat would be a strictly worse way to get the same behavior (one moment vs every
   tick; full wake cost; reintroduces the discretion Coil is engineered to remove).

So the live question collapses to a single empirical one: **would a tighter fixed stop improve Coil —
measured honestly, net of friction, with the drawdown-vs-expectancy tradeoff made explicit?** The prior is
negative: in mean reversion the position that is down the most intraday is, by construction, the one with
the most expected reversion; a tighter stop systematically realizes those drawdowns right before the
bounce. But it is *testable* on Coil's real entry history, exactly as the RSI-threshold and exit-timeout
questions were.

**Hard constraint: read-only.** No edits to `TRADING_RULES_MEANREV.md`, the Go services, or any live
config. Output is reports + lab artifacts only.

**Single-axis discipline (mirror of the sibling).** The *only* knob that moves is `stopPct`. `maxHold = 5`,
RSI(2) > 70, and close > SMA5 are **unchanged**. The combined stop×timeout (or stop×entry) grid is out of
scope until each single axis resolves.

---

## The knob, the marginal set, and the headline number

**Variants.** Sweep `stopPct ∈ {0.03, 0.04, 0.05, 0.06}` against the live baseline `0.07`. **Primary =
`0.05`** (a meaningful cut from −7%, the midpoint; decision-gated). `0.03 / 0.04 / 0.06` are
secondary/exploratory color, never used to declare an improvement.

**The marginal set is the trades a tighter stop actually changes.** For a variant `s' < 0.07`, a trade is
**marginal** iff `simulateTrade(bars, entryIdx, { stopPct: s' })` differs from the baseline
`simulateTrade(bars, entryIdx, { stopPct: 0.07 })` in exit price, `exitReason`, or `grossReturn` —
equivalently, its intraday path touched the −`s'` level at some bar *before* its baseline (−7%) exit. Any
trade whose path never reached −`s'` fires the identical exit at the identical bar regardless of stop level,
so the comparison is **paired**: the same entries, simulated at `s'` vs `0.07`.

The per-trade **friction-net delta** is `Δ_s' = net(return@s') − net(return@7)`. Each marginal trade is:
- a **save** (`Δ_s' > 0`) — the trade would have ended worse (it eventually hit −7%, or closed below −`s'`);
  the tighter stop locked the loss earlier/shallower. *This is the intended benefit.*
- a **whipsaw** (`Δ_s' < 0`) — the path dipped to −`s'`, the tighter stop fired, but the baseline trade then
  reverted to a better exit (RSI/SMA5 cross, or a shallower time-stop close). *This is the cost — cutting
  the dip Coil bought for.*

**Headline operator number** (the direct mirror of the timeout study's bounce/meander/stop-conversion
decomposition): `(n_whipsaw, dragSum = Σ negative Δ)` versus `(n_save, saveSum = Σ positive Δ)`, plus the
net `Σ Δ_s'` and the worst single trade. The decision rule below does not let a positive net be funded by a
thin margin of a few large saves over a systematic whipsaw tail (it reports the winsorized net as a
robustness read), but the binding gates are at the portfolio level — see below.

### Why the gap-through model makes this clean

`simulateTrade` already resolves a stop **gap-honestly**: `open ≤ stop → fill at open` (gap-through), else
`low ≤ stop → fill at stop`. Two consequences that keep the marginal set well-defined:
- A baseline trade that **gapped** through −7% (open ≤ 0.93·entry) also gaps through −5% (open ≤ 0.95·entry)
  and fills at the **same open price** → `grossReturn` identical → **not marginal**. Tightening only changes
  **intraday-touch** stops. Correct and intuitive: you cannot "cut faster" a loss that gapped past both
  levels at once.
- An intraday-touch baseline stop at −7% becomes a −5% fill, possibly on an **earlier** bar (the first bar
  whose low reached −5%). Re-simulating at `s'` captures both the shallower fill and the earlier timing.

The daily-low approximation is the same verified fidelity model the sibling studies already use; no intraday
minute data is required, and the stop-precedence-within-a-bar convention (intraday stop before close-based
exits) is already correct for a stop.

---

## Pre-registered decision rule — "cut risk, hold returns"

Evaluated on the **frozen holdout**, **primary `stopPct = 0.05`**. The operator's chosen success bar is
**reduce risk while holding returns**, so two portfolio-level gates bind — both must hold for **TIGHTEN**:

1. **(A) Risk materially down.** Holdout portfolio **max drawdown** at −5% ≤ **0.90 ×** baseline max
   drawdown (a ≥ **10%** relative reduction). This max-drawdown ratio is the **single binding test** for gate
   (A). The trade-level **CVaR(5%)** (mean of the worst 5% of friction-net trade returns) is **reported
   alongside as corroboration** — it should move the same direction, and a max-DD pass contradicted by a
   *worse* CVaR(5%) is flagged for operator attention — but CVaR is **not itself a hard sub-gate** (avoids a
   brittle two-part AND the operator did not sign up for).
2. **(B) Returns held.** Holdout **friction-net total return** at −5% ≥ **0.90 ×** baseline total return (a
   give-up of no more than **10%** relative).

If **both** hold → **TIGHTEN to −5%**. Otherwise → **KEEP −7%**, with the failing gate named:
- (A) fails → **"KEEP — no material risk reduction"** (the tighter stop did not cut drawdown enough to
  justify any expectancy give-up).
- (B) fails → **"KEEP — return give-up too large"** (it cut risk but bled the mean-reversion edge past
  tolerance).
- both fail → **"KEEP — strictly dominated"** (worse on both axes).

**The two thresholds — `0.90` DD-reduction floor and `0.90` return-retention floor — are the entire
operational definition of "cut risk, hold returns," and are fixed in the prereg artifact.** They are
symmetric by design (a 10% DD win must not cost more than 10% of return).

**Mechanism read (descriptive, not a gate).** Report the marginal-set net `Σ Δ_5%` with a date-block
bootstrap 95% CI, and its **upside-winsorized** version (saves capped at p90) to show whether a positive net
is broad or a thin margin of a few large saves over a whipsaw tail. This explains *why* the portfolio gates
land where they do; it does not by itself decide the verdict.

**Secondary discipline (no retro-promotion).** `−3 / −4 / −6%` are reported for color only. A KEEP at −5%
does **not** mean "no tightening ever helps"; if a secondary level looks strong, that is grounds to
pre-register a *fresh* study with that level as the new primary, never to retro-promote a secondary number
into this study's verdict.

**Power floor.** If the holdout marginal set at −5% has **n < 30**, gates default to KEEP labeled
**"underpowered / inconclusive,"** distinct from "tightening is genuinely no better."

**Expected outcome (the null):** KEEP. Tightening a mean-reversion stop is expected to cut drawdown only
modestly (Coil's −7% already bounds per-name loss) while giving up more expectancy than the threshold
allows, because it converts reverting dips into realized whipsaw losses.

---

## Train kill-gate and the single holdout read

History is split **chronologically 50/50** (reuse `chronoSplit`). The **kill-gate runs on the TRAIN split
only** (in-sample, freely inspectable): if at −5% the train shows **neither** gate plausibly satisfiable —
drawdown not reduced **and** return give-up already beyond tolerance — stop and report **KEEP** without
spending the holdout read.

**The holdout is read exactly once.** A single frozen scoring pass computes *all* holdout statistics — the
per-trade marginal deltas and the Phase-2 portfolio metrics for every variant — and writes one artifact. The
kill-gate (train) and the decision rule (holdout) are then applied to frozen outputs; no peek-adjust-peek.
The scorer **refuses to score the holdout on a prereg-hash mismatch** (reuse `verifyThresholdPrereg`).

---

## Two caveats — both flipped from the timeout study, stated prominently

1. **Survivorship now biases *toward* KEEP (and is bounded).** The universe is *today's* large-caps, so
   names that dipped deep and never recovered (later delisted) are disproportionately **missing** — and those
   are exactly the names a tight stop would rescue. Their absence **understates** tightening's benefit, biasing
   the study toward KEEP. **But Coil already runs a −7% stop**, so per-name loss is already bounded at ~−7%
   (plus gap slippage); the only residual benefit a tighter stop could add on a missing disaster is the few
   percent between −5% and −7%, not a −30% rescue. So the survivorship distortion here is **small and bounded**,
   a KEEP verdict stays credible, and a *borderline TIGHTEN* must be read with the caveat that live tail
   protection could be marginally better than the surviving sample shows.

2. **An untested drawdown gate is fatal here — because risk reduction *is* the point.** Gate (A) can only be
   exercised if the holdout half actually contains a material drawdown episode (2020 crash, 2022 bear, or a
   comparable correlated bleed where many Coil names fall to their stops together). A single chronological
   50/50 split is one draw of where that stress sits. **The report must list which major drawdown episodes fall
   in holdout vs train.** If no material episode falls in the holdout, gate (A) is flagged **"untested"** and a
   TIGHTEN verdict is treated as **unconfirmed** — a walk-forward / multi-split DD check would be the fix
   (deferred unless this caveat actually bites). This caveat is *more* central than in the sibling study, where
   drawdown was a backstop rather than the primary objective.

---

## Phase 2 — portfolio simulation, and the flipped endogeneity

Replay the actual book under each `stopPct` variant with Coil's portfolio rules (≤ 4 positions, 5% equity
each, 24% cap, most-oversold-first, one per ticker), producing an equity curve, a fill log, max drawdown,
total net return, turnover, and slot-occupancy.

**The endogeneity flips: a tighter stop *frees a slot faster*, which can *admit* more fresh entries** — an
opportunity **benefit**, the mirror of the timeout study's opportunity **cost** (a longer hold blocking
entries). In a 4-slot capped book, a trade that stops out at −5% on day 2 vacates its slot for a fresh sub-5
signal that the −7% version (still holding to day 4) would have blocked. So an equity-curve difference
between variants reflects *both* the changed exit price *and* the changed realized entry set. Report the
**`admitted@s'`** count — fresh sub-5 signals taken under `s'` that were blocked under baseline because a slot
was still occupied — and the realized forward return of those admitted entries, so the opportunity channel is
legible rather than implicit. (This means a tighter stop is not purely a drag even on expectancy: faster
recycling can partly offset the whipsaw cost — which is precisely why gate (B) is evaluated at the portfolio
level, not on the marginal set alone.)

---

## Friction and the stop-slippage sensitivity

**Per-trade Δ is friction-invariant.** Both the `s'` and `0.07` sims are one entry + one exit = one round
trip; a flat per-trade bps deduction cancels exactly in `Δ_s' = (gross@s' − b) − (gross@7 − b) = gross@s' −
gross@7`. So the marginal-set deltas measure *price* return, the correct per-trade question. Friction bites at
the **portfolio level**, where a tighter stop means **more realized trades → more round trips paid** (the
mirror of the timeout study's *fewer* trips). Phase 2 charges one round trip per realized trade at **20 bps**
(representative; oversold-day spreads are wide), with **10 bps** floor / **30 bps** ceiling as sensitivity.

**Stop-slippage sensitivity (new, specific to tightening).** A real stop fills *worse* than its level on
fast moves; tighter stops are *touched more often*, so this does **not** cancel and makes tightening look
slightly worse. Model a sensitivity arm where stop exits fill at `stop − 10 bps` (in addition to the
existing gap-through-at-open model). Report the verdict at the baseline (20 bps, no extra stop slip) and
confirm it is stable under this arm.

---

## Components & files

**Reused (unchanged, imported):**
- `coil-threshold-exitsim.mjs` — `simulateTrade` (with `stopPct`), `entryFiresAt`.
- `coil-threshold-metrics.mjs` — `applyFriction`, `mean`, `median`, `winRate`, `profitFactor`,
  `bootstrapMeanCI`, `bootstrapDiffCI`.
- `coil-threshold-prereg.mjs` — `verifyThresholdPrereg` (hash refuse-on-mismatch).
- `coil-threshold-earnings.mjs` + `data/lab/coil-earnings-dates.json` — forward earnings filter
  (exclude entry iff earnings within the next 5 trading bars; soft-fail to "no exclusion + loud warning").
- `coil-eventstudy-bars.mjs` (`loadBars`, `indexByDate`), `coil-meanrev-signal.mjs` (`wilderRSI`, `sma`,
  `entryFires`), `MEANREV_UNIVERSE` + `chronoSplit` from `coil-eventstudy-build.mjs`.
- The portfolio replay structure from `coil-timeout-portfolio.mjs` (`maxDrawdown`, `deepestDD`, blocked/
  admitted accounting) — adapted from a `maxHold` parameter to a `stopPct` parameter.

**New (each focused, unit-tested via TDD):**
- `scripts/coil-stop-build.mjs` — fresh-signal enumeration at the live RSI(2) < 5 with the earnings filter;
  for each entry simulate under `stopPct ∈ {0.03, 0.04, 0.05, 0.06, 0.07}`; tag each variant's marginal set
  (outcome-changed vs the 0.07 baseline), classify each marginal trade save/whipsaw, record `Δ_s'` and a
  censored flag; chrono train/holdout split → `data/lab/coil-stop-instances.json`.
- `scripts/coil-stop-portfolio.mjs` — Phase-2 book sim per `stopPct` variant; emits equity curve, fill log,
  max drawdown, total net return, turnover / slot-occupancy, and the **`admitted@s'`** counts +
  counterfactual forward returns.
- `scripts/coil-stop-score.mjs` — train kill-gate + single frozen holdout pass + the two-gate decision rule
  (A risk-down via max-DD ratio + CVaR(5%), B return-retention via total-return ratio), the save/whipsaw
  decomposition (`n_whipsaw`/`dragSum` vs `n_save`/`saveSum`), the marginal net Δ (raw + winsorized) CIs, and
  the **drawdown-episode placement** (holdout vs train); refuses holdout on prereg hash mismatch.
- A **CVaR(5%)** helper (`cvar(returns, 0.05)` — mean of the worst 5% of net trade returns); ~4 lines, added
  to `coil-threshold-metrics.mjs` or a small new module, TDD'd.
- `data/lab/coil-stop-prereg.json` — committed pre-registration: variants `{0.03,0.04,0.05,0.06}` vs `0.07`,
  primary `0.05`, the two-gate decision rule with the **`0.90` DD-reduction floor and `0.90` return-retention
  floor**, the CVaR(5%) support metric, bootstrap params (block length 15, iterations, seed), winsorize
  percentile 90 for the mechanism read, and the expected null (KEEP).

**Output:** `docs/lab/coil-stop-tighten-RESULTS.md` — the save/whipsaw decomposition (headline
`n_whipsaw`/`dragSum` vs `n_save`/`saveSum`) per variant, the full `Δ_s'` distribution + worst trade, the
Phase-2 variant comparison (total net return, max drawdown, CVaR(5%), turnover/slot-occupancy/`admitted@s'`
+ counterfactuals), the train-vs-holdout **drawdown-episode placement**, the stop-slippage sensitivity, the
no-retro-promote note, and the pre-registered verdict — one of **TIGHTEN / KEEP-no-risk-reduction /
KEEP-return-give-up / KEEP-strictly-dominated / UNDERPOWERED**, with gate (A) flagged **untested** if no
material drawdown episode fell in the holdout.

---

## Data, universe, and known limitations (disclosed in the report)

- **Data:** `data/bar-cache/` daily bars (~6yr), IEX-adjusted; ≥ 210-bar warmup.
- **Universe:** the current `MEANREV_UNIVERSE` (~80 names).
- **Survivorship** — see caveat #1 (biases toward KEEP; bounded by the existing −7% stop).
- **Daily-close fills / daily-low stop touch**; identical convention across variants → comparison-neutral.
  The stop-slippage sensitivity arm probes the one place this idealization favors tightening.
- **Phase-2 simplification (applied identically across all variants):** regime/bear-mode sizing held at
  normal (live `ENABLE_REGIME_GATE` defaults off). The earnings filter is faithfully applied (not simplified).
- **Gate (A) is only as good as the stress in the holdout half** — see caveat #2 (untested-DD → unconfirmed
  TIGHTEN).

---

## Testing (TDD, node:test)

- **marginal-set correctness:** a trade whose path never reaches −`s'` is identical at `s'` and `0.07`
  (not marginal); a trade whose intraday low reaches −`s'` before its baseline exit is marginal and its
  `Δ_s'` is computed from the re-simulated fill.
- **gap-through invariance:** a baseline trade that gapped through −7% (open ≤ 0.93·entry) is **not** marginal
  at −5% (same open fill); only an intraday-touch stop changes.
- **save/whipsaw classification:** a synthetic trade that eventually hits −7% lands in **save** with `Δ>0`; a
  trade that dips to −`s'` then reverts to an RSI/SMA5 exit lands in **whipsaw** with `Δ<0`; counts partition
  the marginal set.
- **earlier-bar fill:** when an earlier bar's low reaches −`s'` but not −7%, the `s'` exit fires on the
  earlier bar at the shallower price.
- **friction cancellation / charge:** the fixed round-trip bps cancels in the per-trade `Δ_s'`; Phase-2
  charges one round trip per realized trade (more trades under tighter stop ⇒ more total friction).
- **CVaR(5%):** mean of the worst 5% of returns; monotonic (a more-negative tail lowers it); edge cases
  (n < 20) handled.
- **build:** fresh-signal dedup; earnings filter drops iff earnings in `(date[d], date[d+5]]`; chrono split
  partitions instances 50/50 by date.
- **portfolio:** cap binds at 4; one-per-ticker; 5% sizing; a tighter stop demonstrably **frees a slot
  earlier** and increments `admitted@s'` (with the admitted signal's RSI + counterfactual forward return
  recorded); max-drawdown / total-return math on a small synthetic fixture.
- **bootstrap:** determinism under fixed seed; CI ordering (lo ≤ mean ≤ hi); block length honored; date-block
  resampling moves same-day trades together.
- **prereg:** `verifyThresholdPrereg` passes on match; scorer refuses holdout on mismatch.
- **decision rule:** clean TIGHTEN only when (A) max-DD ≤ 0.90× **and** (B) total-return ≥ 0.90× both pass;
  distinct KEEP labels for (A)-fail ("no material risk reduction"), (B)-fail ("return give-up too large"),
  both-fail ("strictly dominated"); marginal `n < 30` → "underpowered"; holdout with no major drawdown
  episode → gate (A) flagged "untested"; a borderline TIGHTEN that does not survive the stop-slippage arm is
  flagged **fragile / unconfirmed** (the primary verdict is read at the 20 bps baseline).

---

## Confirmed-fine (reuse, not changing)

The exit simulator and its gap-honest fidelity model (already verified against `position_manager.go`); the
signal-from-close / fill-at-close idealization (identical across variants → comparison-neutral); the
RSI>70-vs-SMA5 precedence (attribution-only); the earnings filter and FMP data file; `chronoSplit`,
`bootstrapMeanCI`, and the prereg hash guard.

## Out of scope / deferred (each a separate sibling study if pursued)

Any live strategy change; **trailing stops** and **intraday take-profit tightening** (distinct mechanisms —
their own pre-registered studies); loosening the −7% stop or the RSI>70/SMA5 time exits; the entry-threshold
axis (sibling study, done); the combined stop×timeout or stop×entry grid (only after each single axis
resolves); short side; SPY-relative returns; intraday minute fills; point-in-time universe membership.
