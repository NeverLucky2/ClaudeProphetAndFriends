# Coil Shadow Eval — Plan 1: `signal-series` Go Endpoint

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only `GET /api/v1/meanrev/signal-series/:symbol?days=N` endpoint that returns a name's per-trading-day Coil signal (`close`, `rsi_2`, `sma_5`, `sma_200`) over the most recent N days, so the shadow-eval scorer can replay Coil's exit rule retrospectively and reproducibly.

**Architecture:** Reuse Coil's exact math, never re-derive it: for each returned day the service re-slices the fetched bar history into the existing `ComputeMeanRevSignal(symbol, prefix)`. Layering mirrors the existing `signal/:symbol` path — `MeanRevController` → `MeanRevCandidatesService` → `MeanRevSignalService`. Read-only; touches no order path.

**Tech Stack:** Go, gin, existing `prophet-trader/services` + `prophet-trader/controllers` packages, `go test`.

## Global Constraints

- **No re-derivation of signal math.** Every returned day is produced by `ComputeMeanRevSignal`; do not reimplement RSI/SMA.
- **No `0` SMA sentinel.** `meanRevSMA` returns `0` for prefixes shorter than its window. Only return days whose inclusive prefix has ≥ `meanRevMinBars` (210) bars, so `sma_200`/`sma_5`/`rsi_2` are always valid. Return fewer than `N` days rather than emit a short-prefix day.
- **Latest-day parity.** The last element of the series MUST equal `GetSignal(symbol)` for the same bars (the scorer and Coil must agree on "today").
- **Read-only, zero blast radius.** No writes, no order endpoints. `days` bounded to `1..14`.
- **The scorer consumes only `last_close`, `rsi_2`, `sma_5`** (and `as_of` for the date); `sma_200` is informational.

---

### Task 1: Service-layer `GetSignalSeries` + candidates wrapper

**Files:**
- Modify: `services/meanrev_signal_service.go` (add `GetSignalSeries` on `MeanRevSignalService`; add `GetSignalSeriesForTicker` on `MeanRevCandidatesService`)
- Test: `services/meanrev_signal_service_test.go` (append)

**Interfaces:**
- Consumes: existing `ComputeMeanRevSignal(symbol string, bars []*interfaces.Bar) *MeanRevSignal`, `meanRevBarLookback`, `meanRevMinBars`, `ErrInsufficientMeanRevHistory`, `s.dataSvc.GetHistoricalBars`.
- Produces:
  - `func (s *MeanRevSignalService) GetSignalSeries(ctx context.Context, symbol string, days int) ([]*MeanRevSignal, error)` — oldest→newest, ≤ `days` elements, each a full-prefix `MeanRevSignal`.
  - `func (s *MeanRevCandidatesService) GetSignalSeriesForTicker(ctx context.Context, ticker string, days int) ([]*MeanRevSignal, error)` — thin pass-through (no earnings enrichment).

- [ ] **Step 1: Write the failing test**

Append to `services/meanrev_signal_service_test.go`:

```go
// ascendingCloses returns L closes rising by `step` from `base` — enough history
// (>= meanRevMinBars) for a valid multi-day signal series.
func ascendingCloses(L int, base, step float64) []float64 {
	closes := make([]float64, L)
	for i := range closes {
		closes[i] = base + step*float64(i)
	}
	return closes
}

// seriesStubFetcher returns a fixed bar slice for any symbol/date range.
type seriesStubFetcher struct{ bars []*interfaces.Bar }

func (f *seriesStubFetcher) GetHistoricalBars(ctx context.Context, symbol string, start, end time.Time, timeframe string) ([]*interfaces.Bar, error) {
	return f.bars, nil
}

func TestGetSignalSeries_LengthOrderingAndParity(t *testing.T) {
	bars := makeMeanRevBars(ascendingCloses(220, 100.0, 0.1))
	svc := NewMeanRevSignalService(&seriesStubFetcher{bars: bars})

	series, err := svc.GetSignalSeries(context.Background(), "aaa", 7)
	if err != nil {
		t.Fatalf("GetSignalSeries error: %v", err)
	}
	if len(series) != 7 {
		t.Fatalf("len(series) = %d, want 7", len(series))
	}
	// Oldest→newest, strictly increasing as_of; every day has a valid (nonzero) SMA-200.
	for i, p := range series {
		if p.SMA200 == 0 {
			t.Errorf("series[%d].SMA200 == 0 (short-prefix sentinel leaked)", i)
		}
		if i > 0 && series[i].AsOf <= series[i-1].AsOf {
			t.Errorf("series not strictly oldest→newest at %d: %q <= %q", i, series[i].AsOf, series[i-1].AsOf)
		}
	}
	// Latest-day parity: last series element equals GetSignal for the same bars.
	single, err := svc.GetSignal(context.Background(), "aaa")
	if err != nil {
		t.Fatalf("GetSignal error: %v", err)
	}
	last := series[len(series)-1]
	if last.AsOf != single.AsOf || last.LastClose != single.LastClose ||
		last.RSI2 != single.RSI2 || last.SMA5 != single.SMA5 || last.SMA200 != single.SMA200 {
		t.Fatalf("latest-day parity failed:\n series=%+v\n single=%+v", last, single)
	}
}

func TestGetSignalSeries_InsufficientHistory(t *testing.T) {
	bars := makeMeanRevBars(constCloses(100, 100.0)) // < meanRevMinBars
	svc := NewMeanRevSignalService(&seriesStubFetcher{bars: bars})
	if _, err := svc.GetSignalSeries(context.Background(), "aaa", 5); !errors.Is(err, ErrInsufficientMeanRevHistory) {
		t.Fatalf("err = %v, want ErrInsufficientMeanRevHistory", err)
	}
}

func TestGetSignalSeries_ClampsToAvailableValidDays(t *testing.T) {
	// 212 bars → only 212-(meanRevMinBars-1) = 3 days have a full 210-bar prefix.
	bars := makeMeanRevBars(ascendingCloses(212, 100.0, 0.1))
	svc := NewMeanRevSignalService(&seriesStubFetcher{bars: bars})
	series, err := svc.GetSignalSeries(context.Background(), "aaa", 10)
	if err != nil {
		t.Fatalf("error: %v", err)
	}
	if len(series) != 3 {
		t.Fatalf("len(series) = %d, want 3 (clamped to valid-prefix days)", len(series))
	}
}

func TestGetSignalSeries_RejectsNonPositiveDays(t *testing.T) {
	svc := NewMeanRevSignalService(&seriesStubFetcher{bars: makeMeanRevBars(ascendingCloses(220, 100.0, 0.1))})
	if _, err := svc.GetSignalSeries(context.Background(), "aaa", 0); err == nil {
		t.Fatal("expected error for days=0")
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./services/ -run TestGetSignalSeries -v`
Expected: FAIL — `svc.GetSignalSeries undefined`.

- [ ] **Step 3: Implement `GetSignalSeries` and the wrapper**

In `services/meanrev_signal_service.go`, add after `GetSignal` (around line 131):

```go
// GetSignalSeries returns the per-day MeanRevSignal for the most recent `days`
// trading bars, each computed AS-OF that day by re-slicing the bar history into
// ComputeMeanRevSignal — so the RSI/SMA math is byte-for-byte the single-day
// path, never re-derived. Order is oldest→newest. Only days whose inclusive
// prefix has >= meanRevMinBars bars are returned, so SMA-200/SMA-5/RSI are always
// valid (never the meanRevSMA "0 on short prefix" sentinel); if fewer valid days
// exist than requested, fewer are returned. The last element equals GetSignal for
// the same bars (latest-day parity).
func (s *MeanRevSignalService) GetSignalSeries(ctx context.Context, symbol string, days int) ([]*MeanRevSignal, error) {
	if days <= 0 {
		return nil, fmt.Errorf("days must be positive, got %d", days)
	}
	end := time.Now()
	start := end.AddDate(0, 0, -meanRevBarLookback)
	bars, err := s.dataSvc.GetHistoricalBars(ctx, symbol, start, end, "1Day")
	if err != nil {
		return nil, fmt.Errorf("fetch bars for %s: %w", symbol, err)
	}
	if len(bars) < meanRevMinBars {
		return nil, ErrInsufficientMeanRevHistory
	}
	// Inclusive prefix bars[:idx+1] first reaches meanRevMinBars bars at idx = meanRevMinBars-1.
	firstValid := meanRevMinBars - 1
	startIdx := len(bars) - days
	if startIdx < firstValid {
		startIdx = firstValid
	}
	out := make([]*MeanRevSignal, 0, len(bars)-startIdx)
	for k := startIdx; k < len(bars); k++ {
		out = append(out, ComputeMeanRevSignal(symbol, bars[:k+1]))
	}
	return out, nil
}
```

In the same file, add after `GetSignalForTicker` (around line 409):

```go
// GetSignalSeriesForTicker backs GET /api/v1/meanrev/signal-series/:symbol. It is
// a thin pass-through to the signal service; earnings enrichment is intentionally
// NOT applied — the shadow-eval scorer consumes only price/RSI/SMA, and a per-day
// earnings recompute would be both wrong (the earnings flag is as-of "now", not
// as-of each historical day) and unnecessary.
func (s *MeanRevCandidatesService) GetSignalSeriesForTicker(ctx context.Context, ticker string, days int) ([]*MeanRevSignal, error) {
	return s.signalSvc.GetSignalSeries(ctx, ticker, days)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./services/ -run TestGetSignalSeries -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add services/meanrev_signal_service.go services/meanrev_signal_service_test.go
git commit -m "feat(meanrev): GetSignalSeries — per-day as-of signal history"
```

---

### Task 2: Controller handler + route registration

**Files:**
- Modify: `controllers/meanrev_controller.go` (add `HandleGetSignalSeries`; add `strconv` import)
- Modify: `cmd/bot/main.go:805` area (register the route)
- Test: `controllers/meanrev_controller_test.go` (append)

**Interfaces:**
- Consumes: `mc.candidatesSvc.GetSignalSeriesForTicker(ctx, symbol, days)` from Task 1; existing test helper `newTestMeanRevController()` (universe `["AAA"]`, symbol `AAA` has 220 pullback bars).
- Produces: `GET /api/v1/meanrev/signal-series/:symbol?days=N` → `{ "symbol", "count", "series": []MeanRevSignal }` (200); 400 on bad `days`; 422 on insufficient history; 500 on fetch failure.

- [ ] **Step 1: Write the failing test**

Append to `controllers/meanrev_controller_test.go`:

```go
func TestMeanRevController_HandleGetSignalSeries_OK(t *testing.T) {
	gin.SetMode(gin.TestMode)
	mc := newTestMeanRevController()
	router := gin.New()
	router.GET("/signal-series/:symbol", mc.HandleGetSignalSeries)

	req := httptest.NewRequest(http.MethodGet, "/signal-series/aaa?days=5", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", w.Code, w.Body.String())
	}
	var resp struct {
		Symbol string                    `json:"symbol"`
		Count  int                       `json:"count"`
		Series []services.MeanRevSignal  `json:"series"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, w.Body.String())
	}
	if resp.Symbol != "AAA" || resp.Count != 5 || len(resp.Series) != 5 {
		t.Fatalf("symbol=%q count=%d len=%d, want AAA/5/5", resp.Symbol, resp.Count, len(resp.Series))
	}
	if resp.Series[4].Ticker != "AAA" {
		t.Errorf("last series Ticker = %q, want AAA", resp.Series[4].Ticker)
	}
}

func TestMeanRevController_HandleGetSignalSeries_BadDays(t *testing.T) {
	gin.SetMode(gin.TestMode)
	mc := newTestMeanRevController()
	router := gin.New()
	router.GET("/signal-series/:symbol", mc.HandleGetSignalSeries)

	for _, q := range []string{"days=0", "days=99", "days=abc"} {
		req := httptest.NewRequest(http.MethodGet, "/signal-series/aaa?"+q, nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		if w.Code != http.StatusBadRequest {
			t.Errorf("%s → status %d, want 400", q, w.Code)
		}
	}
}

func TestMeanRevController_HandleGetSignalSeries_InsufficientHistory(t *testing.T) {
	gin.SetMode(gin.TestMode)
	mc := newTestMeanRevController()
	router := gin.New()
	router.GET("/signal-series/:symbol", mc.HandleGetSignalSeries)

	req := httptest.NewRequest(http.MethodGet, "/signal-series/MISSING?days=5", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422; body=%s", w.Code, w.Body.String())
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./controllers/ -run TestMeanRevController_HandleGetSignalSeries -v`
Expected: FAIL — `mc.HandleGetSignalSeries undefined`.

- [ ] **Step 3: Implement the handler**

In `controllers/meanrev_controller.go`, add `"strconv"` to the import block, then add after `HandleGetSignal` (around line 75):

```go
// HandleGetSignalSeries returns the per-day signal series for the most recent N
// trading days. GET /api/v1/meanrev/signal-series/:symbol?days=N (default 7,
// range 1..14). Fewer than N days are returned when the name lacks enough
// history for N full-prefix days; `count` reports the actual number.
func (mc *MeanRevController) HandleGetSignalSeries(c *gin.Context) {
	symbol := strings.ToUpper(c.Param("symbol"))
	if symbol == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "symbol path param required"})
		return
	}
	days := 7
	if q := c.Query("days"); q != "" {
		n, err := strconv.Atoi(q)
		if err != nil || n < 1 || n > 14 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "days must be an integer in 1..14"})
			return
		}
		days = n
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 10*time.Second)
	defer cancel()

	series, err := mc.candidatesSvc.GetSignalSeriesForTicker(ctx, symbol, days)
	if errors.Is(err, services.ErrInsufficientMeanRevHistory) {
		c.JSON(http.StatusUnprocessableEntity, gin.H{
			"error":            fmt.Sprintf("insufficient history for %s", symbol),
			"minimum_required": 210,
		})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"symbol": symbol, "count": len(series), "series": series})
}
```

- [ ] **Step 4: Register the route**

In `cmd/bot/main.go`, immediately after the existing line 805 `meanrev.GET("/signal/:symbol", meanRevController.HandleGetSignal)`, add:

```go
			meanrev.GET("/signal-series/:symbol", meanRevController.HandleGetSignalSeries)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `go test ./controllers/ -run TestMeanRevController_HandleGetSignalSeries -v`
Expected: PASS (3 tests).

- [ ] **Step 6: Build and full package test**

Run: `go build ./... && go test ./services/ ./controllers/`
Expected: build succeeds; both packages PASS.

- [ ] **Step 7: Commit**

```bash
git add controllers/meanrev_controller.go controllers/meanrev_controller_test.go cmd/bot/main.go
git commit -m "feat(meanrev): signal-series endpoint + route"
```

---

## Self-Review

- **Spec coverage.** Implements the spec's "one new Go surface" (`signal-series`), the "reuse `ComputeMeanRevSignal`, no re-derivation" constraint (re-slice per day), the "no `0` SMA sentinel / full-prefix days only" hardening (feasibility-2), latest-day parity, and the read-only zero-blast-radius requirement. The scorer's needed fields (`last_close`, `rsi_2`, `sma_5`, `as_of`) are all present on `MeanRevSignal`.
- **Placeholder scan.** None — every step has runnable code and exact commands.
- **Type consistency.** `GetSignalSeries` / `GetSignalSeriesForTicker` / `HandleGetSignalSeries` names and the `([]*MeanRevSignal, error)` signature are consistent across service, wrapper, controller, and tests. Route path matches the handler.
- **Deferred to later plans.** The daily job, scorer, regression/verdict, and scheduler wiring are Plans 2–3; they consume this endpoint but are out of scope here.
