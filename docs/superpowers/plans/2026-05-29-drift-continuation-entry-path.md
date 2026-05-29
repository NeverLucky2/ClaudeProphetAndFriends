# Drift Continuation Entry Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Drift a fast post-earnings continuation entry path so it can actually trade, shipped behind a default-OFF `ENABLE_DRIFT_CONTINUATION` flag in shadow mode with service-level telemetry.

**Architecture:** Deterministic Go backend computes a new `continuation` signal in `ComputeDriftSignal` (pure function); `DriftCandidatesService.compute` gates it on a flag — shadow (default) leaves the existing base-gates-only filter untouched and reports `is_continuation=false`, enforce tightens the filter to `(continuation OR pead-ready)` and acts. The LLM stays a dumb rule executor reading booleans.

**Tech Stack:** Go 1.21+ (services/controllers layout, sirupsen/logrus), `go test`, env-flag plumbing via `config/config.go`, agent rules in `TRADING_RULES_DRIFT.md`.

**Spec:** `docs/superpowers/specs/2026-05-29-drift-continuation-entry-path-design.md`

---

## File Structure

**Modify:**
- `services/drift_signal_service.go` — add `DriftContinuation` struct + `computeDriftContinuation`; add `Continuation` field to `DriftSignal` and populate in `ComputeDriftSignal`; add `continuationEnabled` field + `SetContinuationEnabled` setter + `continuationMode` helper to `DriftCandidatesService`; rewrite `compute` for flag gating + telemetry.
- `services/drift_signal_service_test.go` — continuation unit tests + shadow/enforce compute tests + helper bar builders.
- `config/config.go` — add `EnableDriftContinuation bool` field + env parse.
- `cmd/bot/main.go` — call `driftCandidatesSvc.SetContinuationEnabled(cfg.EnableDriftContinuation)` + boot log line.
- `TRADING_RULES_DRIFT.md` — entry rule (continuation OR pead-ready), operator note, ranking, entry-logging, checklist, payload block, glossary.
- `.env.example` — document `ENABLE_DRIFT_CONTINUATION=false`.

No new files. No signature changes to existing constructors (setter pattern keeps all call sites intact).

---

## Task 1: Continuation signal — `computeDriftContinuation` + wire into `ComputeDriftSignal`

**Files:**
- Modify: `services/drift_signal_service.go`
- Test: `services/drift_signal_service_test.go`

- [ ] **Step 1: Write the failing unit tests**

Append to `services/drift_signal_service_test.go`:

```go
func TestComputeDriftContinuation_BMO_DayAfterHigherHigh(t *testing.T) {
	// idx0 prev day; idx1 BMO earnings gap (high 106); idx2 day-after closes 107.
	bars := makeDriftBars([]driftBarRow{
		{Open: 100, High: 101, Low: 99, Close: 100, Vol: 1000},
		{Open: 104, High: 106, Low: 103, Close: 105, Vol: 5000}, // earnings (gap bar)
		{Open: 106, High: 108, Low: 105, Close: 107, Vol: 4000}, // day-after
	})
	earningsDate := bars[1].Timestamp.UTC().Format("2006-01-02")
	got := computeDriftContinuation(bars, earningsDate, "bmo")
	if !got.IsContinuation {
		t.Errorf("IsContinuation = false, want true (%+v)", got)
	}
	if got.DaysAfterGap != 1 {
		t.Errorf("DaysAfterGap = %d, want 1", got.DaysAfterGap)
	}
	if got.GapBarHigh != 106 {
		t.Errorf("GapBarHigh = %v, want 106", got.GapBarHigh)
	}
	if got.ExtensionPct <= 0 {
		t.Errorf("ExtensionPct = %v, want > 0", got.ExtensionPct)
	}
	// Day-1 identity (documented, intentional): when DaysAfterGap==1 the gap bar
	// IS the prior bar, so GapBarHigh == PriorHigh. Future readers must not
	// "simplify" the two comparisons away — from day 2 they differ.
	if got.GapBarHigh != got.PriorHigh {
		t.Errorf("day-1 identity broken: GapBarHigh=%v PriorHigh=%v (must be equal when DaysAfterGap==1)", got.GapBarHigh, got.PriorHigh)
	}
}

func TestComputeDriftContinuation_AMC_DayAfterHigherHigh(t *testing.T) {
	// idx0 earnings date (AMC); idx1 gap bar (next day, high 107); idx2 closes 108.
	bars := makeDriftBars([]driftBarRow{
		{Open: 100, High: 101, Low: 99, Close: 100, Vol: 1000},  // earnings date
		{Open: 103, High: 107, Low: 102, Close: 106, Vol: 5000}, // gap bar (next day)
		{Open: 106, High: 109, Low: 105, Close: 108, Vol: 4000}, // latest
	})
	earningsDate := bars[0].Timestamp.UTC().Format("2006-01-02")
	got := computeDriftContinuation(bars, earningsDate, "amc")
	if !got.IsContinuation {
		t.Errorf("IsContinuation = false, want true (%+v)", got)
	}
	if got.GapBarHigh != 107 {
		t.Errorf("GapBarHigh = %v, want 107 (AMC gap bar = earningsIdx+1)", got.GapBarHigh)
	}
	if got.DaysAfterGap != 1 {
		t.Errorf("DaysAfterGap = %d, want 1", got.DaysAfterGap)
	}
}

func TestComputeDriftContinuation_GapIsLatestBar_False(t *testing.T) {
	// Earnings (BMO) is the most recent bar → no day-after yet → not a continuation.
	bars := makeDriftBars([]driftBarRow{
		{Open: 100, High: 101, Low: 99, Close: 100, Vol: 1000},
		{Open: 104, High: 106, Low: 103, Close: 105, Vol: 5000}, // earnings = latest
	})
	earningsDate := bars[1].Timestamp.UTC().Format("2006-01-02")
	got := computeDriftContinuation(bars, earningsDate, "bmo")
	if got.IsContinuation {
		t.Errorf("IsContinuation = true, want false (DaysAfterGap=%d)", got.DaysAfterGap)
	}
	if got.DaysAfterGap != 0 {
		t.Errorf("DaysAfterGap = %d, want 0", got.DaysAfterGap)
	}
}

func TestComputeDriftContinuation_StalledBelowPriorHigh_False(t *testing.T) {
	// Day 2+ : latest close clears the gap-bar high but NOT the prior day's high
	// (the move stalled) → not a continuation. Proves the higher-high confirm
	// adds independent filtering from day 2 on.
	bars := makeDriftBars([]driftBarRow{
		{Open: 100, High: 101, Low: 99, Close: 100, Vol: 1000},
		{Open: 104, High: 106, Low: 103, Close: 105, Vol: 5000}, // earnings (gap bar, high 106)
		{Open: 106, High: 110, Low: 105, Close: 109, Vol: 4000}, // day-after, high 110
		{Open: 108, High: 109, Low: 107, Close: 107, Vol: 3000}, // latest: close 107 > 106 but < priorHigh 110
	})
	earningsDate := bars[1].Timestamp.UTC().Format("2006-01-02")
	got := computeDriftContinuation(bars, earningsDate, "bmo")
	if got.IsContinuation {
		t.Errorf("IsContinuation = true, want false (close %v <= priorHigh %v)", got.LatestClose, got.PriorHigh)
	}
	if got.DaysAfterGap != 2 {
		t.Errorf("DaysAfterGap = %d, want 2", got.DaysAfterGap)
	}
}

func TestComputeDriftContinuation_EarningsNotInBars(t *testing.T) {
	bars := makeDriftBars([]driftBarRow{{Open: 100, High: 101, Low: 99, Close: 100, Vol: 1000}})
	got := computeDriftContinuation(bars, "1999-01-01", "bmo")
	if got.IsContinuation || got.Warning == "" {
		t.Errorf("want IsContinuation=false with warning; got %+v", got)
	}
}

func TestComputeDriftContinuation_AMC_NoGapBarYet(t *testing.T) {
	// AMC earnings on the most recent bar → gap bar (earningsIdx+1) doesn't exist.
	bars := makeDriftBars([]driftBarRow{{Open: 100, High: 101, Low: 99, Close: 100, Vol: 1000}})
	earningsDate := bars[0].Timestamp.UTC().Format("2006-01-02")
	got := computeDriftContinuation(bars, earningsDate, "amc")
	if got.IsContinuation || got.Warning == "" {
		t.Errorf("want IsContinuation=false with warning; got %+v", got)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./services/ -run TestComputeDriftContinuation`
Expected: FAIL — `undefined: computeDriftContinuation`.

- [ ] **Step 3: Implement the struct + function**

In `services/drift_signal_service.go`, add the struct immediately after the `DriftPEAD` struct definition (search for `type DriftPEAD struct`), and add the function near the other `computeDrift*` functions (e.g. directly after `computeDriftMA50`):

```go
// DriftContinuation is the fast post-earnings continuation signal: a fresh
// higher-high close above the gap-bar high, confirming the move is still
// advancing. Bars are oldest-first. The gap bar is the bar the earnings gap is
// measured on (earningsIdx for BMO, earningsIdx+1 for AMC) — matching
// computeDriftGap.
type DriftContinuation struct {
	IsContinuation bool    `json:"is_continuation"`
	GapBarHigh     float64 `json:"gap_bar_high"`
	LatestClose    float64 `json:"latest_close"`
	PriorHigh      float64 `json:"prior_high"`
	DaysAfterGap   int     `json:"days_after_gap"`
	ExtensionPct   float64 `json:"extension_pct"` // (latest_close / gap_bar_high - 1) * 100
	Warning        string  `json:"warning,omitempty"`
}

// computeDriftContinuation evaluates the robust higher-high continuation rule:
//
//	IsContinuation = DaysAfterGap >= 1
//	    AND latestClose > gapBarHigh   (cleared the earnings reaction high)
//	    AND latestClose > priorHigh    (fresh higher-high close, still advancing)
//
// Day-1 note: when DaysAfterGap == 1 the gap bar IS the prior bar, so
// GapBarHigh == PriorHigh and the two comparisons coincide (this matches the
// original spec's day-1 "close > previous day's high"); the higher-high confirm
// only adds independent filtering from day 2 on. Do not "simplify" the two
// checks into one.
func computeDriftContinuation(bars []*interfaces.Bar, earningsDate, timing string) DriftContinuation {
	idx := findBarIndexByDate(bars, earningsDate)
	if idx < 0 {
		return DriftContinuation{Warning: "earnings_date not in bars"}
	}
	gapBarIdx := idx
	if strings.ToLower(timing) != "bmo" {
		gapBarIdx = idx + 1 // AMC / unknown: gap manifests on the next bar's open
	}
	if gapBarIdx >= len(bars) {
		return DriftContinuation{Warning: "no gap bar yet for AMC"}
	}
	L := len(bars)
	if L < 2 {
		return DriftContinuation{Warning: "insufficient bars for continuation"}
	}
	latestIdx := L - 1
	gapBarHigh := bars[gapBarIdx].High
	latestClose := bars[L-1].Close
	priorHigh := bars[L-2].High
	daysAfterGap := latestIdx - gapBarIdx

	var extPct float64
	if gapBarHigh > 0 {
		extPct = roundTo2((latestClose/gapBarHigh - 1.0) * 100.0)
	}

	isCont := daysAfterGap >= 1 && latestClose > gapBarHigh && latestClose > priorHigh
	return DriftContinuation{
		IsContinuation: isCont,
		GapBarHigh:     roundTo2(gapBarHigh),
		LatestClose:    roundTo2(latestClose),
		PriorHigh:      roundTo2(priorHigh),
		DaysAfterGap:   daysAfterGap,
		ExtensionPct:   extPct,
	}
}
```

- [ ] **Step 4: Run the unit tests to verify they pass**

Run: `go test ./services/ -run TestComputeDriftContinuation -v`
Expected: all six PASS.

- [ ] **Step 5: Wire `continuation` into `DriftSignal` + `ComputeDriftSignal`**

In `services/drift_signal_service.go`, add the field to the `DriftSignal` struct (search `type DriftSignal struct`) immediately after the `PEAD DriftPEAD` line:

```go
	Continuation   DriftContinuation `json:"continuation"`
```

In `ComputeDriftSignal` (search `func ComputeDriftSignal`), add the computation alongside the others (after the `pead :=` line) and set the field in the returned struct (after `PEAD: pead,`):

```go
	continuation := computeDriftContinuation(bars, earningsDate, timing)
```

```go
		Continuation:   continuation,
```

- [ ] **Step 6: Verify the full-pipeline signal test still passes and add a continuation assertion**

Append to `services/drift_signal_service_test.go`:

```go
func TestComputeDriftSignal_PopulatesContinuation(t *testing.T) {
	// A clean rising tail after a BMO gap → is_continuation true via the signal.
	bars := makeDriftBars([]driftBarRow{
		{Open: 100, High: 101, Low: 99, Close: 100, Vol: 1000},
		{Open: 104, High: 106, Low: 103, Close: 105, Vol: 5000}, // earnings
		{Open: 106, High: 108, Low: 105, Close: 107, Vol: 4000},
	})
	earningsDate := bars[1].Timestamp.UTC().Format("2006-01-02")
	sig := ComputeDriftSignal("TEST", bars, earningsDate, "bmo")
	if !sig.Continuation.IsContinuation {
		t.Errorf("signal.Continuation.IsContinuation = false, want true (%+v)", sig.Continuation)
	}
}
```

Run: `go test ./services/ -run "TestComputeDriftSignal|TestDriftSignalService" -v`
Expected: PASS (existing full-pipeline test unaffected; new continuation assertion passes).

- [ ] **Step 7: Commit**

```bash
git add services/drift_signal_service.go services/drift_signal_service_test.go
git commit -m "feat(drift): add continuation signal to DriftSignal"
```

---

## Task 2: Flag plumbing — config field + service setter

**Files:**
- Modify: `config/config.go`
- Modify: `services/drift_signal_service.go`
- Test: `services/drift_signal_service_test.go`

- [ ] **Step 1: Write the failing setter test**

Append to `services/drift_signal_service_test.go`:

```go
func TestDriftCandidatesService_ContinuationDefaultsOff(t *testing.T) {
	cs := NewDriftCandidatesService(
		NewDriftSignalService(&stubDriftBarFetcherSvc{}),
		&stubRecentReporterFetcher{},
		[]string{"AAA"},
	)
	if cs.continuationEnabled {
		t.Errorf("continuationEnabled = true, want false (shadow is the default)")
	}
	cs.SetContinuationEnabled(true)
	if !cs.continuationEnabled {
		t.Errorf("SetContinuationEnabled(true) did not take effect")
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./services/ -run TestDriftCandidatesService_ContinuationDefaultsOff`
Expected: FAIL — `cs.continuationEnabled undefined` / `cs.SetContinuationEnabled undefined`.

- [ ] **Step 3: Add the field, setter, and mode helper**

In `services/drift_signal_service.go`, add a field to the `DriftCandidatesService` struct (search `type DriftCandidatesService struct`), after the `refreshInterval time.Duration` line:

```go
	continuationEnabled bool
```

Add the setter and helper right after the existing `SetRefreshInterval` method:

```go
// SetContinuationEnabled toggles the continuation entry path. Default false
// (shadow): the candidate filter is unchanged and continuation is reported as
// false to the agent (would-be entries are logged only). True (enforce): the
// filter tightens to (continuation OR pead-ready) and is_continuation is
// reported truthfully so the agent can act. See the 2026-05-29 spec.
func (s *DriftCandidatesService) SetContinuationEnabled(enabled bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.continuationEnabled = enabled
}

// continuationMode renders the flag as a log label.
func continuationMode(enabled bool) string {
	if enabled {
		return "enforce"
	}
	return "shadow"
}
```

- [ ] **Step 4: Add the config flag**

In `config/config.go`, add the field to the `Config` struct immediately after the `EnableAgentUniverseGate bool` line:

```go
	// Drift continuation entry path. Flag-gated, default OFF (shadow: backend
	// logs would-be continuation entries but the agent does not act). See the
	// 2026-05-29 spec.
	EnableDriftContinuation bool
```

In the same file's loader (the struct literal that contains `EnableAgentUniverseGate: getEnvOrDefault(...)`), add immediately after that line:

```go
		EnableDriftContinuation: getEnvOrDefault("ENABLE_DRIFT_CONTINUATION", "false") == "true",
```

- [ ] **Step 5: Run the setter test + build config**

Run: `go test ./services/ -run TestDriftCandidatesService_ContinuationDefaultsOff -v && go build ./config/`
Expected: PASS, config builds.

- [ ] **Step 6: Commit**

```bash
git add config/config.go services/drift_signal_service.go services/drift_signal_service_test.go
git commit -m "feat(drift): add ENABLE_DRIFT_CONTINUATION flag + SetContinuationEnabled"
```

---

## Task 3: `compute` flag gating + telemetry (shadow vs enforce)

**Files:**
- Modify: `services/drift_signal_service.go` (`compute`)
- Test: `services/drift_signal_service_test.go`

- [ ] **Step 1: Write the failing shadow/enforce tests + bar helpers**

Append to `services/drift_signal_service_test.go`:

```go
// buildContinuationBars: grade-A/B, BMO gap +6% at L-5, with highs == closes so
// a rising tail produces a clean higher-high close → is_continuation == true.
// PEAD stage is MONITORING (earnings only ~1 week back), so the ONLY actionable
// path is continuation.
func buildContinuationBars(ticker string) []*interfaces.Bar {
	rows := make([]driftBarRow, 220)
	for i := 0; i < 200; i++ {
		rows[i] = driftBarRow{Open: 100, High: 100, Low: 99.5, Close: 100, Vol: 100_000}
	}
	for i := 200; i < 215; i++ {
		c := 100 + 0.4*float64(i-199)
		rows[i] = driftBarRow{Open: c - 0.2, High: c, Low: c - 0.3, Close: c, Vol: 100_000}
	}
	earningsIdx := 215
	prevClose := rows[earningsIdx-1].Close
	gapOpen := prevClose * 1.06
	rows[earningsIdx] = driftBarRow{Open: gapOpen, High: gapOpen + 0.5, Low: prevClose, Close: gapOpen + 0.5, Vol: 200_000}
	for i := earningsIdx + 1; i < 220; i++ {
		c := rows[i-1].Close + 0.4
		rows[i] = driftBarRow{Open: c - 0.1, High: c, Low: c - 0.2, Close: c, Vol: 200_000} // High == Close
	}
	bars := makeMonFriBars(rows)
	for _, b := range bars {
		b.Symbol = ticker
	}
	return bars
}

func TestDriftCandidates_EnforceMode_SurfacesContinuationDropsNonActionable(t *testing.T) {
	cont := buildContinuationBars("CONT") // continuation true, MONITORING
	flat := buildGradeABars("FLT")        // continuation false (High=Close+0.5 > next close), MONITORING
	stub := map[string][]*interfaces.Bar{"CONT": cont, "FLT": flat}
	reports := []RecentReport{
		{Ticker: "CONT", Date: cont[len(cont)-5].Timestamp, Timing: "bmo"},
		{Ticker: "FLT", Date: flat[len(flat)-5].Timestamp, Timing: "bmo"},
	}
	cs := NewDriftCandidatesService(
		NewDriftSignalService(&stubDriftBarFetcherSvc{bars: stub}),
		&stubRecentReporterFetcher{reports: reports},
		[]string{"CONT", "FLT"},
	)
	cs.SetRefreshInterval(-1)
	cs.SetContinuationEnabled(true) // enforce

	resp := cs.GetCandidates(context.Background(), time.Date(2026, 5, 19, 17, 0, 0, 0, time.UTC))
	if resp.Count != 1 {
		t.Fatalf("enforce: expected 1 actionable candidate (CONT), got %d: %+v", resp.Count, resp.Candidates)
	}
	if resp.Candidates[0].Ticker != "CONT" {
		t.Fatalf("enforce: expected CONT, got %s", resp.Candidates[0].Ticker)
	}
	if !resp.Candidates[0].Continuation.IsContinuation {
		t.Errorf("enforce: CONT.is_continuation = false, want true")
	}
}

func TestDriftCandidates_ShadowMode_PreservesFilterZeroesField(t *testing.T) {
	cont := buildContinuationBars("CONT")
	flat := buildGradeABars("FLT")
	stub := map[string][]*interfaces.Bar{"CONT": cont, "FLT": flat}
	reports := []RecentReport{
		{Ticker: "CONT", Date: cont[len(cont)-5].Timestamp, Timing: "bmo"},
		{Ticker: "FLT", Date: flat[len(flat)-5].Timestamp, Timing: "bmo"},
	}
	cs := NewDriftCandidatesService(
		NewDriftSignalService(&stubDriftBarFetcherSvc{bars: stub}),
		&stubRecentReporterFetcher{reports: reports},
		[]string{"CONT", "FLT"},
	)
	cs.SetRefreshInterval(-1)
	// No SetContinuationEnabled → default shadow.

	resp := cs.GetCandidates(context.Background(), time.Date(2026, 5, 19, 17, 0, 0, 0, time.UTC))
	if resp.Count != 2 {
		t.Fatalf("shadow: expected 2 candidates (base-gates filter unchanged), got %d: %+v", resp.Count, resp.Candidates)
	}
	for _, c := range resp.Candidates {
		if c.Continuation.IsContinuation {
			t.Errorf("shadow: %s.is_continuation = true, want false (must be zeroed for the agent)", c.Ticker)
		}
	}
}
```

- [ ] **Step 2: Run to verify the new tests fail (and confirm the helper produces continuation)**

Run: `go test ./services/ -run "TestDriftCandidates_EnforceMode|TestDriftCandidates_ShadowMode" -v`
Expected: FAIL — enforce currently surfaces BOTH names (filter does not yet gate on actionable), and shadow does not yet zero `is_continuation`.

- [ ] **Step 3: Rewrite `compute` with flag gating + telemetry**

In `services/drift_signal_service.go`, replace the body of `func (s *DriftCandidatesService) compute(...)` with:

```go
func (s *DriftCandidatesService) compute(ctx context.Context, now time.Time) *DriftCandidatesResponse {
	resp := &DriftCandidatesResponse{Candidates: []DriftSignal{}}
	if s.earnings == nil {
		resp.Errors = append(resp.Errors, "no earnings source configured")
		return resp
	}
	reports, err := s.earnings.FetchRecentReports(ctx, now, 5)
	if err != nil {
		resp.Errors = append(resp.Errors, fmt.Sprintf("FetchRecentReports: %s", err.Error()))
		return resp
	}

	s.mu.RLock()
	enforce := s.continuationEnabled
	s.mu.RUnlock()

	var latestAsOf string
	var inUniverse, fetchErrors, scoredOK, droppedGap, droppedMA, droppedGrade, droppedNotActionable, actionable int

	for _, r := range reports {
		if !s.universe[strings.ToUpper(r.Ticker)] {
			continue
		}
		inUniverse++
		sig, err := s.signalSvc.GetSignal(ctx, r.Ticker, r.Date.Format("2006-01-02"), r.Timing)
		if err != nil {
			if !errors.Is(err, ErrInsufficientDriftHistory) {
				fetchErrors++
				resp.Errors = append(resp.Errors, fmt.Sprintf("%s: %s", r.Ticker, err.Error()))
			}
			continue
		}
		if sig == nil {
			continue
		}
		scoredOK++

		// Base entry gates (always applied; mirror TRADING_RULES_DRIFT.md).
		if sig.Gap.GapPct < 3.0 {
			droppedGap++
			continue
		}
		if !sig.MA200.AboveMA || !sig.MA50.AboveMA {
			droppedMA++
			continue
		}
		if sig.Composite.Grade != "A" && sig.Composite.Grade != "B" {
			droppedGrade++
			continue
		}

		peadReady := sig.PEAD.Stage == "SIGNAL_READY" || sig.PEAD.Stage == "BREAKOUT"
		cont := sig.Continuation.IsContinuation

		// Shadow telemetry: log every would-be continuation entry regardless of
		// mode (out of the LLM payload). Fields suffice to reconstruct forward
		// outcomes offline.
		if cont {
			s.logger.WithFields(logrus.Fields{
				"ticker":          sig.Ticker,
				"earnings_date":   sig.EarningsDate,
				"timing":          sig.EarningsTiming,
				"last_close":      sig.LastClose,
				"gap_pct":         sig.Gap.GapPct,
				"extension_pct":   sig.Continuation.ExtensionPct,
				"days_after_gap":  sig.Continuation.DaysAfterGap,
				"composite_score": sig.Composite.CompositeScore,
				"grade":           sig.Composite.Grade,
				"pead_stage":      sig.PEAD.Stage,
				"mode":            continuationMode(enforce),
			}).Info("drift: would-be continuation entry")
		}

		if cont || peadReady {
			actionable++
		}

		if enforce {
			// ENFORCE: only actionable names surface; is_continuation stays truthful.
			if !cont && !peadReady {
				droppedNotActionable++
				continue
			}
		} else {
			// SHADOW: keep the base-gates-only filter (non-actionable in-window
			// names still surface, preserving near-miss visibility); zero the
			// field so the agent's "continuation OR pead-ready" rule cannot act.
			sig.Continuation.IsContinuation = false
		}

		if sig.AsOf > latestAsOf {
			latestAsOf = sig.AsOf
		}
		resp.Candidates = append(resp.Candidates, *sig)
	}

	sort.SliceStable(resp.Candidates, func(i, j int) bool {
		return resp.Candidates[i].Composite.CompositeScore > resp.Candidates[j].Composite.CompositeScore
	})
	resp.Count = len(resp.Candidates)
	resp.AsOf = latestAsOf

	// Per-scan coverage summary (out of the LLM payload). Distinguishes
	// "fix works, no setups yet" from "fix didn't land", and surfaces the
	// 429-starvation confound via fetch_errors / in_universe.
	s.logger.WithFields(logrus.Fields{
		"mode":                   continuationMode(enforce),
		"reports_in_window":      len(reports),
		"in_universe":            inUniverse,
		"scored_ok":              scoredOK,
		"dropped_gap":            droppedGap,
		"dropped_ma":             droppedMA,
		"dropped_grade":          droppedGrade,
		"dropped_not_actionable": droppedNotActionable,
		"fetch_errors":           fetchErrors,
		"actionable_count":       actionable,
		"candidate_count":        resp.Count,
	}).Info("drift: candidate scan summary")

	return resp
}
```

Confirm `logrus` is already imported in this file (it is — `DriftCandidatesService` uses `*logrus.Logger`). No new imports.

- [ ] **Step 4: Run the new tests + the full existing drift suite**

Run: `go test ./services/ -run "TestDriftCandidates|TestComputeDriftContinuation|TestComputeDriftSignal|TestDriftSignalService|TestAnalyzeDriftPEAD" -v`
Expected: all PASS. The pre-existing `TestDriftCandidatesService_*` tests (FiltersByUniverse, SortsByCompositeDesc, DropsLowGap, PropagatesFetchErrors, CachingHonored, RefreshBypassesTTL) run in default shadow mode → base-gates behavior unchanged → still green.

- [ ] **Step 5: Full services regression**

Run: `go test ./services/ -count=1`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add services/drift_signal_service.go services/drift_signal_service_test.go
git commit -m "feat(drift): gate continuation in compute (shadow/enforce) + scan telemetry"
```

---

## Task 4: Wire the flag in `cmd/bot/main.go`

**Files:**
- Modify: `cmd/bot/main.go`

- [ ] **Step 1: Apply the flag after constructing the candidates service**

In `cmd/bot/main.go`, find the block that constructs `driftCandidatesSvc` (search `driftCandidatesSvc := services.NewDriftCandidatesService(`). Immediately after the closing `)` of that constructor call and before `driftController := controllers.NewDriftController(driftCandidatesSvc)`, insert:

```go
	driftCandidatesSvc.SetContinuationEnabled(cfg.EnableDriftContinuation)
	logger.WithField("mode", map[bool]string{true: "enforce", false: "shadow"}[cfg.EnableDriftContinuation]).
		Info("Drift continuation entry path")
```

- [ ] **Step 2: Build the bot**

Run: `go build ./cmd/bot/`
Expected: builds with no errors.

- [ ] **Step 3: Verify the whole module compiles + vet**

Run: `go build ./... && go vet ./services/ ./config/ ./cmd/bot/`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add cmd/bot/main.go
git commit -m "feat(drift): wire ENABLE_DRIFT_CONTINUATION into the bot"
```

---

## Task 5: Update agent rules (`TRADING_RULES_DRIFT.md`)

**Files:**
- Modify: `TRADING_RULES_DRIFT.md`

No automated test — this is the agent-facing rule text. Each edit below is an exact find/replace; after editing, re-read the changed sections to confirm internal consistency.

- [ ] **Step 1: Entry signal — make pead-stage an OR with continuation**

In the `### Entry signal` section, replace the bullet:

```
- `pead.stage` ∈ {"SIGNAL_READY", "BREAKOUT"} (preferred — see ranking note)
```

with:

```
- **Either** `continuation.is_continuation` == true **OR** `pead.stage` ∈ {"SIGNAL_READY", "BREAKOUT"}

  `continuation.is_continuation` is true when, ≥1 trading day after the gap, the
  latest daily close is above both the gap-bar high and the prior day's high (a
  fresh higher-high close confirming the post-earnings move is still advancing).

  **Operator gate:** continuation entries are controlled by the backend env flag
  `ENABLE_DRIFT_CONTINUATION` (default OFF = shadow). While OFF, the backend
  reports `continuation.is_continuation = false` and only logs would-be
  continuation entries — Drift takes no continuation trades until the operator
  enables it. The `pead.stage` path is always active but is rarely reachable
  inside the current candidate window.
```

- [ ] **Step 2: Ranking preference**

In the `**Ranking preference for entries**` paragraph, replace it with:

```
**Ranking preference for entries**: when multiple candidates qualify, prefer
`pead.stage == "BREAKOUT"`, then `SIGNAL_READY`, then continuation-only
qualifiers, then by composite score descending. The backend already sorts by
composite descending; the agent does the additional stage/continuation-bias
re-sort if the position cap binds.
```

- [ ] **Step 3: Entry logging (chase instrumentation)**

In `### Step 3: Entry checks`, in the final numbered item that begins `6. On fill: log entry with`, replace it with:

```
6. On fill: log entry with `entry_reason` ("pead_continuation" for a
   `continuation.is_continuation` entry, "pead_breakout" for a `pead.stage`
   entry), including `earnings_date`, `earnings_timing`, `composite_score`,
   `grade`, `pead.stage`, `gap.gap_pct`, `continuation.extension_pct` (the
   close's % extension above the gap-bar high — recorded so an extension/anti-chase
   guard can be calibrated later), and the computed `position_dollars`.
```

- [ ] **Step 4: Pre-Trade Checklist**

In the `## Pre-Trade Checklist` section, replace the line:

```
- [ ] `pead.stage` ∈ {"SIGNAL_READY", "BREAKOUT"}?
```

with:

```
- [ ] `continuation.is_continuation` == true OR `pead.stage` ∈ {"SIGNAL_READY", "BREAKOUT"}?
```

- [ ] **Step 5: Signal Definitions payload block**

In the `### Signal Definitions` payload block, add a line after the `pead:` line (inside the JSON-ish list):

```
  continuation:      { is_continuation, gap_bar_high, latest_close, prior_high, days_after_gap, extension_pct, ... },
```

- [ ] **Step 6: Glossary**

In the `## Glossary` table, add a row after the `PEAD stage` row:

```
| Continuation | Fast post-earnings momentum entry: ≥1 day after the gap, latest close above BOTH the gap-bar high and the prior day's high. Gated by `ENABLE_DRIFT_CONTINUATION` (shadow by default). |
```

- [ ] **Step 7: Re-read and commit**

Re-read the `### Entry signal`, `### Step 3: Entry checks`, `## Pre-Trade Checklist`, and `## Glossary` sections to confirm they are consistent (continuation referenced identically everywhere; no leftover "pead.stage is mandatory" phrasing).

```bash
git add TRADING_RULES_DRIFT.md
git commit -m "docs(drift): continuation OR pead-ready entry rule + operator gate"
```

---

## Task 6: `.env.example` + full regression + final verification

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Document the flag**

In `.env.example`, near the other Drift / agent-gate flags (search `ENABLE_AGENT_UNIVERSE_GATE`), add:

```
# Drift continuation entry path — default OFF (shadow). While false, the backend
# computes the continuation signal and logs would-be entries + a per-scan
# coverage summary, but Drift places NO continuation trades. Review the
# "drift: would-be continuation entry" / "drift: candidate scan summary" service
# logs, then set to true to let Drift act on continuation.
# ENABLE_DRIFT_CONTINUATION=false
```

- [ ] **Step 2: Full Go regression**

Run: `go test ./... -count=1`
Expected: PASS (no regressions across services, controllers, config).

- [ ] **Step 3: Confirm default-OFF behavior is inert**

Run: `go test ./services/ -run "TestDriftCandidatesService_FiltersByUniverse|TestDriftCandidatesService_DropsLowGap|TestDriftCandidates_ShadowMode" -v`
Expected: PASS — confirms that with the flag off (shadow) the candidate list and counts match the pre-change base-gates behavior, and `is_continuation` is zeroed in the payload.

- [ ] **Step 4: Commit**

```bash
git add .env.example
git commit -m "docs(drift): document ENABLE_DRIFT_CONTINUATION (default off/shadow)"
```

---

## Self-Review notes (spec coverage)

- Continuation signal (spec Component 1/2) → Task 1.
- Flag + shadow/enforce gating (spec Feature flag, Component 3) → Tasks 2–3.
- Candidate-filter tightening on enforce only (spec Component 3) → Task 3.
- Service telemetry: per-scan coverage + per would-be-continuation (spec Observability) → Task 3.
- Rules: entry OR, operator note, ranking, entry-time extension logging, checklist, payload, glossary (spec Component 4) → Task 5.
- Day-1 identity documented + tested (spec Component 1 note) → Task 1 Step 1/3.
- Default-OFF / shadow rollout (spec Rollout) → Tasks 2, 4, 6.
- Out of scope (window-widening, warmer, 429, anti-chase guard, forward-tracking subsystem) → not implemented, per spec.

**Note on PEAD-path regression coverage:** the enforce test exercises the
continuation OR-branch and the both-false drop; the `peadReady` OR-branch is the
unchanged `|| peadReady` term, and PEAD stage computation is already covered by
the existing `TestAnalyzeDriftPEAD_*` tests. A bespoke 210-bar grade-A/B BREAKOUT
compute fixture was deliberately omitted as disproportionate to the one-token
change in the filter expression.
```
