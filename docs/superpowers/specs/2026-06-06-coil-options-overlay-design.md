# Coil Options-Overlay Feasibility Model — Design Spec

**Date:** 2026-06-06
**Status:** Approved (brainstorm) + revised after external review, pending implementation plan
**Type:** Lab-only feasibility MODEL (not a backtest, not a pre-registered fleet study).

## Motivation

The operator's one validated edge is Coil (RSI(2) mean-reversion, ~66% win, +0.59% net/trade in
the underlying, ~2–5 day holds). The idea under test: express Coil's signal via **options** at
entry. Long calls are likely the wrong instrument — Coil fires on RSI(2)<5 (post-selloff, so
elevated IV), and the bounce it bets on typically *crushes* IV, hurting long calls (positive
vega) on top of theta and wide spreads. The structurally-honest expression of a "bounce / stop
falling" thesis is *selling* vol (cash-secured puts): short vega (you want the crush), positive
theta, bullish-to-neutral delta. This model is a **cheap screen** to decide whether real
(expensive) historical options data is worth buying — NOT a trade verdict. Output is an
assumption **sensitivity surface**, not a binary KEEP/REJECT.

**Asymmetric-trustworthiness principle (drives the whole design).** Every simplification a cheap
model makes lands on the short put's *risk* side (see §6). Therefore this model can **reliably
KILL long calls** (a one-sided cheap screen) but can only **conditionally green-light short puts**
— and a put pass means "worth buying real options data to test the tail," never "trade it." The
design hardens the put tail as far as a no-options-data model can, then defers to real data.

Honest prior: long calls killed; short puts marginal-but-off-thesis (a short-vol overlay
amplifies long-beta + adds short-vol, moving *away* from the fleet's uncorrelated-ballast thesis).

## §1 Inputs (all already on disk)

- **Trade tape:** `data/lab/coil-threshold-instances.json`. Filter to the **`[0,5)` bucket,
  completed** trades. Each carries `ticker, date, entry (S0), exit (S1), daysHeld`.
- **Daily bars:** `data/bar-cache` via the existing loader — used for (a) spike-aware entry vol
  and (b) the underlying price at the put's expiry (hold-to-expiry path).
- **Entry IV (per trade, spike-aware):** primary = trailing **5-trading-day realized vol**
  (annualized) ending at the entry date — captures the acute RSI(2)<5 selloff Coil enters into —
  × an **RV→IV premium** multiplier. (A 20-day window dilutes the spike and biases entry vol low,
  which would *weaken* the call kill; the 5-day primary avoids that.) Sweep window {5, 20} and
  premium {0.8, 1.0, 1.2, 1.5} — the sub-1.0 value represents the post-drop regime where
  short-window RV can exceed IV (inverted variance-risk-premium). Trades with insufficient
  trailing bars are dropped (reported).

## §2 Model (per trade, per structure)

Black-Scholes European, ATM (`K = S0`). `r = 0.04` flat (rho on a ≤30-DTE ATM option is
immaterial — not swept).

**State-dependent exit IV (the core fix over flat crush).** Because vol rises when names fall
(leverage effect), the exit IV depends on the trade outcome:
- bounce (`S1 ≥ S0`): `exitIV = ivEntry × (1 − crush)` (the crush helps the short put).
- loser (`S1 < S0`): `exitIV = ivEntry × (1 + spike)` (rising vol — the short put buys back into
  an expensive, going-ITM print: this is the tail a flat crush hides).

**Structures & exits:**
- **Long ATM call — exit = mirror Coil's stock exit** (sell when Coil exits, at `daysHeld`/`S1`).
  Entry `= bsCall(S0,S0,DTE/365,r,ivEntry)`; exit `= bsCall(S1,S0,(DTE−daysHeld)/365,r,exitIV)`
  (intrinsic if `daysHeld ≥ DTE`). P&L = **return on premium**, net of round-trip spread.
- **Short ATM cash-secured put — primary exit = HOLD TO EXPIRY** (the natural CSP that harvests
  full theta). Underlying at expiry `S_exp` = bar-cache close at `entry_date + DTE` calendar days
  (nearest prior trading day). P&L `= premium_received_net − max(0, S0 − S_exp)`. No exit IV
  needed (intrinsic at expiry); the tail is the assignment depth `S0 − S_exp`.
  - **Secondary exit = mirror Coil's stock exit** (buy back at `daysHeld` via
    `bsPut(S1,S0,(DTE−daysHeld)/365,r,exitIV)` — this is where the loser **spike** bites).
- Round-trip **spread** applied half each side (long: buy `×(1+s/2)`, sell `×(1−s/2)`; short:
  sell-to-open `×(1−s/2)`, buy-to-close `×(1+s/2)`).

## §3 Parameter sweep

| knob | values | primary |
|---|---|---|
| entry-vol RV window | 5 / 20 trading days | 5 |
| RV→IV premium | 0.8 / 1.0 / 1.2 / 1.5 | 1.2 |
| IV crush (exit, on bounces) | 0% / 20% / 40% | 20% |
| **IV spike (exit, on losers)** | 0% / 30% / 60% | 30% |
| spread (round-trip, % of premium) | 5% / 10% | 10% |
| DTE at entry (calendar days) | 7 / 14 / 30 | 14 |

Per cell, per structure: mean P&L/trade + **date-block bootstrap CI** (`coil-threshold-metrics`
`bootstrapMeanCI`, rows `{date, net}`, block 15, 10000 iters, seed 1234) + win rate. For the put,
also: **worst per-trade loss**, **worst-decile mean loss**, and the **tail-risk ratio** =
mean P&L ÷ |worst-decile mean loss| (the decision-relevant unit — see §4).

## §4 Decision (kill-rule on the surface; tail-resolution as a precondition)

- **Long calls — KILLED** if mean return-on-premium ≤ 0 in **the cell that maximizes it across
  the full sweep** (the empirically most-optimistic cell — don't hand-pick knob directions, since
  a long call is long-vega/long-theta-sensitive and the favorable corner isn't obvious a priori).
  If even the best cell loses, real options data is not worth buying for calls.
- **Short puts — "worth real options data"** ONLY if ALL hold:
  1. **Tail modeled:** the loser **spike** is on (spike ≥ 30%) — a flat-crush/0-spike pass does
     not count.
  2. **Band, not a cell:** mean-P&L 95% CI lo > 0 across a *band* of plausible cells (central
     ± the loser-spike-stress cell + the 20-day window + premium {0.8, 1.5}), not one cell.
  3. **Risk-adjusted vs the stock:** the put's **tail-risk ratio** beats simply holding the Coil
     stock trade (its +0.59% mean against its bounded −7% stop) — i.e. the premium captured per
     unit of tail risk must beat the underlying, not just be positive.
- **Honest ceiling (stated in RESULTS):** BS-European cannot model American **early assignment**
  (which clusters on the deep-ITM losers), nor skew/term-structure. So even a hardened put pass
  means **"buy real options chains to test the assignment tail,"** never "trade it." The model
  reliably kills calls; it can only *gate the data spend* for puts.

## §5 Build & conventions

- Node `.mjs` under `scripts/coil-opt-*.mjs`, **TDD with `node:test`**:
  - `coil-opt-bsm.mjs` — `bsPrice(type, S, K, T, r, sigma)` (tested vs known values; `T≤0` →
    intrinsic).
  - `coil-opt-rv.mjs` — `trailingRealizedVol(closes, idx, window)` (annualized; null if short).
  - `coil-opt-overlay.mjs` — `exitIV(ivEntry, S0, S1, crush, spike)` (state-dependent) +
    `callPnl(...)` (mirror-exit, return-on-premium) + `putPnlHoldToExpiry({S0, S_exp, premium...})`
    + `putPnlMirror({S0, S1, daysHeld, ivEntry, ...})` (return-on-collateral).
  - `coil-opt-score.mjs` — load tape → spike-aware entry IV (bar-cache) → expiry-underlying
    lookup (bar-cache) → sweep both structures × all cells → bootstrap + tail metrics → render
    `docs/lab/coil-options-overlay-RESULTS.md` + apply §4.
- Reuse `coil-threshold-metrics.mjs` and the daily bar loader (`coil-eventstudy-bars.mjs`).
  `data/lab/*` git-ignored; only RESULTS.md committed. Feature branch `coil-options-overlay`;
  squash-merge to local main. Lab-only, no flags, no deploy.

## §6 Limitations (pre-stated — note the DIRECTION of each)

- **Model, not backtest.** Entry IV is an RV proxy, not observed option prices.
- **Errors cluster on the short-put risk side** (the decision-relevant side): even with the
  state-dependent spike, (a) **American early assignment** is unmodeled and clusters on the
  deep-ITM losers → understates put tail; (b) **skew/term-structure** unmodeled (ATM mitigates);
  (c) the loser **spike** magnitude is itself a guess. All err rosy on the put tail → a put pass
  is a *data-spend gate*, never a trade green light.
- Call side: simplifications are neutral-to-conservative for calls, so the **call kill is
  trustworthy** (and the spike-aware entry IV strengthens it).
- Coil tape inherits the RSI-threshold reconstruction (signal-day-close fills, today's-universe
  survivorship, daily bars).
- P&L units differ by structure (return-on-premium vs return-on-collateral); compared by sign +
  the tail-risk ratio, not head-to-head magnitude. **r = 0.04 flat is immaterial** (not swept).
  ATM is the max-premium/max-assignment aggressive screen; **strike is the next sweep axis only
  if puts survive**.
- Off the fleet's uncorrelated-ballast thesis regardless of result; flagged in RESULTS.

## Brainstorm + review decisions (traceability)

1. Scope = lightweight feasibility model (surface + kill-rule), not pre-registered.
2. Entry IV = data-grounded **spike-aware** (5-day RV primary) × swept premium {0.8–1.5}.
3. Structures = long ATM call (mirror-exit) + short ATM put (hold-to-expiry primary + mirror).
4. Review-driven (all corners cut land on the put tail → asymmetric trust): **state-dependent
   exit IV** (crush up / **spike down**) replacing flat crush; **spike-aware entry IV** (5-day) +
   premium <1.0; **hold-to-expiry CSP** to stop surrendering theta; **band-not-cell + tail-as-
   precondition + risk-adjusted-vs-stock** put green-light; explicit **American-assignment ceiling**
   (put pass = buy data, not trade). Call kill stays the cheap reliable one-sided screen.
