# Drift Earnings-Timing Inference + Clean-Read Replay Re-Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Infer BMO/AMC earnings timing from price action (vendor-free), apply it to live Drift and the offline replay behind `DRIFT_INFER_TIMING` (default ON), surface inferred split + confidence in telemetry, then re-run the expectancy replay on clean bars and decide the pre-registered verdict gate.

**Architecture:** Two pure helpers (`inferDriftTiming`, `resolveDriftTiming`) resolve unknown timing at the call boundary — `DriftSignalService.GetSignal` (live) and `RunReplay` (replay) — so `computeDriftGap`/`computeDriftContinuation` see the corrected gap bar without changing `ComputeDriftSignal`'s signature. A confidence ratio and a fourth `inferred_fallback` provenance ride the signal and each replay outcome. The replay report gains the BMO/AMC split, fallback count, ratio distribution, and cohort composition.

**Tech Stack:** Go (`services`/`cmd`/`config` layout, sirupsen/logrus), `go test`, Alpaca daily bars via `SharedBarCache`, FMP per-symbol `/stable/earnings`.

**Spec:** `docs/superpowers/specs/2026-05-30-drift-timing-inference-design.md`

---

## File Structure

**Modified:**
- `services/drift_signal_service.go` — `driftTimingRatioCap`, `driftTimingInference`, `inferDriftTiming`, `DriftTimingResolution`, `resolveDriftTiming` (Task 1); `DriftSignal.TimingSource`/`.TimingInferRatio`, `DriftSignalService.inferTimingEnabled` + `SetInferTimingEnabled`, `GetSignal` resolution (Task 2); candidate-scan counters + log fields (Task 3).
- `services/drift_signal_service_test.go` — Tasks 1, 2 tests.
- `config/config.go` — `EnableDriftInferTiming` field + Load() population (Task 4).
- `cmd/bot/main.go` — wire `SetInferTimingEnabled` (Task 4).
- `.env.example` — document `DRIFT_INFER_TIMING` (Task 4).
- `services/drift_replay.go` — `TradeOutcome.Timing`/`.TimingSource`/`.TimingInferRatio`, `Coverage.TimingFallback`, `RunReplay` resolution (Task 5); `TimingBreakdown`, `ReplaySummary.DeployedTiming`/`.ControlTiming`, `Aggregate` split (Task 6).
- `services/drift_replay_test.go` — Tasks 5, 6, 8 tests.
- `cmd/driftreplay/main.go` — `renderMarkdown` timing split / fallback / ratio distribution / composition (Task 7).

**No new files. No new third-party dependencies.**

---

## Task 1: Pure timing-inference helpers

**Files:**
- Modify: `services/drift_signal_service.go`
- Test: `services/drift_signal_service_test.go`

- [ ] **Step 1: Write the failing tests**

Append to `services/drift_signal_service_test.go`. These reuse `driftBarRow` and `makeMonFriBars` (same package). A 6-row series puts the earnings bar at index 3 so both `E-1` and `E+1` exist.

```go
// timingBars builds a tiny oldest-first series with earnings at index `eIdx`.
// Each row is one Mon–Fri bar via makeMonFriBars.
func timingBars(rows []driftBarRow) []*interfaces.Bar { return makeMonFriBars(rows) }

func TestInferDriftTiming_BMODominant(t *testing.T) {
	// E at idx 3. close[2]=100 → open[3]=106 (gBMO=6%). close[3]=106 → open[4]=106.2 (gAMC≈0.19%).
	bars := timingBars([]driftBarRow{
		{Open: 99, High: 100, Low: 98, Close: 100, Vol: 1},   // 0
		{Open: 100, High: 101, Low: 99, Close: 100, Vol: 1},  // 1
		{Open: 100, High: 101, Low: 99, Close: 100, Vol: 1},  // 2  (E-1 close=100)
		{Open: 106, High: 107, Low: 105, Close: 106, Vol: 1}, // 3  (E: open 106)
		{Open: 106.2, High: 107, Low: 106, Close: 106.5, Vol: 1}, // 4 (E+1)
		{Open: 106.5, High: 107, Low: 106, Close: 106.5, Vol: 1}, // 5
	})
	edate := bars[3].Timestamp.UTC().Format("2006-01-02")
	got := inferDriftTiming(bars, edate)
	if got.Regime != "bmo" || !got.Measured {
		t.Fatalf("got %+v, want bmo/measured", got)
	}
	if got.Ratio < 5 {
		t.Errorf("ratio = %v, want >> 1 (6%% vs ~0.19%%)", got.Ratio)
	}
}

func TestInferDriftTiming_AMCDominant(t *testing.T) {
	// Flat into E, big gap AFTER E: close[3]=100 → open[4]=106 (gAMC=6%).
	bars := timingBars([]driftBarRow{
		{Open: 99, High: 100, Low: 98, Close: 100, Vol: 1},
		{Open: 100, High: 101, Low: 99, Close: 100, Vol: 1},
		{Open: 100, High: 101, Low: 99, Close: 100, Vol: 1},  // E-1
		{Open: 100, High: 101, Low: 99, Close: 100, Vol: 1},  // E (no morning gap)
		{Open: 106, High: 107, Low: 105, Close: 106, Vol: 1}, // E+1 (gap up)
		{Open: 106, High: 107, Low: 105, Close: 106, Vol: 1},
	})
	edate := bars[3].Timestamp.UTC().Format("2006-01-02")
	got := inferDriftTiming(bars, edate)
	if got.Regime != "amc" || !got.Measured {
		t.Fatalf("got %+v, want amc/measured", got)
	}
}

func TestInferDriftTiming_BothLargeFollowThroughExceeds_MislabelsAMC(t *testing.T) {
	// True BMO reaction +4% (close[2]=100→open[3]=104) but day-after +5%
	// (close[3]=104→open[4]=109.2). gAMC > gBMO → picks amc; documents risk #1.
	bars := timingBars([]driftBarRow{
		{Open: 99, High: 100, Low: 98, Close: 100, Vol: 1},
		{Open: 100, High: 101, Low: 99, Close: 100, Vol: 1},
		{Open: 100, High: 101, Low: 99, Close: 100, Vol: 1},   // E-1 close=100
		{Open: 104, High: 105, Low: 103, Close: 104, Vol: 1},  // E open=104 (gBMO=4%)
		{Open: 109.2, High: 110, Low: 108, Close: 109, Vol: 1},// E+1 open=109.2 (gAMC=5%)
		{Open: 109, High: 110, Low: 108, Close: 109, Vol: 1},
	})
	edate := bars[3].Timestamp.UTC().Format("2006-01-02")
	got := inferDriftTiming(bars, edate)
	if got.Regime != "amc" {
		t.Fatalf("got %+v, want amc (follow-through exceeded reaction)", got)
	}
	if got.Ratio > 2 {
		t.Errorf("ratio = %v, want near 1 (close call surfaces the exposure)", got.Ratio)
	}
}

func TestInferDriftTiming_ExactTieResolvesAMC(t *testing.T) {
	// gBMO == gAMC == 5%. Strict ">" keeps amc; ratio == 1.
	bars := timingBars([]driftBarRow{
		{Open: 100, High: 101, Low: 99, Close: 100, Vol: 1},
		{Open: 100, High: 101, Low: 99, Close: 100, Vol: 1},
		{Open: 100, High: 101, Low: 99, Close: 100, Vol: 1},  // E-1 close=100
		{Open: 105, High: 106, Low: 104, Close: 100, Vol: 1}, // E open=105 (gBMO=5%), close back to 100
		{Open: 105, High: 106, Low: 104, Close: 105, Vol: 1}, // E+1 open=105 (gAMC=5%)
		{Open: 105, High: 106, Low: 104, Close: 105, Vol: 1},
	})
	edate := bars[3].Timestamp.UTC().Format("2006-01-02")
	got := inferDriftTiming(bars, edate)
	if got.Regime != "amc" || !got.Measured {
		t.Fatalf("got %+v, want amc/measured", got)
	}
	if math.Abs(got.Ratio-1.0) > 1e-9 {
		t.Errorf("ratio = %v, want 1.0 (exact tie)", got.Ratio)
	}
}

func TestInferDriftTiming_ZeroOpenNumeratorGuard(t *testing.T) {
	// open[E]==0 must NOT yield a spurious |0/100-1|=1.0 (100%) BMO gap. BMO side
	// is unmeasurable → fall back (amc here, since gAMC is measurable).
	bars := timingBars([]driftBarRow{
		{Open: 100, High: 101, Low: 99, Close: 100, Vol: 1},
		{Open: 100, High: 101, Low: 99, Close: 100, Vol: 1},
		{Open: 100, High: 101, Low: 99, Close: 100, Vol: 1},  // E-1
		{Open: 0, High: 101, Low: 0, Close: 100, Vol: 1},     // E open==0 (degenerate)
		{Open: 103, High: 104, Low: 102, Close: 103, Vol: 1}, // E+1
		{Open: 103, High: 104, Low: 102, Close: 103, Vol: 1},
	})
	edate := bars[3].Timestamp.UTC().Format("2006-01-02")
	got := inferDriftTiming(bars, edate)
	if got.Regime != "amc" {
		t.Fatalf("got %+v, want amc (BMO side unmeasurable, not a spurious 100%% gap)", got)
	}
}

func TestInferDriftTiming_EdgeFallbacks(t *testing.T) {
	bars := timingBars([]driftBarRow{
		{Open: 100, High: 101, Low: 99, Close: 100, Vol: 1}, // 0 (E at idx 0: no E-1)
		{Open: 100, High: 101, Low: 99, Close: 100, Vol: 1},
		{Open: 100, High: 101, Low: 99, Close: 100, Vol: 1},
	})
	if got := inferDriftTiming(bars, bars[0].Timestamp.UTC().Format("2006-01-02")); got.Regime != "amc" || got.Measured {
		t.Errorf("idx==0: got %+v, want amc/!measured", got)
	}
	// E at last index: no E+1 → only BMO measurable → bmo/!measured.
	last := len(bars) - 1
	if got := inferDriftTiming(bars, bars[last].Timestamp.UTC().Format("2006-01-02")); got.Regime != "bmo" || got.Measured {
		t.Errorf("idx==last: got %+v, want bmo/!measured", got)
	}
	// earnings date not in bars.
	if got := inferDriftTiming(bars, "1990-01-01"); got.Regime != "amc" || got.Measured {
		t.Errorf("not-in-bars: got %+v, want amc/!measured", got)
	}
}

func TestResolveDriftTiming_Provenance(t *testing.T) {
	bars := timingBars([]driftBarRow{
		{Open: 100, High: 101, Low: 99, Close: 100, Vol: 1},
		{Open: 100, High: 101, Low: 99, Close: 100, Vol: 1},
		{Open: 100, High: 101, Low: 99, Close: 100, Vol: 1},  // E-1
		{Open: 106, High: 107, Low: 105, Close: 106, Vol: 1}, // E (gBMO=6%)
		{Open: 106.2, High: 107, Low: 106, Close: 106.5, Vol: 1},
		{Open: 106.5, High: 107, Low: 106, Close: 106.5, Vol: 1},
	})
	edate := bars[3].Timestamp.UTC().Format("2006-01-02")

	if r := resolveDriftTiming(bars, edate, "BMO", true); r.Timing != "bmo" || r.Source != "vendor" {
		t.Errorf("vendor: got %+v, want bmo/vendor", r)
	}
	if r := resolveDriftTiming(bars, edate, "", true); r.Timing != "bmo" || r.Source != "inferred" || r.Ratio <= 1 {
		t.Errorf("inferred: got %+v, want bmo/inferred/ratio>1", r)
	}
	if r := resolveDriftTiming(bars, edate, "", false); r.Timing != "" || r.Source != "unknown" {
		t.Errorf("disabled: got %+v, want \"\"/unknown", r)
	}
	// Fallback: earnings on last bar (no E+1) → inferred_fallback.
	last := bars[len(bars)-1].Timestamp.UTC().Format("2006-01-02")
	if r := resolveDriftTiming(bars, last, "", true); r.Source != "inferred_fallback" {
		t.Errorf("fallback: got %+v, want inferred_fallback", r)
	}
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `go test ./services/ -run "TestInferDriftTiming|TestResolveDriftTiming"`
Expected: FAIL — `inferDriftTiming` / `resolveDriftTiming` / `driftTimingInference` / `DriftTimingResolution` undefined.

- [ ] **Step 3: Implement the helpers**

In `services/drift_signal_service.go`, immediately after `computeDriftGap` (ends at the `}` on line ~123, before `roundTo2`), insert:

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
//              prices and at least one is non-zero.
type driftTimingInference struct {
	Regime   string
	Ratio    float64
	Measured bool
}

// inferDriftTiming infers BMO vs AMC from price action. Earnings release outside
// market hours, so the reaction is an overnight gap: BMO => close[E-1]→open[E];
// AMC => close[E]→open[E+1]. The larger-magnitude gap wins; an exact tie keeps AMC
// (the historical default) and shows Ratio==1. All FOUR prices in the two ratios
// must be positive (numerators too) — a zero open would yield |0/close-1|=1.0, a
// spurious 100% gap that would wrongly win. Bars are oldest-first. Never panics.
func inferDriftTiming(bars []*interfaces.Bar, earningsDate string) driftTimingInference {
	idx := findBarIndexByDate(bars, earningsDate)
	if idx < 0 {
		return driftTimingInference{Regime: "amc"}
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
			return driftTimingInference{Regime: "amc"}
		}
	case haveBMO:
		return driftTimingInference{Regime: "bmo"} // one-sided, not measured
	default:
		return driftTimingInference{Regime: "amc"}
	}
}

// DriftTimingResolution is the resolved regime plus provenance and confidence.
// Source ∈ {"vendor","inferred","inferred_fallback","unknown"}. "inferred_fallback"
// means inference ran but could not measure both gaps (edge/degenerate/one-sided),
// so the regime is a best-effort fallback — NOT a positive determination.
type DriftTimingResolution struct {
	Timing string
	Source string
	Ratio  float64
}

// resolveDriftTiming maps a (possibly empty) vendor timing to a concrete regime
// plus provenance. When inference is disabled and timing is unknown it returns
// ("", "unknown", 0) — preserving the legacy AMC-default behavior downstream.
func resolveDriftTiming(bars []*interfaces.Bar, earningsDate, vendorTiming string, inferEnabled bool) DriftTimingResolution {
	t := strings.ToLower(strings.TrimSpace(vendorTiming))
	if t == "bmo" || t == "amc" {
		return DriftTimingResolution{Timing: t, Source: "vendor"}
	}
	if !inferEnabled {
		return DriftTimingResolution{Timing: t, Source: "unknown"}
	}
	inf := inferDriftTiming(bars, earningsDate)
	src := "inferred"
	if !inf.Measured {
		src = "inferred_fallback"
	}
	return DriftTimingResolution{Timing: inf.Regime, Source: src, Ratio: inf.Ratio}
}
```

`math` and `strings` are already imported in this file.

- [ ] **Step 4: Run to verify they pass**

Run: `go test ./services/ -run "TestInferDriftTiming|TestResolveDriftTiming" -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add services/drift_signal_service.go services/drift_signal_service_test.go
git commit -m "feat(drift): vendor-free earnings-timing inference helpers"
```

---

## Task 2: Signal fields + live `GetSignal` resolution

**Files:**
- Modify: `services/drift_signal_service.go`
- Test: `services/drift_signal_service_test.go`

- [ ] **Step 1: Write the failing tests**

Append to `services/drift_signal_service_test.go`. Mirrors the existing 220-bar harness (test at line 438): BMO +6% gap at idx 215.

```go
// buildBMOGapBars builds a 220-bar grade-A/B series with a BMO +6% gap at idx 215
// (the morning open gaps; the day-after overnight is small), so inference resolves
// "bmo". Mirrors TestDriftSignalService_ComputesSignal's construction.
func buildBMOGapBars() ([]*interfaces.Bar, int) {
	rows := make([]driftBarRow, 220)
	for i := 0; i < 200; i++ {
		rows[i] = driftBarRow{Open: 100, High: 100.5, Low: 99.5, Close: 100, Vol: 100_000}
	}
	for i := 200; i < 215; i++ {
		c := 100 + 0.4*float64(i-199)
		rows[i] = driftBarRow{Open: c - 0.2, High: c + 0.2, Low: c - 0.3, Close: c, Vol: 100_000}
	}
	eIdx := 215
	prev := rows[eIdx-1].Close
	rows[eIdx] = driftBarRow{Open: prev * 1.06, High: prev*1.06 + 1, Low: prev * 1.05, Close: prev*1.06 + 0.5, Vol: 200_000}
	for i := eIdx + 1; i < 220; i++ {
		c := rows[i-1].Close + 0.3
		rows[i] = driftBarRow{Open: c - 0.1, High: c + 0.5, Low: c - 0.2, Close: c, Vol: 200_000}
	}
	return makeMonFriBars(rows), eIdx
}

func TestGetSignal_InfersUnknownTimingWhenEnabled(t *testing.T) {
	bars, eIdx := buildBMOGapBars()
	svc := NewDriftSignalService(&stubDriftBarFetcherSvc{bars: map[string][]*interfaces.Bar{"TEST": bars}})
	// default ON via constructor; be explicit for the test:
	svc.SetInferTimingEnabled(true)
	edate := bars[eIdx].Timestamp.Format("2006-01-02")

	sig, err := svc.GetSignal(context.Background(), "TEST", edate, "") // unknown timing
	if err != nil {
		t.Fatalf("GetSignal err = %v", err)
	}
	if sig.TimingSource != "inferred" {
		t.Errorf("TimingSource = %q, want inferred", sig.TimingSource)
	}
	if sig.EarningsTiming != "bmo" {
		t.Errorf("EarningsTiming = %q, want bmo (resolved)", sig.EarningsTiming)
	}
	if sig.TimingInferRatio <= 1 {
		t.Errorf("TimingInferRatio = %v, want > 1", sig.TimingInferRatio)
	}
	// BMO resolution => gap bar is E itself => the constructed 6% gap is detected.
	if sig.Gap.Score < 70 {
		t.Errorf("gap score = %v, want ≥70 (6%% BMO gap seen)", sig.Gap.Score)
	}
}

func TestGetSignal_DisabledKeepsLegacyAMCDefault(t *testing.T) {
	bars, eIdx := buildBMOGapBars()
	svc := NewDriftSignalService(&stubDriftBarFetcherSvc{bars: map[string][]*interfaces.Bar{"TEST": bars}})
	svc.SetInferTimingEnabled(false)
	edate := bars[eIdx].Timestamp.Format("2006-01-02")

	sig, err := svc.GetSignal(context.Background(), "TEST", edate, "")
	if err != nil {
		t.Fatalf("GetSignal err = %v", err)
	}
	if sig.TimingSource != "unknown" {
		t.Errorf("TimingSource = %q, want unknown (inference off)", sig.TimingSource)
	}
	if sig.EarningsTiming != "" {
		t.Errorf("EarningsTiming = %q, want \"\" (legacy AMC-default downstream)", sig.EarningsTiming)
	}
	// Legacy AMC convention uses gap bar E+1 (small overnight) → low gap score.
	if sig.Gap.Score >= 70 {
		t.Errorf("gap score = %v, want < 70 (AMC-default misses the BMO gap)", sig.Gap.Score)
	}
}

func TestGetSignal_VendorTimingRespected(t *testing.T) {
	bars, eIdx := buildBMOGapBars()
	svc := NewDriftSignalService(&stubDriftBarFetcherSvc{bars: map[string][]*interfaces.Bar{"TEST": bars}})
	sig, err := svc.GetSignal(context.Background(), "TEST", bars[eIdx].Timestamp.Format("2006-01-02"), "bmo")
	if err != nil {
		t.Fatalf("GetSignal err = %v", err)
	}
	if sig.TimingSource != "vendor" || sig.EarningsTiming != "bmo" {
		t.Errorf("got source=%q timing=%q, want vendor/bmo", sig.TimingSource, sig.EarningsTiming)
	}
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `go test ./services/ -run TestGetSignal_`
Expected: FAIL — `SetInferTimingEnabled` undefined and `TimingSource`/`TimingInferRatio` fields absent.

- [ ] **Step 3: Add fields, constructor default, setter, and resolution**

In `services/drift_signal_service.go`:

(a) Add two fields to `DriftSignal` (after `EarningsTiming string ...` at line 647):

```go
	EarningsTiming   string            `json:"earnings_timing"`
	TimingSource     string            `json:"timing_source,omitempty"`
	TimingInferRatio float64           `json:"timing_infer_ratio,omitempty"`
```

(b) Add the field to `DriftSignalService` (line 660-662) and default it ON in the constructor:

```go
// DriftSignalService is the per-ticker compute service.
type DriftSignalService struct {
	dataSvc            BarFetcher
	inferTimingEnabled bool
}

// NewDriftSignalService creates a DriftSignalService backed by the given
// bar-fetching data source. Timing inference defaults ON (DRIFT_INFER_TIMING);
// cmd/bot overrides it from config.
func NewDriftSignalService(dataSvc BarFetcher) *DriftSignalService {
	return &DriftSignalService{dataSvc: dataSvc, inferTimingEnabled: true}
}

// SetInferTimingEnabled toggles vendor-free BMO/AMC inference for unknown timing.
// Default true. When false, unknown timing flows through as "" (legacy AMC-default
// downstream) — a clean kill switch.
func (s *DriftSignalService) SetInferTimingEnabled(enabled bool) {
	s.inferTimingEnabled = enabled
}
```

(c) Resolve timing inside `GetSignal` (replace the final `return` at line 683):

```go
	res := resolveDriftTiming(bars, earningsDate, timing, s.inferTimingEnabled)
	sig := ComputeDriftSignal(symbol, bars, earningsDate, res.Timing)
	sig.TimingSource = res.Source
	sig.TimingInferRatio = res.Ratio
	return sig, nil
}
```

- [ ] **Step 4: Run to verify pass + no regression**

Run: `go test ./services/ -run "TestGetSignal_|TestDriftSignalService" -v`
Expected: all PASS (the existing `TestDriftSignalService_ComputesSignal` passes `"bmo"` → vendor path, unchanged).

- [ ] **Step 5: Commit**

```bash
git add services/drift_signal_service.go services/drift_signal_service_test.go
git commit -m "feat(drift): resolve earnings timing in GetSignal (default ON)"
```

---

## Task 3: Candidate-scan telemetry (inferred split + log fields)

**Files:**
- Modify: `services/drift_signal_service.go`

Log/telemetry-only; verified by build + the existing candidate-service suite staying green (those tests assert filtering, not log output — consistent with the existing shadow logs, which are not unit-tested).

- [ ] **Step 1: Add the counters**

In `DriftCandidatesService.compute`, the counter declaration line (~849) reads:

```go
	var inUniverse, fetchErrors, scoredOK, droppedGap, droppedMA, droppedGrade, droppedNotActionable, actionable int
```

Add three timing counters:

```go
	var inUniverse, fetchErrors, scoredOK, droppedGap, droppedMA, droppedGrade, droppedNotActionable, actionable int
	var inferredBMO, inferredAMC, inferredFallback int
```

- [ ] **Step 2: Increment after `scoredOK++`**

Directly after `scoredOK++` (line ~867), insert:

```go
		switch sig.TimingSource {
		case "inferred":
			if sig.EarningsTiming == "bmo" {
				inferredBMO++
			} else {
				inferredAMC++
			}
		case "inferred_fallback":
			inferredFallback++
		}
```

- [ ] **Step 3: Add fields to the two shadow logs**

In the `"drift: would-be continuation entry"` `WithFields` block (line ~890-902), add after `"timing": sig.EarningsTiming,`:

```go
				"timing":             sig.EarningsTiming,
				"timing_source":      sig.TimingSource,
				"timing_infer_ratio": sig.TimingInferRatio,
```

In the `"drift: candidate scan summary"` `WithFields` block (line ~937-949), add before `"candidate_count": resp.Count,`:

```go
		"inferred_bmo":           inferredBMO,
		"inferred_amc":           inferredAMC,
		"inferred_fallback":      inferredFallback,
		"candidate_count":        resp.Count,
```

- [ ] **Step 4: Build + regression**

Run: `go build ./... && go test ./services/ -run TestDriftCandidates -count=1 -v`
Expected: build OK; existing candidate-service tests PASS.

- [ ] **Step 5: Commit**

```bash
git add services/drift_signal_service.go
git commit -m "feat(drift): inferred BMO/AMC split + ratio in shadow telemetry"
```

---

## Task 4: Flag wiring (`DRIFT_INFER_TIMING`, default ON)

**Files:**
- Modify: `config/config.go`, `cmd/bot/main.go`, `.env.example`

- [ ] **Step 1: Add the Config field**

In `config/config.go`, after `EnableDriftContinuation bool` (line 61):

```go
	EnableDriftContinuation bool
	EnableDriftInferTiming  bool
```

- [ ] **Step 2: Populate it in Load() (default ON)**

After the `EnableDriftContinuation:` line (132):

```go
		EnableDriftContinuation: getEnvOrDefault("ENABLE_DRIFT_CONTINUATION", "false") == "true",
		EnableDriftInferTiming:  getEnvOrDefault("DRIFT_INFER_TIMING", "true") != "false",
```

Note the `!= "false"` (default-true) vs the continuation flag's `== "true"` (default-false).

- [ ] **Step 3: Wire it onto the service in cmd/bot/main.go**

After `driftSignalSvc := services.NewDriftSignalService(dataService)` (line 437):

```go
	driftSignalSvc := services.NewDriftSignalService(dataService)
	driftSignalSvc.SetInferTimingEnabled(cfg.EnableDriftInferTiming)
	logger.WithField("mode", map[bool]string{true: "on", false: "off (legacy amc-default)"}[cfg.EnableDriftInferTiming]).
		Info("Drift earnings-timing inference")
```

- [ ] **Step 4: Document in `.env.example`**

Find the `# ENABLE_DRIFT_CONTINUATION=false` line (`.env.example:219`) and add below it:

```
# Vendor-free BMO/AMC earnings-timing inference (default ON). FMP /stable dropped the
# timing field, so unknown timing is inferred from which overnight gap is the earnings
# reaction. Set to false to revert to the legacy AMC-default (mis-indexes BMO names).
# DRIFT_INFER_TIMING=true
```

- [ ] **Step 5: Build**

Run: `go build ./...`
Expected: OK.

- [ ] **Step 6: Commit**

```bash
git add config/config.go cmd/bot/main.go .env.example
git commit -m "feat(drift): DRIFT_INFER_TIMING flag (default ON) wired to bot"
```

---

## Task 5: Replay resolution (`RunReplay` + `TradeOutcome` fields)

**Files:**
- Modify: `services/drift_replay.go`
- Test: `services/drift_replay_test.go`

- [ ] **Step 1: Write the failing test**

Append to `services/drift_replay_test.go`. `buildContinuationBars` (earnings bar at `len-5`, BMO-shaped) and `stubDriftBarFetcherSvc` / `stubRangeReporter` already exist.

```go
func TestRunReplay_RecordsResolvedTiming(t *testing.T) {
	cont := buildContinuationBars("CONT")
	edate := cont[len(cont)-5].Timestamp
	stub := &stubDriftBarFetcherSvc{bars: map[string][]*interfaces.Bar{"CONT": cont}}
	// Reporter passes UNKNOWN timing ("") — the replay must infer it.
	rep := &stubRangeReporter{reports: []RecentReport{{Ticker: "CONT", Date: edate, Timing: ""}}}
	fr := StockFriction{PerShareSlippage: 0.02, StopGapThroughPct: 0.003, RegFeePerShare: 0.0001}

	outcomes, cov := RunReplay(context.Background(), stub, rep, []string{"CONT"},
		edate.AddDate(0, 0, -5), edate.AddDate(0, 0, 5), fr, stdExitCfg)

	// buildContinuationBars is BMO-shaped → inferred "bmo".
	if cov.TimingFill["bmo"] == 0 {
		t.Errorf("TimingFill = %+v, want bmo>0 (inferred)", cov.TimingFill)
	}
	if cov.TimingFill[""] != 0 {
		t.Errorf("TimingFill[\"\"] = %d, want 0 (no raw unknowns recorded)", cov.TimingFill[""])
	}
	var sawResolved bool
	for _, o := range outcomes {
		if o.Cohort == "deployed" {
			sawResolved = true
			if o.Timing != "bmo" {
				t.Errorf("outcome.Timing = %q, want bmo", o.Timing)
			}
			if o.TimingSource != "inferred" {
				t.Errorf("outcome.TimingSource = %q, want inferred", o.TimingSource)
			}
		}
	}
	if !sawResolved {
		t.Fatalf("no deployed outcome; got %+v", outcomes)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./services/ -run TestRunReplay_RecordsResolvedTiming`
Expected: FAIL — `TradeOutcome.Timing` / `.TimingSource` undefined.

- [ ] **Step 3: Add fields + `Coverage.TimingFallback`**

In `services/drift_replay.go`, add to `TradeOutcome` (after `Grade string ...`):

```go
	Grade             string  `json:"grade"`
	Timing            string  `json:"timing"`
	TimingSource      string  `json:"timing_source"`
	TimingInferRatio  float64 `json:"timing_infer_ratio"`
```

Add to `Coverage` (after `TimingFill map[string]int ...`):

```go
	TimingFill      map[string]int `json:"timing_fill"`
	TimingFallback  int            `json:"timing_fallback"`
```

- [ ] **Step 4: Resolve per event in `RunReplay`**

Remove the existing grouping-loop tally `cov.TimingFill[r.Timing]++` (line ~547). Then in the per-event loop, after the earnings-in-bars guard (the block at lines ~580-585), resolve and tally:

```go
		for _, e := range evs {
			edate := e.date.Format("2006-01-02")
			if findBarIndexByDate(bars, edate) < 0 {
				cov.Dropped["earnings_not_in_bars"]++
				continue
			}
			res := resolveDriftTiming(bars, edate, e.timing, true) // always infer offline
			cov.TimingFill[res.Timing]++
			if res.Source == "inferred_fallback" {
				cov.TimingFallback++
			}
			dep, ctrl := findEntries(sym, bars, edate, res.Timing, driftReplayWindowCalDays)
```

In the cohort-outcome builder (the `TradeOutcome{...}` literal at lines ~603-610), stamp the resolved fields:

```go
					Grade: c.er.Grade, ExitReason: ex.Reason, HoldingDays: ex.HoldingDays,
					GrossReturnPct: gross, FrictionReturnPct: fric,
					Timing: res.Timing, TimingSource: res.Source, TimingInferRatio: res.Ratio,
```

- [ ] **Step 5: Run to verify pass + no regression**

Run: `go test ./services/ -run "TestRunReplay" -count=1 -v`
Expected: PASS (existing `TestRunReplay_ProducesCohortOutcomes` still green — its reporter passes `"bmo"` → vendor path).

- [ ] **Step 6: Commit**

```bash
git add services/drift_replay.go services/drift_replay_test.go
git commit -m "feat(driftreplay): resolve+record earnings timing per event"
```

---

## Task 6: Per-cohort timing breakdown in `Aggregate`

**Files:**
- Modify: `services/drift_replay.go`
- Test: `services/drift_replay_test.go`

- [ ] **Step 1: Write the failing test**

Append to `services/drift_replay_test.go`. Extend the existing `to(...)` helper pattern with timing fields via a local builder.

```go
func toT(cohort, timing, source string, ratio, gross, fr float64) TradeOutcome {
	return TradeOutcome{Cohort: cohort, ExitReason: "target", Timing: timing, TimingSource: source,
		TimingInferRatio: ratio, GrossReturnPct: gross, FrictionReturnPct: fr}
}

func TestAggregate_TimingBreakdownPerCohort(t *testing.T) {
	out := []TradeOutcome{
		toT("deployed", "bmo", "inferred", 4.0, 20, 19.9),
		toT("deployed", "amc", "inferred", 1.2, -10, -10.3), // near-tie (ratio<1.5)
		toT("deployed", "amc", "inferred_fallback", 0, 5, 4.9),
		toT("control", "bmo", "inferred", 3.0, 20, 19.9),
	}
	r := Aggregate(out)
	if r.DeployedTiming.BMO != 1 || r.DeployedTiming.AMC != 2 {
		t.Errorf("deployed split = %+v, want bmo=1 amc=2", r.DeployedTiming)
	}
	if r.DeployedTiming.Fallback != 1 {
		t.Errorf("deployed fallback = %d, want 1", r.DeployedTiming.Fallback)
	}
	if r.DeployedTiming.NearTies != 1 {
		t.Errorf("deployed near-ties = %d, want 1 (the ratio=1.2 inferred entry)", r.DeployedTiming.NearTies)
	}
	// Ratio stats over the two MEASURED inferred entries (4.0, 1.2): min 1.2, max 4.0.
	if r.DeployedTiming.RatioMin != 1.2 || r.DeployedTiming.RatioMax != 4.0 {
		t.Errorf("ratio min/max = %v/%v, want 1.2/4.0", r.DeployedTiming.RatioMin, r.DeployedTiming.RatioMax)
	}
	if r.ControlTiming.BMO != 1 {
		t.Errorf("control split = %+v, want bmo=1", r.ControlTiming)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./services/ -run TestAggregate_TimingBreakdownPerCohort`
Expected: FAIL — `ReplaySummary.DeployedTiming` / `TimingBreakdown` undefined.

- [ ] **Step 3: Implement `TimingBreakdown` + `summarizeTiming` + wire into `Aggregate`**

In `services/drift_replay.go`, add the type (near `ReplaySummary`):

```go
// TimingBreakdown summarizes one cohort's resolved-timing composition and the
// inference-confidence distribution over its MEASURED inferred entries. NearTies
// (0 < ratio < 1.5) is descriptive context for risk #1, not a gate.
type TimingBreakdown struct {
	BMO         int     `json:"bmo"`
	AMC         int     `json:"amc"`
	Fallback    int     `json:"fallback"`
	NearTies    int     `json:"near_ties"`
	RatioMin    float64 `json:"ratio_min"`
	RatioMedian float64 `json:"ratio_median"`
	RatioMax    float64 `json:"ratio_max"`
}

func summarizeTiming(out []TradeOutcome) TimingBreakdown {
	var tb TimingBreakdown
	var ratios []float64
	for _, o := range out {
		switch o.Timing {
		case "bmo":
			tb.BMO++
		case "amc":
			tb.AMC++
		}
		if o.TimingSource == "inferred_fallback" {
			tb.Fallback++
		}
		if o.TimingSource == "inferred" { // measured
			ratios = append(ratios, o.TimingInferRatio)
			if o.TimingInferRatio > 0 && o.TimingInferRatio < 1.5 {
				tb.NearTies++
			}
		}
	}
	if len(ratios) > 0 {
		sort.Float64s(ratios)
		tb.RatioMin = roundTo2(ratios[0])
		tb.RatioMax = roundTo2(ratios[len(ratios)-1])
		tb.RatioMedian = roundTo2(ratios[len(ratios)/2])
	}
	return tb
}
```

Add the fields to `ReplaySummary` (after `Control CohortReport ...`):

```go
	DeployedTiming TimingBreakdown `json:"deployed_timing"`
	ControlTiming  TimingBreakdown `json:"control_timing"`
```

In `Aggregate`, after the `r := ReplaySummary{...}` literal is built, set them (the `dep`/`ctrl` slices already exist there):

```go
	r.DeployedTiming = summarizeTiming(dep)
	r.ControlTiming = summarizeTiming(ctrl)
```

- [ ] **Step 4: Run to verify pass**

Run: `go test ./services/ -run TestAggregate -count=1 -v`
Expected: PASS (existing `TestAggregate_SplitsCohortsAndMarginalEdge` still green).

- [ ] **Step 5: Commit**

```bash
git add services/drift_replay.go services/drift_replay_test.go
git commit -m "feat(driftreplay): per-cohort timing split + confidence distribution"
```

---

## Task 7: Report rendering (timing split, fallback, ratio, composition)

**Files:**
- Modify: `cmd/driftreplay/main.go`

Render-only (the JSON sidecar already serializes `summary` + `coverage`, so the new fields appear there automatically). Verified by build + one offline run in Task 10.

- [ ] **Step 1: Replace the timing-fill coverage line**

In `renderMarkdown`, replace the line (~105):

```go
	fmt.Fprintf(&b, "- timing fill: bmo=%d amc=%d unknown=%d\n", cov.TimingFill["bmo"], cov.TimingFill["amc"], cov.TimingFill[""])
```

with (resolved split + fallback):

```go
	fmt.Fprintf(&b, "- timing (inferred): bmo=%d amc=%d | fallback=%d unknown=%d\n",
		cov.TimingFill["bmo"], cov.TimingFill["amc"], cov.TimingFallback, cov.TimingFill[""])
```

- [ ] **Step 2: Add a timing/composition section after the marginal-edge line**

After the `**Marginal edge (deployed − control):**` `Fprintf` (~126-127), insert:

```go
	tline := func(name string, n int, tb services.TimingBreakdown) {
		fmt.Fprintf(&b, "| %s | %d | %d | %d | %d | %d | %.2f / %.2f / %.2f |\n",
			name, n, tb.BMO, tb.AMC, tb.Fallback, tb.NearTies, tb.RatioMin, tb.RatioMedian, tb.RatioMax)
	}
	fmt.Fprintf(&b, "## Timing composition (clean read — read BEFORE expectancy)\n\n")
	fmt.Fprintf(&b, "Inferred BMO/AMC split per cohort + inference confidence. A large change in `n` or\n")
	fmt.Fprintf(&b, "in the inferred-BMO count vs the prior AMC-default run is itself a headline finding.\n\n")
	fmt.Fprintf(&b, "| cohort | n | bmo | amc | fallback | near-ties (<1.5) | ratio min/med/max |\n")
	fmt.Fprintf(&b, "|---|---|---|---|---|---|---|\n")
	tline("deployed", s.Deployed.Friction.N, s.DeployedTiming)
	tline("control", s.Control.Friction.N, s.ControlTiming)
	fmt.Fprintf(&b, "\n_Inferred-AMC entries sitting on a large BMO-side gap (low ratio) are the suspicious\n")
	fmt.Fprintf(&b, "BMO→AMC mislabels (risk #1); fallback entries kept the legacy AMC-default (risk #4)._\n\n")
```

- [ ] **Step 3: Build**

Run: `go build ./cmd/driftreplay`
Expected: OK.

- [ ] **Step 4: Commit**

```bash
git add cmd/driftreplay/main.go
git commit -m "feat(driftreplay): render timing split, confidence, composition"
```

---

## Task 8: Window-start invariant test (lookahead guard)

**Files:**
- Test: `services/drift_replay_test.go`

Pins the resolve-once/per-day equivalence: `findEntries` must never evaluate a day before `E+1`, or the once-resolved timing could diverge from a per-day read (lookahead leak).

- [ ] **Step 1: Write the test**

Append to `services/drift_replay_test.go`:

```go
func TestFindEntries_NeverEvaluatesBeforeEPlus1(t *testing.T) {
	bars := buildContinuationBars("CONT")
	eIdx := len(bars) - 5
	edate := bars[eIdx].Timestamp.UTC().Format("2006-01-02")
	dep, ctrl := findEntries("CONT", bars, edate, "bmo", 14)
	// Any found entry's SignalIdx (evaluation day D) must be >= E+1; entry fills at D+1.
	for _, er := range []EntryResult{dep, ctrl} {
		if er.Found && er.SignalIdx <= eIdx {
			t.Errorf("evaluated day %d <= earnings idx %d — window start regressed to E (lookahead risk)", er.SignalIdx, eIdx)
		}
	}
}
```

- [ ] **Step 2: Run to verify it passes**

Run: `go test ./services/ -run TestFindEntries_NeverEvaluatesBeforeEPlus1 -v`
Expected: PASS against the current `d := idxE + 1` loop start. (If a future change sets the start to `idxE`, this fails.)

- [ ] **Step 3: Commit**

```bash
git add services/drift_replay_test.go
git commit -m "test(driftreplay): pin entry-window start to E+1 (lookahead guard)"
```

---

## Task 9: Full verification + spec coverage sweep

**Files:** none (verification gate before the deliverable run)

- [ ] **Step 1: Whole suite + build green**

Run: `go build ./... && go test ./... -count=1`
Expected: build OK; all packages `ok`. Investigate any failure before proceeding — do not run the deliverable on a red tree.

- [ ] **Step 2: Confirm the kill switch path**

Run: `go test ./services/ -run "TestGetSignal_DisabledKeepsLegacyAMCDefault" -v`
Expected: PASS — verifies `DRIFT_INFER_TIMING=false` reproduces the legacy AMC-default byte-for-byte at the gap level.

---

## Task 10: Clean-read replay re-run + pre-registered verdict

**Files:** creates `data/reports/drift-continuation-replay-<rundate>.{md,json}`; renames the prior pair.

This is a **real network run** (FMP per-symbol earnings + Alpaca daily bars via the shared cache; subject to the cross-agent 429 budget). Source the FMP key first (`FMP_API_KEY` lives in project-root `.env`, not the shell).

- [ ] **Step 1: Preserve the dirty baseline (avoid same-day clobber)**

The CLI names output by run date; today's dirty artifacts would be overwritten. Rename them first:

```bash
git mv data/reports/drift-continuation-replay-2026-05-30.md  data/reports/drift-continuation-replay-2026-05-30-amc-default.md
git mv data/reports/drift-continuation-replay-2026-05-30.json data/reports/drift-continuation-replay-2026-05-30-amc-default.json
```

- [ ] **Step 2: Run the replay on the clean read**

```bash
set -a; . ./.env; set +a   # load FMP_API_KEY + Alpaca keys into env
go run ./cmd/driftreplay --years 3
```

Expected: writes a fresh `data/reports/drift-continuation-replay-<today>.{md,json}` and logs `driftreplay: done` with deployed/control counts. The new `.md` "timing (inferred)" line shows `bmo=… amc=…` (not `unknown=959`).

- [ ] **Step 3: Read the report in the spec's order (composition before expectancy)**

Open the new `.md`. Record, in order:
1. new `n` per cohort vs the prior 26 / 32; the inferred-BMO count per cohort.
2. fallback count; near-ties count; ratio min/median/max per cohort.
3. only then: friction-adjusted control expectancy `Ec`, `PF_c`, `PF_d`, marginal `M`.

- [ ] **Step 4: Apply the PRE-REGISTERED gate (spec Component 7 §4) and write the verdict**

Evaluate the precondition then the branches (all friction-adjusted, strict inequalities; boundaries → Inconclusive):
- **Precondition:** `n_d < 20` or `n_c < 20` → **Inconclusive** (extend universe history; do not spec/enable).
- **Proceed** iff `Ec > +3.0%` AND `PF_c > 2.0` AND `M < −2.0%`.
- **Not the culprit** iff `M > +1.0%`.
- **Inconclusive** otherwise.

Append a short "## Verdict (pre-registered gate)" section to the new `.md` stating the cohort `n`s, `Ec`/`PF_c`/`PF_d`/`M`, which branch fired, and the resulting action. Do NOT enable `ENABLE_DRIFT_CONTINUATION` regardless (out of scope). Surface the composition delta (risk #6) as the headline even if it dominates the expectancy story.

- [ ] **Step 5: Commit the run artifacts**

```bash
git add data/reports/
git commit -m "report(driftreplay): clean-read re-run + pre-registered verdict"
```

---

## Task 11: Finalization — squash + memory

**Files:** none (git + memory)

- [ ] **Step 1: Squash to one commit (user's workflow: one squashed commit per backlog item)**

Squash Tasks 1–10's commits into a single commit on local `main`. Confirm `go build ./... && go test ./... -count=1` is green at the squashed tip.

```bash
git reset --soft <commit-before-task-1>
git commit -m "feat(drift): vendor-free earnings-timing inference + clean-read replay re-run"
```

(End the commit message with the `Co-Authored-By` trailer per repo convention.)

- [ ] **Step 2: Update memory**

Update `memory/drift-continuation-entry-path.md` (and its `MEMORY.md` pointer): the timing-inference fix shipped (flag `DRIFT_INFER_TIMING` default ON), the clean-read re-run outcome, the verdict branch that fired, and the next step it gates (base-only entry-path spec, or inconclusive/extend-history). Note the live redeploy step (rebuild `prophet_bot.exe` from local main to pick up `computeDriftGap`'s correction).

---

## Self-Review

**1. Spec coverage:**
- Component 1 `inferDriftTiming` (+ratio cap, numerator guard) → Task 1. ✓
- Component 2 `resolveDriftTiming` (+`inferred_fallback`) → Task 1. ✓
- Component 3 live `GetSignal` resolution + `inferTimingEnabled` → Task 2. ✓
- Component 4 flag + bot wiring + `.env.example` → Task 4. ✓
- Component 5 replay resolution → Task 5. ✓
- Component 6 telemetry: signal fields → Task 2; scan counters/log fields → Task 3; per-cohort split/ratio → Task 6; report render → Task 7. ✓
- Component 7 re-run + pre-registered gate + baseline preservation → Task 10. ✓
- Lookahead guard #2 (window-start invariant) → Task 8. ✓
- Testing section (infer/resolve/GetSignal/replay/window-start) → Tasks 1,2,5,6,8. ✓
- Regression-green requirement → Task 9. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows full code; `<rundate>`/`<commit-before-task-1>` are run-time/VCS values, not code placeholders. ✓

**3. Type consistency:** `DriftTimingResolution{Timing,Source,Ratio}`, `driftTimingInference{Regime,Ratio,Measured}`, `TimingBreakdown{BMO,AMC,Fallback,NearTies,RatioMin,RatioMedian,RatioMax}`, `DriftSignal.TimingSource`/`.TimingInferRatio`, `TradeOutcome.Timing`/`.TimingSource`/`.TimingInferRatio`, `Coverage.TimingFallback`, `ReplaySummary.DeployedTiming`/`.ControlTiming`, `SetInferTimingEnabled` — names used identically across tasks and render code. ✓
