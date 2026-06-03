# Coil Catalyst-Dip Underperformance — Historical Event Study (B) + Live Confirmation (A)

Date: 2026-06-03
Branch: `coil-catalyst-dip-event-study` (to be created)
Status: design — pending spec review → implementation plan.
Supersedes the earlier combined "live measurement with an n=30 gate" sketch, retired
after an external review (see "Why this shape").

## Context & goal

Coil is a mechanical RSI(2) mean-reversion agent over ~80 S&P 500 large-caps
(`services/meanrev_signal_service.go`), deliberately news-blind, already filtering
*scheduled* binary catalysts (earnings-within-5-days). It is blind to *unscheduled*
fundamental catalysts (equity raises, guidance cuts, downgrade clusters, M&A) — on
2026-06-03 it bought GOOGL as a textbook oversold dip while GOOGL was being repriced on a
$180B capex announcement + an $80B equity offering.

**The honest question** is not "block catalyst dips." It is: *do catalyst-driven oversold
dips actually underperform clean ones — and if so, is that an ENTRY-signal effect (which a
gate could act on) or an EXIT-rule artifact (catalyst dips revert slower, so the 5-day
timeout truncates their winners — which would indict the exit rule, not the entry)?*
Answer that **before** changing any behavior. A single losing trade (GOOGL) is not evidence;
mean reversion's best returns historically come from the scariest dips, so a naive filter
could shave the right tail.

## Why this shape (what the review changed)

The first sketch was a live, forward-collected measurement with a 30-closed-trade verdict
gate. An external review (and codebase verification) refuted that shape:

- **A forward verdict can't be powered.** Coil makes a handful of qualifying entries a week;
  in a fat-tailed RSI(2) return distribution you'd wait *years* for a CI tight enough to rule
  on a moderate effect. `n=30` near-guarantees a "no-effect" *failure to reject* regardless of
  truth — and the codebase's own trade-ledger already gates demonstrated edge on a **bootstrap
  CI**, with the explicit note that "a count floor can't tell edge from luck."
- **So the verdict comes from a HISTORICAL event study** over thousands of instances, reusing
  the stage1 lab stack already on `main`. A live instrument can only *confirm forward*, never
  *discover*.

Verified facts that shape the design:
- Bars are split/dividend **adjusted** (`alpaca_data.go:107,155` → `marketdata.All`) — historical
  splits won't fire false catalyst signals.
- The Foundation-B trade-ledger is a **report-time computation** over `managed_positions`, not a
  per-entry store — irrelevant to B (B reads bars + a catalyst table), relevant only to A.
- The stage1 program shipped reusable, FMP-free tooling to `main`: **Alpaca historical news
  fetch** + `classify_catalyst_strict` categorizer, **lookahead-guarded forward returns**
  (`stage1-bars`), **bootstrap CI** (`stage1-bootstrap`), and **pre-registration that bites**
  (`stage1-prereg` + `stage1-score`, hash-locked, scorer refuses on mismatch).

## Decisions (locked with user)

1. **Two items.** **B** (historical event study) carries the verdict. **A** (live instrument)
   is forward-confirmation, built **only if B returns SIGNAL**. The eventual *gate* is a third
   item, built only after A confirms B.
2. **Reuse the stage1 stack at the PRIMITIVE level** — FMP-free. Reusable as-is: `forwardReturn`
   (lookahead-safe `open[d+1]→close[d+H]`), `newsToSession` (point-in-time mapping), the bar-cache
   loader, the `buildPreregArtifact`/`verifyPrereg` hash-lock pattern, and `dateBlockBootstrap`.
   **NOT reusable as-is:** `stage1-score` tests a *single* signal's directional hit-rate vs a fixed
   null (HR₀, binomial) — B needs a **new two-sample scorer** comparing two buckets'
   *market-adjusted mean forward return* (difference, bootstrap CI on the difference, one-sided +
   equivalence). Instance generation (Coil's oversold-dip firing base) is also new — stage1's
   firings are catalyst-news events, a different base. No new FMP dependency (the project moved news
   off FMP; FMP starter has no historical news anyway).
6. **Two stacked increments.** **B1** = the price-signature event study (instance generation +
   price features + market-adjusted forward returns + the new two-sample scorer + prereg +
   feasibility) — all the new machinery, built first. **B2** = the news split (re-point the catalyst
   fetch at `MeanRevUniverse` + point-in-time news join, run the *same* scorer) stacked on B1.
7. **The B statistic** = two-sample difference of **market-adjusted mean forward return**
   (catalyst-like − clean), bootstrap CI on the difference, **one-sided** (catalyst worse),
   equivalence for NO-EFFECT. Continuous (effect-size-informative), not a hit-rate difference.
3. **Feasibility count first** (stage1's own first lesson) — kill/scope-down B before the powered
   test if the catalyst bucket is too thin.
4. **Both labels** — price-signature AND news — pre-registered, fixed-K Bonferroni.
5. **Report-only lab deliverable** under `docs/lab/` + `data/lab/`. Never edits rules.

## Architecture — the event-study harness (Node, + the reused Python catalyst fetch)

### 1. Instances (the firing base)
For each ticker in **Coil's** universe (`MeanRevUniverse`, ~80 names — *not* Prophet's
universe), over the historical window, enumerate every trading day where Coil's exact entry
condition fired: `RSI(2) < 5 AND close > SMA200 AND close < SMA5 AND not earnings-within-5d`.
Source of truth = the Go `ComputeMeanRevSignal` logic; the harness either calls a batch Go
endpoint over historical windows or replicates the RSI(2)/SMA arithmetic in JS **with a parity
test against the Go fixtures** (decided at planning). Measured over the **full unconditional
firing base** — never select instances near big moves (the stage1 cardinal-sin rule).

### 2. Labels
- **Price-signature** (deterministic, adjusted bars via `stage1-bars`): `gap_pct`,
  `prior_day_return`, `drawdown_5d`, `volume_ratio` (vs trailing 30-day avg), `range_zscore`,
  computed at the instance bar. A pre-registered cut splits "catalyst-like" vs "clean".
  Zero-volume/halt days are guarded (excluded or flagged, pre-registered) so the average and
  z-score don't degrade silently.
- **News** (point-in-time): join `(ticker, instance-date)` to the catalyst table built by
  `stage1_fetch_catalysts.py` (`classify_catalyst_strict` → `event_type`), counting **only**
  catalysts whose `published` timestamp **precedes the 15:45 ET entry** on the instance day,
  within a pre-registered look-back window (no look-ahead — #10). `event_type` grouped per
  pre-registration; **absence = `none`, which is a LOWER BOUND on true catalyst presence**
  (Alpaca coverage is incomplete — a `NO-EFFECT` on the news split can never be read as
  "catalysts don't matter" — #4).

### 3. Outcome (confound-controlled)
Lookahead-guarded forward returns at **+5 / +10 / +20 trading days** from entry
(`stage1-bars`), **independent of Coil's −7% / 5-day exit** — so the comparison measures the
entry signal, not the exit rule (#3). **Market-adjusted** (subtract the benchmark's same-window
return) to correct the direction-asymmetric survivorship of a today's-winners universe (the
lab's SP2 catch). The +5d horizon mirrors Coil's hold; **+10/+20d expose whether catalyst dips
merely revert *slower*** — which would indict the EXIT rule (→ a separate exit fix), not the
entry signal (→ a gate). Distinguishing those two is a primary output.

### 4. Pre-registration + scoring
`stage1-prereg` hash-locks — **before any outcome is seen** — the exact price cut, the news
grouping, the fixed test set and its `K`, the **one-sided** direction (hypothesis: catalyst =
*worse*), the **effect size** (minimum market-adjusted forward-return gap that would matter),
`alpha`, and the Bonferroni `K`. The forward-return **SD used for the power/effect-size calc
is itself pre-registered from a prior** (a conservative 5–8%/trade per-instance SD, or the
spread across all oversold dips in a reference window) — **never** estimated from this study's
own outcome population, so nothing downstream peeks at outcomes. `stage1-score` **refuses to run
on prereg mismatch**; `stage1-bootstrap` gives the CI on each bucket difference. Verdict per split:
- **SIGNAL** — one-sided CI excludes the null on the worse side past the pre-registered effect size.
- **NO-EFFECT** — *equivalence*: CI tight and within ±(effect size) of zero (rules a material
  effect out — not a mere failure to reject).
- **INSUFFICIENT** — CI too wide to do either (collect more / abandon; never "stay blind").

### 5. Feasibility gate (runs FIRST)
Before the powered test, count instances per bucket (reuse the `stage1_feasibility_count`
pattern). If the news-catalyst bucket can't reach adequate power for the pre-registered effect
size, B reports the news split as INSUFFICIENT up front and proceeds on the price split alone
(or stops) — decided by the count, before any scoring.

## Data flow

```
config (MeanRevUniverse) ─┐
                          ├─ instance enumeration (Go signal logic, full firing base)
adjusted bars (stage1-bars)┘            │
                                        ├─ price-signature label (deterministic features)
stage1_fetch_catalysts.py ── catalyst table ── point-in-time news label (published < entry)
                                        │
                                        ├─ lookahead-guarded, market-adjusted fwd returns +5/+10/+20
                                        ▼
              stage1-prereg (frozen) → feasibility count → stage1-score + stage1-bootstrap
                                        ▼
              docs/lab/coil-catalyst-dip-RESULTS.md  +  evidence under data/lab/
```

## Confound & validity controls (explicit)
| Risk | Control |
|---|---|
| Exit-rule confound (#3) | un-censored forward returns; +10/+20d separates "worse entry" from "slower revert" |
| Survivorship (lab SP2) | market-adjusted returns |
| Forking paths (#2) | frozen prereg, fixed-K Bonferroni, full unconditional firing base |
| Underpower / absence-of-evidence (#1) | CI/equivalence verdict, feasibility-first |
| News false-negatives (#4) | `none` is a lower bound; NO-EFFECT on news ≠ "catalysts don't matter" |
| Look-ahead (#10) | point-in-time `published < entry` filter; lookahead-guarded fwd returns |
| Window burn | 2022–2026 partly burned by stage1 → B is **discovery**, requires A's forward confirmation before any gate (the lab's mandatory-forward-confirmation rule) |

## Testing (TDD)
- Reused stage1 modules keep their existing tests green.
- New harness tests: instance-enumeration **parity vs the Go fixtures**; price-feature values on
  synthetic clean-vs-gap bars; **point-in-time news join** (a catalyst published *after* 15:45
  must NOT label the entry); market-adjustment math; feasibility count; prereg **hash-lock +
  scorer-refuses-on-mismatch**; verdict mapping for SIGNAL / NO-EFFECT / INSUFFICIENT on
  synthetic outcome sets.

## Conditional follow-on — A (live instrument), built ONLY if B = SIGNAL
A is the forward, out-of-sample confirmation that B's historical finding holds on Coil's *real*
realized trades (the lab's required forward-confirmation step):
- Go `CatalystFeatures` always-on, additive, on each `MeanRevSignal` (zero behavior change).
- A new `entry_features` table keyed by the **`managed_positions` id** (the row exists at entry —
  the natural stable join key), since the trade-ledger is report-time, not a per-entry store (#7).
- Lookahead-guarded forward-return capture on live trades + a reasoning-digest "accruing (CI=…)"
  panel; **no count gate** — it shows the live CI and only ever confirms/contradicts B.
The **gate** is a third item, designed only after A confirms B, and validated on held-out/forward
data (B's selected label is post-selection and upward-biased — #2).

## Out of scope (YAGNI)
- Any gate / entry suppression — only after B = SIGNAL **and** A confirms.
- A itself — unless B = SIGNAL.
- Non-Coil agents; short-side; intraday.

## Open items to pin during planning
- Instance source of truth: batch Go endpoint over historical windows vs JS replication + parity test.
- Catalyst fetch universe: re-point `stage1_fetch_catalysts.py` at `MeanRevUniverse` (or the union
  with Prophet's universe); confirm Alpaca news depth if extending earlier than 2022.
- Benchmark for market-adjustment (SPY vs equal-weight) — pre-register the choice.
- The frozen prereg values: exact price cut, news grouping, `K`, effect size, look-back window,
  benchmark — proposed at planning, then hash-locked via `stage1-prereg` before any scoring.
- Confirm `stage1-bars` exposes a reusable lookahead-guarded forward-return fn at +5/+10/+20d.
