# Drift Earnings-Timing Inference (Vendor-Free) + Clean-Read Replay Re-Run — Design

**Created:** 2026-05-30
**Status:** Approved (design) — revised after external design review; ready for implementation plan
**Agent:** Drift (`drift` / strategy `earnings-drift`)
**Builds on:**
- `docs/superpowers/specs/2026-05-29-drift-continuation-entry-path-design.md` (the rule)
- `docs/superpowers/specs/2026-05-30-drift-continuation-expectancy-replay-design.md` (the replay)

**Revised after external design review (2026-05-30):** a wrong inference silently
reintroduces the bug this project exists to kill, and one failure mode is correlated
with Drift's own population. The revision (a) narrows the "near-tie is harmless"
claim to the both-*small* case and documents the both-*large* exposure, (b) adds a
threshold-free **confidence ratio** covariate to telemetry, (c) **pre-registers** the
verdict-gate cutoffs before the re-run, (d) splits a fourth provenance
`inferred_fallback` so fallback-to-AMC is never read as a positive determination,
(e) adds a wrong-anchor-date caveat, (f) frames new-`n` and cohort-composition churn
as primary outputs, (g) guards gap numerators (not just denominators), and (h) adds
a window-start invariant test. See the inline notes tagged **[review]**.

---

## Problem

Drift's post-earnings gap is direction-and-timing sensitive. `computeDriftGap` and
`computeDriftContinuation` (`services/drift_signal_service.go`) both branch on the
earnings **timing** field:

- **BMO** (before market open): the reaction is the `close[E-1] → open[E]` overnight
  gap; the gap bar is `E` (the earnings-date bar itself).
- **AMC / unknown** (after market close): the reaction is the `close[E] → open[E+1]`
  overnight gap; the gap bar is `E+1`.

After FMP's `/stable` migration, **neither `/stable/earnings` (per-symbol) nor
`/stable/earnings-calendar` returns a bmo/amc field** (verified false on our tier;
legacy `/api/v3/earning_calendar` is HTTP 403 for post-Aug-2025 subscribers — a
standing "do not re-investigate" decision). So `timing` is empty for **every** name,
and the else-branch treats all of them as AMC. For a name that actually reported
**BMO**, this mis-indexes the gap bar by one trading day: the code measures
`open[E+1]/close[E]` (the *non-event* overnight *after* the reaction) instead of
`open[E]/close[E-1]` (the reaction itself), and `computeDriftContinuation` then
references `gapBarIdx = E+1` — exactly the bar the higher-high confirm leans on.

This is a **live production defect** in `computeDriftGap` independent of the
continuation question. It also confounds the 2026-05-30 expectancy replay, whose
verdict (continuation +1.5% / PF 1.42 vs base-gates-only control +5.5% / PF 3.90 →
friction-adjusted marginal edge **−3.93%**) was computed with `timing fill: bmo=0
amc=0 unknown=959` — i.e. on partly-dirty bars for whichever cohort names actually
reported BMO. The −3.9% cannot be trusted as a clean read until timing is correct.

## Goal

A **vendor-free** fix that infers bmo/amc from price action and applies it to both
the live signal path and the offline replay, then a **clean-read re-run** of the
expectancy replay that quantifies how exposed the −3.9% verdict was to the
mis-indexing. Deliverables:

1. `inferDriftTiming` — a pure helper that resolves unknown timing to bmo/amc from
   the two candidate overnight gaps, returning a **confidence ratio** and a
   **measured** flag.
2. Live wiring behind `DRIFT_INFER_TIMING` (default **ON**), fixing
   `computeDriftGap` / `computeDriftContinuation` for live Drift.
3. Replay wiring (always-infer), plus telemetry that surfaces the inferred BMO/AMC
   split **and its confidence distribution** live (per-scan) and offline (per-cohort).
4. A re-run of `cmd/driftreplay` on the clean read and a written verdict, decided
   against **pre-registered** cutoffs, that gates whether to proceed to a (separate,
   future) base-gates-only entry-path spec.

### Why inference (rejected alternatives)

- **Source the field from FMP** — verified unavailable on our tier (above). Rejected.
- **Assume AMC for all (status quo)** — the defect itself. Rejected.
- **Assume BMO for all** — symmetric defect; mega-caps split both ways. Rejected.
- **Infer from price action** — earnings release *outside* market hours, so the
  reaction is, by construction, an overnight gap, and it dwarfs an ordinary overnight
  move. The larger of the two candidate overnight gaps is the reaction. Vendor-free,
  deterministic, testable. **Chosen** — with its confidence surfaced, not assumed.

---

## Non-goals (explicit YAGNI)

- **A tuned dominance threshold / abstain band in the live rule.** The inference is a
  bare larger-gap-wins comparison with no tunable factor; baking a cutoff into the
  rule is the parameter-tuning the replay spec's non-goals forbid. **[review]** The
  confidence *ratio* we add is a continuous covariate for after-the-fact diagnosis,
  **not** a gate on the rule — it changes no entry decision.
- **Intraday / whole-day reaction models.** Daily overnight gaps only; the overnight
  gap is the cleanest reaction signal precisely because earnings land outside hours.
- **Volume confirmation of the inferred gap bar.** Noted as a possible future
  defense against wrong-anchor dates (risk #5), not built here.
- **The base-gates-only entry path.** This project produces the clean read that
  *gates* that decision against pre-registered cutoffs; it does not build it.
- **Changing the continuation rule, `ENABLE_DRIFT_CONTINUATION` (stays OFF), the
  enumeration window, the anti-chase guard, or `ENABLE_DRIFT_WARMER`.**
- **Changing `ComputeDriftSignal`'s signature** (and thus its ~15 test call sites).
  Timing is resolved at the call boundary and passed in.

---

## Design

### Component 1 — `inferDriftTiming` (pure, with confidence)

In `services/drift_signal_service.go`, near `computeDriftGap`:

```go
// driftTimingRatioCap is the finite ceiling for the confidence ratio when the
// losing-side gap is exactly flat (ratio would be +Inf). A finite cap keeps the
// value JSON-serializable — encoding/json rejects Inf/NaN, and the ratio rides on
// both DriftSignal (API/logs) and TradeOutcome (replay JSON sidecar).
const driftTimingRatioCap = 999.0

// driftTimingInference is the result of price-action timing inference.
//   Regime   — "bmo" | "amc" (best effort even when not fully measured)
//   Ratio    — winning/losing overnight-gap magnitude (>= 1); driftTimingRatioCap
//              when the losing side is exactly flat; 0 when not two-sided-measured
//   Measured — true ONLY when BOTH candidate gaps were computable from positive
//              prices and at least one is non-zero. False => a fallback (edge /
//              degenerate / one-sided), surfaced distinctly in telemetry.
type driftTimingInference struct {
    Regime   string
    Ratio    float64
    Measured bool
}

// inferDriftTiming infers BMO vs AMC from price action. Earnings release outside
// market hours, so the reaction is an overnight gap: BMO => close[E-1]→open[E];
// AMC => close[E]→open[E+1]. The larger-magnitude gap wins; an exact tie keeps AMC
// (the historical default) and shows Ratio==1. [review] All FOUR prices in the two
// ratios must be positive (numerators too, not just denominators) — a zero open
// would yield |0/close - 1| = 1.0, a spurious 100% gap that would wrongly win.
// Bars are oldest-first. Never panics.
func inferDriftTiming(bars []*interfaces.Bar, earningsDate string) driftTimingInference {
    idx := findBarIndexByDate(bars, earningsDate)
    if idx < 0 {
        return driftTimingInference{Regime: "amc"} // not measured
    }
    haveBMO := idx >= 1 && bars[idx-1].Close > 0 && bars[idx].Open > 0
    haveAMC := idx+1 < len(bars) && bars[idx].Close > 0 && bars[idx+1].Open > 0
    switch {
    case haveBMO && haveAMC:
        gBMO := math.Abs(bars[idx].Open/bars[idx-1].Close - 1.0)
        gAMC := math.Abs(bars[idx+1].Open/bars[idx].Close - 1.0)
        regime, hi, lo := "amc", gAMC, gBMO
        if gBMO > gAMC { // strict: exact tie resolves AMC
            regime, hi, lo = "bmo", gBMO, gAMC
        }
        switch {
        case lo > 0:
            return driftTimingInference{Regime: regime, Ratio: hi / lo, Measured: true}
        case hi > 0:
            return driftTimingInference{Regime: regime, Ratio: driftTimingRatioCap, Measured: true}
        default: // both gaps exactly flat — no reaction either side
            return driftTimingInference{Regime: "amc"} // not measured
        }
    case haveBMO: // only the BMO gap is measurable (idx+1 absent/degenerate)
        return driftTimingInference{Regime: "bmo"} // not measured (one-sided)
    default:
        return driftTimingInference{Regime: "amc"} // not measured
    }
}
```

### Component 2 — `resolveDriftTiming` (boundary resolver + provenance)

Keeps `ComputeDriftSignal` pure (signature unchanged). Used by both the live and
replay boundaries:

```go
// DriftTimingResolution: the resolved regime plus provenance and confidence.
//   Source ∈ {"vendor","inferred","inferred_fallback","unknown"}.
//   [review] "inferred_fallback" is the FOURTH provenance: inference ran but could
//   not measure both gaps (edge/degenerate/one-sided), so the regime is a best-effort
//   fallback (kept AMC unless only the BMO side was measurable) — NOT a positive
//   determination. Splitting it out keeps "inferred AMC" from masking residual bug.
type DriftTimingResolution struct {
    Timing string  // "bmo"|"amc"|""   ("" = unknown when inference disabled)
    Source string
    Ratio  float64 // winning/losing gap ratio for "inferred"; 0 otherwise
}

func resolveDriftTiming(bars []*interfaces.Bar, earningsDate, vendorTiming string, inferEnabled bool) DriftTimingResolution {
    t := strings.ToLower(strings.TrimSpace(vendorTiming))
    if t == "bmo" || t == "amc" {
        return DriftTimingResolution{Timing: t, Source: "vendor"}
    }
    if !inferEnabled {
        return DriftTimingResolution{Timing: t, Source: "unknown"} // "" → legacy AMC-default downstream
    }
    inf := inferDriftTiming(bars, earningsDate)
    src := "inferred"
    if !inf.Measured {
        src = "inferred_fallback"
    }
    return DriftTimingResolution{Timing: inf.Regime, Source: src, Ratio: inf.Ratio}
}
```

### Component 3 — Live wiring (`DriftSignalService.GetSignal`)

`DriftSignalService` gains an `inferTimingEnabled bool` field (default true).
`GetSignal` (`drift_signal_service.go:673`) — the single choke point every live
candidate flows through (the candidate scan at :856 and `GetSignalForTicker` at
:966 both call it) — resolves timing **after** fetching bars and **before** calling
`ComputeDriftSignal`, so `computeDriftGap` and `computeDriftContinuation` see the
same corrected gap bar:

```go
// inside GetSignal, after bars are fetched and validated:
res := resolveDriftTiming(bars, earningsDate, timing, s.inferTimingEnabled)
sig := ComputeDriftSignal(symbol, bars, earningsDate, res.Timing)
sig.TimingSource = res.Source
sig.TimingInferRatio = res.Ratio
return sig, nil
```

`ComputeDriftSignal` continues to set `EarningsTiming: res.Timing` (now the resolved
value). Provenance/confidence live on the new `TimingSource` / `TimingInferRatio`
signal fields.

### Component 4 — Flag (`DRIFT_INFER_TIMING`, default ON)

- `config/config.go`: `EnableDriftInferTiming: getEnvOrDefault("DRIFT_INFER_TIMING", "true") != "false"` (default ON; note `!= "false"` for default-true vs the continuation flag's `== "true"` for default-false).
- `cmd/bot/main.go`: set `inferTimingEnabled` on the constructed `DriftSignalService` from that config field, alongside the existing Drift wiring.
- `.env.example`: add a commented `# DRIFT_INFER_TIMING=true` near `ENABLE_DRIFT_CONTINUATION`, noting OFF reverts to the legacy AMC-default exactly.
- The offline replay does **not** read this flag — it always infers.

### Component 5 — Replay wiring (`RunReplay`, always-infer)

`RunReplay` (`drift_replay.go:520`) resolves timing **once per event** from the
symbol's full bar window before `findEntries`:

```go
edate := e.date.Format("2006-01-02")
// ... existing earnings-in-bars guard ...
res := resolveDriftTiming(bars, edate, e.timing, true) // always infer offline
cov.TimingFill[res.Timing]++                           // resolved regime, post-guard
dep, ctrl := findEntries(sym, bars, edate, res.Timing, driftReplayWindowCalDays)
// res.Source / res.Ratio recorded on each resulting TradeOutcome (below)
```

The existing `cov.TimingFill[r.Timing]++` in the in-universe grouping loop
(`drift_replay.go:547`, currently tallying the raw all-`""` timings) is **removed** so
the count is not double-incremented; `TimingFill` is now tallied here per event after
the earnings-in-bars guard, on the resolved regime. Inference is deterministic across
the point-in-time slices `findEntries` feeds `ComputeDriftSignal` (it reads only the
earnings reaction bars `E-1,E,E+1`, present in every slice that reaches evaluation day
`d ≥ E+1`), so resolving once upfront equals resolving per-day. `TradeOutcome` gains
`Timing string`, `TimingSource string`, and `TimingInferRatio float64` so the report
can split and confidence-weight by cohort.

### Component 6 — Telemetry

**Signal struct:** `DriftSignal` gains `TimingSource string`
(`"vendor"|"inferred"|"inferred_fallback"|"unknown"`) and `TimingInferRatio float64`.
`EarningsTiming` carries the resolved regime.

**Live shadow logs (`drift_signal_service.go`):**
- `"drift: would-be continuation entry"` already logs `"timing": sig.EarningsTiming`
  (now resolved) — add `"timing_source": sig.TimingSource` and
  `"timing_infer_ratio": sig.TimingInferRatio`. Because this line is per-name, the
  live confidence *distribution* is reconstructable offline from these lines without
  cramming it into one summary line.
- `"drift: candidate scan summary"` gains `inferred_bmo` / `inferred_amc` /
  `inferred_fallback` counters (over `scoredOK` names, keyed on `sig.EarningsTiming`
  / `sig.TimingSource`), so the live BMO/AMC split **and the residual-fallback count**
  are visible per scan without enabling anything.

**Replay report (`cmd/driftreplay/main.go` + `drift_replay.go`):**
- `Coverage.TimingFill` reports `bmo=N amc=M` (resolved) instead of `unknown=959`,
  plus an `inferred_fallback` count.
- `ReplaySummary` gains, per cohort: the BMO/AMC entry split, the count of
  `inferred_fallback` entries, and the **confidence-ratio distribution** (min /
  median / max, and a count of near-ties — `ratio < 1.5` reported descriptively, not
  as a gate). **[review]** This is the instrument for risk #1: it says how many
  entries sat on a confident call vs a coin-flip and whether close calls cluster in
  the deployed cohort.
- **[review] Composition is a headline output (risk #6).** The report states the new
  `n` per cohort and is read against the prior dirty run's 26/32; the count of
  deployed entries that are **inferred-BMO** (the cohort whose gap bar the old run
  mis-indexed) is reported prominently. A large composition delta is itself a finding,
  reportable before any expectancy number.

### Component 7 — The re-run (data flow / deliverable)

**Preserve the baseline first.** The prior dirty-read artifacts are dated today
(`data/reports/drift-continuation-replay-2026-05-30.{md,json}`); the CLI names output
by run date, so a same-day re-run would overwrite them. Before re-running, rename the
existing pair to `…-2026-05-30-amc-default.{md,json}` so the clean read writes fresh
and the old↔new comparison (risk #6) is preserved.

1. Land the fix on local main (one squashed commit; TDD; build + suite green).
2. Rename the dirty artifacts (above); `go run ./cmd/driftreplay --years 3` → a fresh
   `data/reports/drift-continuation-replay-<rundate>.md` (+ `.json`), on clean bars
   with the timing split, confidence distribution, and composition counts.
3. Read, **in this order (risk #6 — composition before expectancy):** new `n` and
   cohort composition vs the old 26/32; the inferred BMO/AMC split and how many
   deployed entries are inferred-BMO; the confidence-ratio distribution (are close
   calls clustered in deployed?); only then the clean friction-adjusted marginal edge
   and profit factors.

4. **Verdict gate — PRE-REGISTERED (risk #3; all on FRICTION-adjusted numbers).**
   Let `M` = clean friction-adjusted marginal edge (deployed − control expectancy %),
   `Ec` = control friction-adjusted expectancy %/trade, `PF_c` / `PF_d` = control /
   deployed profit factors, `n_d` / `n_c` = deployed / control entry counts. The gate
   separates two distinct questions: **is base-only worth building** (absolute control
   strength — the build driver) and **is continuation a chase** (the marginal — a
   confirmation, not the driver). Cutoffs fixed **before** the run; the branches are
   mutually exclusive and exhaustive, with strict inequalities so every boundary value
   falls to Inconclusive.

   **Precondition (risk #6 — no gate on sand):** if `n_d < 20` **or** `n_c < 20`, the
   result is **Inconclusive** regardless of `M`/`PF`/`Ec`, and the move is to extend
   the universe history (more years / broader names), **not** to spec or enable
   anything. A precise-looking gate applied to tens of trades launders noise into a
   terminal decision, and the gate is least reliable exactly when a small sample is
   most likely to throw an extreme `M` that trips a branch decisively.

   With the sample floor met, exactly one branch fires:
   - **Proceed to spec a base-gates-only entry path** iff ALL hold: `Ec > +3.0%`
     **and** `PF_c > 2.0` (base-only is good in **absolute** terms — the primary
     driver) **and** `M < −2.0%` (continuation **confirmed** to subtract — the
     marginal as confirmation). **[review]** The `PF_c`/`PF_d` spread is **reported as
     confirmation, not gated**: a ratio test is satisfiable by the deployed cohort
     merely deteriorating, which is not evidence that base-only is worth building —
     the build case rests on base-only's standalone strength (`Ec`, `PF_c`), and `M`
     answers the separate "is continuation a chase" question.
   - **Continuation is not the culprit** iff `M > +1.0%`. (The bug carried most of the
     −3.9%; continuation is roughly neutral-or-better vs control on clean bars.
     Whether to *then* enable continuation is a separate question needing positive
     absolute **deployed** expectancy — out of scope here.)
   - **Inconclusive — do not spec, do not enable** in every other case: the dead band
     `−2.0% ≤ M ≤ +1.0%`; **or** `M < −2.0%` but base-only is not absolutely strong
     enough (`Ec ≤ +3.0%` or `PF_c ≤ 2.0`) — i.e. continuation looks like a chase but
     the alternative is not worth building either; **or** any value sitting exactly on
     a cutoff.

   **Ordering (risk #3 smaller note):** Inconclusive is the most conservative outcome
   (do not spec, do not enable), Proceed the least; because Proceed and Not-the-culprit
   use strict inequalities, any value landing exactly on a cutoff (`Ec = +3.0%`,
   `PF_c = 2.0`, `M = −2.0%`, `M = +1.0%`, `n = 20`) resolves to Inconclusive. The
   confidence-ratio distribution from step 3 is interpretive context for a borderline
   result, **not** an additional cutoff. The cutoff *values* themselves
   (`+3.0%`, `2.0`, `−2.0%`, `+1.0%`, `n ≥ 20`) price the cost of an enabled
   negative-edge entry path against the cost of delay, and are the human's to own —
   not validated by review.
5. Live: rebuild `prophet_bot.exe` from local main. The corrected `computeDriftGap`
   changes shadow candidate visibility immediately; it affects live trades only once
   `ENABLE_DRIFT_CONTINUATION` is later enabled.

---

## Lookahead-bias guards (must hold in the replay)

1. Let `E` be the earnings-bar index. `inferDriftTiming` reads only `E-1, E, E+1`. In
   `findEntries` the evaluation day `d` ranges over `d ≥ E+1`, and the entry fills at
   `d+1 ≥ E+2`; the reaction bars `E-1,E,E+1` therefore all precede every entry and
   are known by evaluation time — not forward leak. Because those three bars are
   present and identical in every point-in-time slice `bars[:d+1]` with `d ≥ E+1`,
   resolving the regime once from the full window yields exactly what a per-day
   resolution would, with no bar later than `d` influencing day `d`'s
   signal-of-record.
2. **[review] Window-start invariant.** The resolve-once/per-day equivalence depends
   on `findEntries` never evaluating a day earlier than `E+1`. A test pins this: if
   the entry window start ever moves to `E`, the slice `bars[:E+1]` would not contain
   `E+1`, the per-day inference would diverge from the once-resolved value, and the
   test fails — so a future window change cannot silently turn the timing read into a
   lookahead leak.
3. All existing replay guards (signal on `bars[:idxD+1]`, entry at `open[entryIdx]`,
   EOD exits at `open[i+1]`, earnings-in-slice) are unchanged.

---

## Files

**Modified:**
```
services/drift_signal_service.go   inferDriftTiming (+ratio/measured), resolveDriftTiming,
                                   GetSignal resolution, DriftSignal.TimingSource +
                                   .TimingInferRatio, three shadow-log field additions
                                   (incl. inferred_bmo/amc/fallback counters),
                                   inferTimingEnabled field
services/drift_replay.go           resolve in RunReplay, TradeOutcome.Timing/TimingSource/
                                   TimingInferRatio, per-cohort split + fallback count +
                                   ratio distribution in ReplaySummary/Coverage
cmd/driftreplay/main.go            render the timing split, fallback count, ratio
                                   distribution, composition counts (md) + JSON sidecar
config/config.go                   EnableDriftInferTiming (DRIFT_INFER_TIMING, default ON)
cmd/bot/main.go                    wire inferTimingEnabled onto DriftSignalService
.env.example                       document DRIFT_INFER_TIMING
services/drift_signal_service_test.go   inferDriftTiming, resolveDriftTiming, GetSignal-resolution tests
services/drift_replay_test.go      RunReplay resolved-timing + per-cohort split +
                                   window-start invariant tests
```

No new third-party dependencies. No change to the continuation rule, the trading
bot's behavior while `ENABLE_DRIFT_CONTINUATION` is OFF, or agent rules.

---

## Testing (TDD, `go test ./services/`)

**`inferDriftTiming` (pure, critical unit):**
- BMO-dominant (big `close[E-1]→open[E]`, flat next) → `bmo`, `Measured`, `Ratio>1`.
- AMC-dominant (flat `open[E]`, big `close[E]→open[E+1]`) → `amc`, `Measured`, `Ratio>1`.
- **[review] Both-large, follow-through exceeds reaction** (BMO name, `gAMC > gBMO`,
  both > 3%) → `amc`, `Measured`, `Ratio` near 1 — the directional mislabel made
  visible by a low ratio (documents risk #1, not "fixed").
- Exact tie (equal magnitudes) → `amc`, `Measured`, `Ratio == 1`.
- **[review] Numerator guard:** `open[E] == 0` must NOT yield a spurious 100% BMO gap;
  with `open[E]==0` the BMO side is unmeasurable → falls back (AMC / `!Measured`).
- `idx == 0` → `amc`, `!Measured`.
- `idx+1` absent but `idx ≥ 1` → `bmo`, `!Measured` (one-sided).
- both gaps exactly flat → `amc`, `!Measured`.
- earnings date not in bars → `amc`, `!Measured`.

**`resolveDriftTiming`:**
- vendor `bmo`/`amc`/`BMO` → respected, source `vendor`, ratio 0.
- unknown `""` + inferEnabled + measured → inferred regime, source `inferred`, ratio set.
- **[review]** unknown `""` + inferEnabled + `!Measured` → source `inferred_fallback`.
- unknown `""` + `!inferEnabled` → `("", "unknown", 0)` (legacy AMC-default preserved).

**`GetSignal` resolution (mock bar fetcher):**
- `inferTimingEnabled=true` + unknown on a BMO-shaped series → `sig.Gap` reflects the
  `E` (BMO) gap bar, `sig.EarningsTiming=="bmo"`, `sig.TimingSource=="inferred"`,
  `sig.TimingInferRatio>0`.
- `inferTimingEnabled=false` + unknown → AMC-convention gap (`E+1`),
  `sig.TimingSource=="unknown"` (regression: byte-for-byte the old behavior).
- explicit vendor `bmo` → unchanged, `sig.TimingSource=="vendor"`.

**Replay:**
- `RunReplay` records resolved timing/source/ratio in `Coverage`+`TradeOutcome`;
  per-cohort split, `inferred_fallback` count, and ratio summary aggregate correctly
  on a fixture mixing a BMO-shaped, an AMC-shaped, and a fallback name.
- **[review] Window-start invariant test** (guard #2): asserts `findEntries` evaluates
  no day before `E+1` (e.g. the earliest entry's `SignalIdx ≥ E+1`); fails if the
  window start regresses to `E`.

**Regression:** the entire existing Drift suite (`go test ./services/ -count=1`) and
`go build ./...` stay green. No existing test passes `timing=""`, so the inference
path is additive and cannot perturb them.

**Integration:** the `cmd/driftreplay` re-run is verified by one real offline run
(reviewing coverage, the timing split, the ratio distribution, and a sanity-checked
sample trade), per the existing replay spec's convention — not by automated CLI tests.

---

## Error handling / soft-fail

| Scenario | Behavior |
|---|---|
| earnings date not in bars (live or replay) | `inferDriftTiming` → `amc`, `!Measured`; live gap warns/soft-fails as today. |
| `idx == 0`, `idx+1` missing, one-sided | Deterministic fallback per Component 1; `Source=="inferred_fallback"`; never panics. |
| zero/negative price in a candidate gap | That side is unmeasurable (all four prices required positive) → fall back; never a spurious 100% gap. |
| `DRIFT_INFER_TIMING=false` | `resolveDriftTiming` → `("", "unknown")` → exact legacy AMC-default; a clean kill switch. |
| replay symbol soft-fail / earnings-not-in-bars | Unchanged — counted in `Coverage.Dropped` before resolution is reached. |

---

## Risks / honest caveats

1. **[review] The both-*large* near-tie is a real, population-correlated exposure.**
   The original "near-tie ⇒ both gaps small ⇒ dropped at the 3% gate" reasoning holds
   only for the both-*small* case. Two gaps can be close *and* both > 3%: a true BMO
   name whose day-after follow-through overnight (`close[E]→open[E+1]`) **exceeds** the
   reaction gap is mislabeled AMC and passes the gate. This is **directional**
   (BMO→AMC; an AMC name's `close[E-1]→open[E]` is a pre-announcement non-event,
   rarely large) and **correlated with Drift's population** (earnings-drift selects
   for strong continuation, i.e. large day-after gaps). It is not "fixed" by the rule;
   it is **measured** — the confidence ratio surfaces it (low ratio on an inferred-AMC
   name sitting on a large BMO-side gap is the suspicious signature), and the re-run
   reports how much of the deployed cohort sits on near-ties.
2. **[review] Inference cannot detect a wrong anchor date.** The heuristic assumes the
   reaction is one of the two overnights flanking FMP's reported earnings date. If
   that date is itself off by a day (revised/expected dates, timezone artifacts), both
   candidate gaps are non-reaction overnights and the larger noise gap wins — a
   confident-looking mislabel. The confidence ratio partially catches it (wrong-date
   names trend toward low ratios); volume confirmation of the gap bar is a possible
   future defense, out of scope here.
3. **The clean read is still survivorship-biased** (current `DriftUniverse`) and
   small-n — the re-run sharpens the bars, it does not turn a calibration read into a
   hypothesis test. The verdict language and the pre-registered cutoffs stay
   calibration-grade.
4. **[review] `n` and cohort composition will move, and that is an output.** Correcting
   BMO gap bars changes which days clear `gap ≥ 3%` and continuation, so names enter,
   exit, and switch cohorts. The composition delta vs the prior 26/32 is itself the
   headline exposure quantifier, reported before the expectancy numbers.
5. **Default-ON changes live shadow telemetry immediately.** Intended (a correctness
   fix), no live-trade impact while `ENABLE_DRIFT_CONTINUATION` is OFF, reversible via
   the flag without a rebuild.
6. **Resolved-timing changes both cohorts.** Corrected `GapPct` shifts the gate for the
   control cohort too — so the clean read is internally consistent (both cohorts on
   clean bars), not a one-sided adjustment.

---

## Rollout

- Land on local main as one squashed commit (rebuild-from-main deploy model).
- `DRIFT_INFER_TIMING` default ON: the fix is live on the next backend rebuild;
  `ENABLE_DRIFT_CONTINUATION` stays OFF (no live-trade behavior change today).
- Run `cmd/driftreplay` offline (after preserving the dirty baseline); the report is
  advisory — it gates, against the pre-registered cutoffs, the human decision on
  whether to spec the base-gates-only entry path. It auto-enables nothing.
- Kill switch: `DRIFT_INFER_TIMING=false` reverts live Drift to the legacy
  AMC-default exactly.
