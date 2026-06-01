# Turtle-v2 — Broadened Basket + Correlation-Cluster Caps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Broaden the Turtle/Trend Donchian basket from 6 to 15 ETFs across 6 macro-driver clusters, and add a two-layer diversification control (static one-position-per-cluster cap + a dynamic positive-correlation guard) so the mechanical trend system stays uncorrelated ballast instead of quietly concentrating into co-moving breakouts.

**Architecture:** A single cluster-annotated universe (`models.TrendUniverse`) replaces the two hand-synced `[]string` copies in `controllers` and `services`. The signal struct (`TrendSignal`) starts carrying the close-price series it already computes (behind `json:"-"`, so the HTTP payload is unchanged), letting the entry loop derive daily returns for the correlation guard with no new data dependency. Two pure gate functions (`clusterSlotTaken`, `tooCorrelated`) are wired into the entry loop after the existing eligibility ladder. All existing mechanics (Donchian-100/50, ATR-20 sizing, 2×ATR stop, 2.5% aggregate-risk cap, cold-start filter, 0.5% vol floor, regime multiplier, scheduler cadence) are unchanged.

**Tech Stack:** Go (standard library + `gorm`, `logrus`, `gin`). Tests are standard `go test` table/stub style following the existing `turtle_executor_test.go` patterns. No new third-party dependencies.

---

## Key decisions & deviations from the spec (read before executing)

The spec (`docs/superpowers/specs/2026-05-31-turtle-v2-broaden-basket-design.md`) was written believing the entry loop already had the daily bars in hand. Grounding the build surfaced a few facts that shape this plan. None expand scope beyond "broaden the basket + add the two caps," but the operator should sanity-check these:

- **D-A1 — `TrendSignal` discards its bars; the correlation guard needs a return series.** `services.TrendSignalService.GetSignal` fetches bars, computes summary scalars in `ComputeSignal`, and throws the bars away. The executor's `barFetcher` interface only exposes `GetLatestBar` (one bar), not history. **Resolution:** add `Closes []float64` (tagged `json:"-"`) to `TrendSignal`, populated from the slice `ComputeSignal` already builds. This is "reuse already-fetched bars" in the meaningful sense — same dependency, same fetch, we simply stop discarding the closes — and it keeps the bars out of the HTTP `/api/v1/trend/signal/:symbol` response.
- **D-A2 — open-position returns are fetched in the entry loop via the existing signal feed.** Open positions aren't entry candidates (they're skipped as `held`), so their return series isn't otherwise available in `runEntries`. `openPositionReturns` re-reads each open position's signal through the same `signalFetcher`. At a once-daily cadence over ≤6 positions this duplicate read (the exit loop already fetched them) is negligible, and it keeps the entry path self-contained — **no new interface, no new Alpaca endpoint, no new data path.**
- **D-A3 — the centralized universe lives in `models`, not `controllers`.** `services` cannot import `controllers` (that would cycle — `controllers` imports `services`). `models` is the lowest layer both already import, and the spec's own note suggested "a shared models package." So `models.TrendUniverse` is the single source of truth; `controllers` and `services` both read from it.
- **D-A4 — `turtlePositionCap` raised 5 → 6, but the 2.5% aggregate-risk cap is the real ceiling.** Per-trade risk is exactly 0.5% of portfolio whenever a position isn't notional-capped (proven in the existing `TestRunEntries_AggregateRiskCapBlocks` comments). So ~5 full-risk positions already hit the 2.5% aggregate cap before a 6th cluster could fill. Raising the count cap to 6 (= the cluster count) per spec §6 keeps an arbitrary count cap from pre-empting the cluster logic; the cluster caps + aggregate-risk cap remain the binding gates. This is expected, not a bug.
- **D-A5 — "build-time liquidity/history check" is implemented as a clean per-beat skip, not a startup probe.** The entry loop already safely skips any ETF whose history is insufficient (`GetSignal` → `ErrInsufficientHistory`). We refine that path so insufficient history is recorded as a `Skip` ("thin name — dropped") rather than an `Error`, satisfying the spec's "dropped from the active universe with a logged skip — never failing the whole run" intent with zero new infrastructure. **Volume-based liquidity filtering is out of scope** — no volume is plumbed into the signal, and all 15 ETFs are liquid enough to trade in paper sizing. If the operator wants a true startup liquidity probe, that's a follow-up, not part of this build.
- **D-A6 — the rules doc is updated.** `TRADING_RULES_TREND.md` currently documents a 6-ETF universe and explicitly states the 6-ticker trim "removes the need for a 'max 1 per bucket' rule" — which v2 reverses. Task 7 corrects the Universe section and the enumerated ticker lists so the spec-of-record doesn't drift.

If any of D-A1…D-A6 is wrong for the operator's intent, stop and revise before Task 3.

---

## File structure

| File | Create/Modify | Responsibility |
|---|---|---|
| `models/trend_universe.go` | **Create** | Single source of truth: `TrendInstrument`, `TrendUniverse` (15 ETFs / 6 clusters), `TrendUniverseTickers()`, `ClusterOf()`, `InTrendUniverse()`. |
| `models/trend_universe_test.go` | **Create** | Tests for the centralized universe + helpers. |
| `controllers/trend_controller.go` | Modify | Delete local `TrendUniverse []string` + local `inTrendUniverse`; read from `models`. |
| `cmd/bot/main.go` | Modify (`:199-203`) | Point the agent-universe gate at `models.TrendUniverseTickers()`. |
| `services/trend_signal_service.go` | Modify (`:32-42`, `:78-98`) | Add `Closes []float64 \`json:"-"\`` to `TrendSignal`; populate it in `ComputeSignal`. |
| `services/trend_signal_service_test.go` | Modify | Test that `Closes` is populated and stays out of the JSON payload. |
| `services/turtle_diversification.go` | **Create** | Pure primitives: `dailyReturns`, `pearsonR`, `trailing`, `clusterSlotTaken`, `tooCorrelated`. |
| `services/turtle_diversification_test.go` | **Create** | Unit tests for all five primitives. |
| `services/turtle_executor.go` | Modify | Delete `turtleUniverse`; iterate `models.TrendUniverse`; raise `turtlePositionCap`; add diversification constants; `openPositionReturns`; wire both gates into `runEntries`; clean insufficient-history skip. |
| `services/turtle_executor_test.go` | Modify | Centralize universe refs; rewrite the position-count test; add cluster-cap + correlation integration tests. |
| `TRADING_RULES_TREND.md` | Modify (`:60-77`, `:253`, `:359`) | Document the 15-ETF basket + the two diversification caps. |

---

## Task 1: Centralize the universe in `models` (broadened 15-ETF / 6-cluster list)

**Files:**
- Create: `models/trend_universe.go`
- Test: `models/trend_universe_test.go`

- [ ] **Step 1: Write the failing test**

Create `models/trend_universe_test.go`:

```go
package models

import "testing"

func TestTrendUniverse_FifteenInstrumentsSixClusters(t *testing.T) {
	if len(TrendUniverse) != 15 {
		t.Fatalf("TrendUniverse: got %d instruments, want 15", len(TrendUniverse))
	}
	wantClusters := map[string]int{
		"rates": 3, "metals": 2, "energy": 2, "commodity": 3, "fx": 3, "intl_equity": 2,
	}
	got := map[string]int{}
	seen := map[string]bool{}
	for _, inst := range TrendUniverse {
		if inst.Ticker == "" || inst.Cluster == "" {
			t.Errorf("instrument missing field: %+v", inst)
		}
		if seen[inst.Ticker] {
			t.Errorf("duplicate ticker %q in TrendUniverse", inst.Ticker)
		}
		seen[inst.Ticker] = true
		got[inst.Cluster]++
	}
	for cluster, want := range wantClusters {
		if got[cluster] != want {
			t.Errorf("cluster %q: got %d members, want %d", cluster, got[cluster], want)
		}
	}
	if len(got) != len(wantClusters) {
		t.Errorf("got %d clusters, want %d (%v)", len(got), len(wantClusters), got)
	}
}

func TestClusterOf(t *testing.T) {
	cases := map[string]string{
		"TLT": "rates", "IEF": "rates", "TIP": "rates",
		"GLD": "metals", "SLV": "metals",
		"USO": "energy", "UNG": "energy",
		"DBC": "commodity", "DBA": "commodity", "DBB": "commodity",
		"UUP": "fx", "FXE": "fx", "FXY": "fx",
		"EEM": "intl_equity", "EFA": "intl_equity",
	}
	for ticker, want := range cases {
		if got := ClusterOf(ticker); got != want {
			t.Errorf("ClusterOf(%q): got %q, want %q", ticker, got, want)
		}
	}
	if got := ClusterOf("tlt"); got != "rates" {
		t.Errorf("ClusterOf must be case-insensitive: ClusterOf(\"tlt\")=%q, want rates", got)
	}
	if got := ClusterOf("SPY"); got != "" {
		t.Errorf("ClusterOf(\"SPY\"): got %q, want \"\" (not in universe)", got)
	}
}

func TestTrendUniverseTickers(t *testing.T) {
	tickers := TrendUniverseTickers()
	if len(tickers) != len(TrendUniverse) {
		t.Fatalf("TrendUniverseTickers: got %d, want %d", len(tickers), len(TrendUniverse))
	}
	for i, inst := range TrendUniverse {
		if tickers[i] != inst.Ticker {
			t.Errorf("ticker[%d]: got %q, want %q", i, tickers[i], inst.Ticker)
		}
	}
}

func TestInTrendUniverse(t *testing.T) {
	if !InTrendUniverse("EEM") {
		t.Errorf("EEM must be in the universe")
	}
	if !InTrendUniverse("eem") {
		t.Errorf("InTrendUniverse must be case-insensitive")
	}
	if InTrendUniverse("TSLA") {
		t.Errorf("TSLA must not be in the universe")
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./models/ -run 'TestTrendUniverse|TestClusterOf|TestInTrendUniverse' -v`
Expected: FAIL to compile — `undefined: TrendUniverse`, `undefined: ClusterOf`, etc.

- [ ] **Step 3: Write the implementation**

Create `models/trend_universe.go`:

```go
package models

import "strings"

// TrendInstrument is one ETF in the Turtle/Trend basket, annotated with its
// macro-driver cluster. The cluster drives the one-position-per-driver
// diversification cap (see services.clusterSlotTaken).
type TrendInstrument struct {
	Ticker  string
	Cluster string
}

// TrendUniverse is the single source of truth for the Turtle/Trend basket:
// 15 liquid, unleveraged, non-inverse ETFs spanning 6 genuinely different
// macro drivers. No leveraged/inverse names (decay destroys trend systems);
// no broad-equity beta except the capped intl_equity cluster. Both the HTTP
// controller (controllers.TrendController) and the Go executor
// (services.TurtleExecutor) read from this list — do not re-declare it.
var TrendUniverse = []TrendInstrument{
	{"TLT", "rates"}, {"IEF", "rates"}, {"TIP", "rates"},
	{"GLD", "metals"}, {"SLV", "metals"},
	{"USO", "energy"}, {"UNG", "energy"},
	{"DBC", "commodity"}, {"DBA", "commodity"}, {"DBB", "commodity"},
	{"UUP", "fx"}, {"FXE", "fx"}, {"FXY", "fx"},
	{"EEM", "intl_equity"}, {"EFA", "intl_equity"},
}

// TrendUniverseTickers returns just the tickers, for call sites that need a
// plain []string (the agent-universe gate; the controller's 400 payload).
func TrendUniverseTickers() []string {
	out := make([]string, len(TrendUniverse))
	for i, inst := range TrendUniverse {
		out[i] = inst.Ticker
	}
	return out
}

// ClusterOf returns the driver cluster for a ticker (case-insensitive), or ""
// if the ticker is not part of the trend universe.
func ClusterOf(ticker string) string {
	t := strings.ToUpper(strings.TrimSpace(ticker))
	for _, inst := range TrendUniverse {
		if inst.Ticker == t {
			return inst.Cluster
		}
	}
	return ""
}

// InTrendUniverse reports whether ticker is part of the trend basket.
func InTrendUniverse(ticker string) bool {
	return ClusterOf(ticker) != ""
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test ./models/ -run 'TestTrendUniverse|TestClusterOf|TestInTrendUniverse' -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add models/trend_universe.go models/trend_universe_test.go
git commit -m "feat(turtle-v2): centralized 15-ETF / 6-cluster trend universe in models"
```

---

## Task 2: Migrate `controllers` + `main.go` to the centralized universe

**Files:**
- Modify: `controllers/trend_controller.go`
- Modify: `cmd/bot/main.go:199-203`

There is no `controllers/trend_controller_test.go`, so this is a pure wiring change; correctness is verified by the package compiling and `go vet` passing.

- [ ] **Step 1: Update the controller to read from `models`**

In `controllers/trend_controller.go`:

(a) Add the `models` import. Change the import block:

```go
import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"prophet-trader/models"
	"prophet-trader/services"
)
```

(b) Delete the local universe declaration (lines 16-18):

```go
// TrendUniverse is the fixed set of ETFs TrendProphet trades. Requests for
// any other symbol return 400. The list mirrors TRADING_RULES_TREND.md.
var TrendUniverse = []string{"TLT", "GLD", "USO", "DBC", "UUP", "EEM"}
```

(c) In `HandleGetSignal`, replace the membership check + 400 payload:

```go
	symbol := strings.ToUpper(c.Param("symbol"))
	if !models.InTrendUniverse(symbol) {
		c.JSON(http.StatusBadRequest, gin.H{
			"error":    fmt.Sprintf("symbol %s not in trend universe", symbol),
			"universe": models.TrendUniverseTickers(),
		})
		return
	}
```

(d) Delete the now-unused local helper at the bottom of the file:

```go
func inTrendUniverse(s string) bool {
	for _, t := range TrendUniverse {
		if t == s {
			return true
		}
	}
	return false
}
```

- [ ] **Step 2: Update the agent-universe gate in `main.go`**

In `cmd/bot/main.go`, update the comment at line 197-198 and the gate at line 202. Change:

```go
	// MeanRev/Drift from their scanner constants, Trend from controllers.
	// TrendUniverse (which services.turtleUniverse mirrors). Agents absent here
	// (Main/Penny) fail open — the gate never blocks them.
	agentUniverses := map[services.AgentSource]map[string]bool{
		services.AgentMeanRev: services.SymbolSet(services.MeanRevUniverse),
		services.AgentDrift:   services.SymbolSet(services.DriftUniverse),
		services.AgentTrend:   services.SymbolSet(controllers.TrendUniverse),
	}
```

to:

```go
	// MeanRev/Drift from their scanner constants, Trend from the centralized
	// models.TrendUniverse (the single source of truth the executor iterates).
	// Agents absent here (Main/Penny) fail open — the gate never blocks them.
	agentUniverses := map[services.AgentSource]map[string]bool{
		services.AgentMeanRev: services.SymbolSet(services.MeanRevUniverse),
		services.AgentDrift:   services.SymbolSet(services.DriftUniverse),
		services.AgentTrend:   services.SymbolSet(models.TrendUniverseTickers()),
	}
```

Note: `cmd/bot/main.go` already imports `prophet-trader/models` (it constructs DB models). If `go build` reports `models` is not imported, add `"prophet-trader/models"` to the import block.

> ⚠️ This step is load-bearing: the executor will start placing orders for the 9 new ETFs in Task 5. If the agent-universe gate isn't widened too, `TradeGuard.CheckBuy` would reject every new ticker. Both must move together.

- [ ] **Step 3: Verify the packages compile and vet cleanly**

Run: `go build ./... && go vet ./controllers/ ./cmd/bot/`
Expected: no output (success). In particular, no `controllers.TrendUniverse` references remain.

- [ ] **Step 4: Commit**

```bash
git add controllers/trend_controller.go cmd/bot/main.go
git commit -m "refactor(turtle-v2): controllers + main read trend universe from models"
```

---

## Task 3: Carry the close-price series on `TrendSignal`

**Files:**
- Modify: `services/trend_signal_service.go:32-42` (struct), `:78-98` (`ComputeSignal`)
- Test: `services/trend_signal_service_test.go`

- [ ] **Step 1: Write the failing test**

Append to `services/trend_signal_service_test.go` (it already imports `encoding/json`? it does NOT — add `"encoding/json"` and `"strings"` to its import block first):

```go
func TestComputeSignal_PopulatesClosesButHidesFromJSON(t *testing.T) {
	closes := make([]float64, 260)
	for i := range closes {
		closes[i] = 100.0 + float64(i)
	}
	sig := ComputeSignal("TEST", makeBars(closes))

	if len(sig.Closes) != len(closes) {
		t.Fatalf("Closes length: got %d, want %d", len(sig.Closes), len(closes))
	}
	if sig.Closes[len(sig.Closes)-1] != closes[len(closes)-1] {
		t.Errorf("last close: got %v, want %v", sig.Closes[len(sig.Closes)-1], closes[len(closes)-1])
	}
	if sig.Closes[len(sig.Closes)-1] != sig.LastClose {
		t.Errorf("Closes tail (%v) must equal LastClose (%v)", sig.Closes[len(sig.Closes)-1], sig.LastClose)
	}

	// Closes must NOT appear in the JSON payload (json:"-").
	b, err := json.Marshal(sig)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(b), "Closes") || strings.Contains(string(b), "\"closes\"") {
		t.Errorf("Closes must be excluded from JSON, got: %s", b)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./services/ -run TestComputeSignal_PopulatesClosesButHidesFromJSON -v`
Expected: FAIL — `sig.Closes undefined (type *TrendSignal has no field or method Closes)`.

- [ ] **Step 3: Add the field and populate it**

In `services/trend_signal_service.go`, add the field to `TrendSignal` (after `SignalVersion`):

```go
// TrendSignal is the JSON shape returned by GET /api/v1/trend/signal/:symbol.
type TrendSignal struct {
	Ticker          string  `json:"ticker"`
	AsOf            string  `json:"as_of"`
	BarsCount       int     `json:"bars_count"`
	LastClose       float64 `json:"last_close"`
	Donchian100High float64 `json:"donchian_100_high"`
	Donchian50Low   float64 `json:"donchian_50_low"`
	SMA200          float64 `json:"sma_200"`
	ATR20           float64 `json:"atr_20"`
	SignalVersion   string  `json:"signal_version"`

	// Closes is the full daily close series (oldest→newest) used as a
	// fixed-window correlation feed by the Turtle entry loop. Excluded from
	// the HTTP signal payload (json:"-") — it would bloat the response and no
	// API consumer needs it.
	Closes []float64 `json:"-"`
}
```

In `ComputeSignal`, set `Closes` in the returned struct literal:

```go
	return &TrendSignal{
		Ticker:          symbol,
		AsOf:            bars[L-1].Timestamp.Format(time.RFC3339),
		BarsCount:       L,
		LastClose:       closes[L-1],
		Donchian100High: donchianHigh(closes, donchianHighWindow),
		Donchian50Low:   donchianLow(closes, donchianLowWindow),
		SMA200:          sma(closes, smaWindow),
		ATR20:           wilderATR(highs, lows, closes, atrWindow),
		SignalVersion:   signalVersion,
		Closes:          closes,
	}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test ./services/ -run TestComputeSignal_PopulatesClosesButHidesFromJSON -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/trend_signal_service.go services/trend_signal_service_test.go
git commit -m "feat(turtle-v2): TrendSignal carries close series for the correlation guard"
```

---

## Task 4: Pure diversification primitives

**Files:**
- Create: `services/turtle_diversification.go`
- Test: `services/turtle_diversification_test.go`

These are pure, side-effect-free functions. Build and fully test them before wiring anything into the executor.

- [ ] **Step 1: Write the failing tests**

Create `services/turtle_diversification_test.go`:

```go
package services

import (
	"math"
	"testing"

	"prophet-trader/models"
)

func TestDailyReturns(t *testing.T) {
	got := dailyReturns([]float64{100, 110, 99})
	want := []float64{0.10, -0.10}
	if len(got) != len(want) {
		t.Fatalf("len: got %d, want %d", len(got), len(want))
	}
	for i := range want {
		if math.Abs(got[i]-want[i]) > 1e-9 {
			t.Errorf("returns[%d]: got %v, want %v", i, got[i], want[i])
		}
	}
	if r := dailyReturns([]float64{100}); r != nil {
		t.Errorf("single close must yield nil returns, got %v", r)
	}
	if r := dailyReturns(nil); r != nil {
		t.Errorf("nil closes must yield nil returns, got %v", r)
	}
}

func TestPearson_PerfectPositive(t *testing.T) {
	rho, ok := pearsonR([]float64{1, 2, 3, 4}, []float64{2, 4, 6, 8})
	if !ok {
		t.Fatal("expected ok=true")
	}
	if math.Abs(rho-1.0) > 1e-9 {
		t.Errorf("got %v, want +1", rho)
	}
}

func TestPearson_PerfectNegative(t *testing.T) {
	rho, ok := pearsonR([]float64{1, 2, 3, 4}, []float64{4, 3, 2, 1})
	if !ok {
		t.Fatal("expected ok=true")
	}
	if math.Abs(rho+1.0) > 1e-9 {
		t.Errorf("got %v, want -1", rho)
	}
}

func TestPearson_Orthogonal(t *testing.T) {
	rho, ok := pearsonR([]float64{1, -1, 1, -1}, []float64{1, 1, -1, -1})
	if !ok {
		t.Fatal("expected ok=true")
	}
	if math.Abs(rho) > 1e-9 {
		t.Errorf("orthogonal series: got %v, want ~0", rho)
	}
}

func TestPearson_UnusableInputs(t *testing.T) {
	if _, ok := pearsonR([]float64{1}, []float64{1}); ok {
		t.Error("n<2 must be ok=false")
	}
	if _, ok := pearsonR([]float64{1, 2, 3}, []float64{1, 2}); ok {
		t.Error("length mismatch must be ok=false")
	}
	if _, ok := pearsonR([]float64{5, 5, 5}, []float64{1, 2, 3}); ok {
		t.Error("zero variance must be ok=false")
	}
}

func TestTrailing(t *testing.T) {
	if got := trailing([]float64{1, 2, 3, 4, 5}, 3); len(got) != 3 || got[0] != 3 || got[2] != 5 {
		t.Errorf("trailing last 3: got %v", got)
	}
	if got := trailing([]float64{1, 2}, 3); got != nil {
		t.Errorf("series shorter than window must be nil, got %v", got)
	}
	if got := trailing([]float64{1, 2, 3}, 0); got != nil {
		t.Errorf("zero window must be nil, got %v", got)
	}
}

func openRow(ticker, status string) *models.DBTrendLedgerEntry {
	return &models.DBTrendLedgerEntry{Ticker: ticker, Status: status}
}

func TestClusterSlotTaken(t *testing.T) {
	// TLT, IEF, TIP are all "rates"; GLD is "metals".
	if clusterSlotTaken(nil, "rates", 1) {
		t.Error("empty book: slot must be free")
	}
	one := []*models.DBTrendLedgerEntry{openRow("TLT", "open")}
	if !clusterSlotTaken(one, "rates", 1) {
		t.Error("one open rates position at max 1 must report taken")
	}
	if clusterSlotTaken(one, "metals", 1) {
		t.Error("a different cluster must be free")
	}
	if clusterSlotTaken(one, "rates", 2) {
		t.Error("one open position with max 2 must still be free")
	}
	// Pending fills occupy a slot; closed rows free it.
	pend := []*models.DBTrendLedgerEntry{openRow("IEF", "pending_fill")}
	if !clusterSlotTaken(pend, "rates", 1) {
		t.Error("pending_fill must occupy a cluster slot")
	}
	closed := []*models.DBTrendLedgerEntry{openRow("TLT", "closed")}
	if clusterSlotTaken(closed, "rates", 1) {
		t.Error("a closed row must not occupy a cluster slot")
	}
	// Unknown candidate cluster never binds.
	if clusterSlotTaken(one, "", 1) {
		t.Error("empty candidate cluster must never report taken")
	}
}

func TestTooCorrelated(t *testing.T) {
	cand := []float64{0.01, 0.02, 0.03, 0.01}

	// Identical series → ρ=+1 > 0.7 → blocked.
	if !tooCorrelated(cand, map[string][]float64{"X": {0.01, 0.02, 0.03, 0.01}}, 0.70, 4) {
		t.Error("perfectly +correlated open must block the candidate")
	}
	// Mirrored series → ρ=-1 → allowed (diversifying).
	if tooCorrelated(cand, map[string][]float64{"X": {-0.01, -0.02, -0.03, -0.01}}, 0.70, 4) {
		t.Error("anti-correlated open must NOT block (negative ρ is diversifying)")
	}
	// Empty book → allowed.
	if tooCorrelated(cand, map[string][]float64{}, 0.70, 4) {
		t.Error("no open positions must not block")
	}
	// Candidate has fewer returns than window → cannot assess → allowed.
	if tooCorrelated([]float64{0.01, 0.02}, map[string][]float64{"X": {0.01, 0.02, 0.03, 0.01}}, 0.70, 4) {
		t.Error("candidate shorter than window must not block (cannot assess)")
	}
	// One unassessable open (too short) + one highly correlated → blocked.
	book := map[string][]float64{
		"SHORT": {0.01, 0.02},
		"HOT":   {0.01, 0.02, 0.03, 0.01},
	}
	if !tooCorrelated(cand, book, 0.70, 4) {
		t.Error("a single +correlated open among others must block")
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./services/ -run 'TestDailyReturns|TestPearson|TestTrailing|TestClusterSlotTaken|TestTooCorrelated' -v`
Expected: FAIL to compile — `undefined: dailyReturns`, `undefined: pearsonR`, etc.

- [ ] **Step 3: Write the implementation**

Create `services/turtle_diversification.go`:

```go
package services

import (
	"math"

	"prophet-trader/models"
)

// dailyReturns converts a close-price series into simple daily returns:
// r[i] = closes[i]/closes[i-1] - 1. Output length is len(closes)-1. A series
// shorter than 2 yields nil. A non-positive prior close (defensive — equity
// ETF closes are always positive) ends the series early.
func dailyReturns(closes []float64) []float64 {
	if len(closes) < 2 {
		return nil
	}
	out := make([]float64, 0, len(closes)-1)
	for i := 1; i < len(closes); i++ {
		if closes[i-1] <= 0 {
			return out
		}
		out = append(out, closes[i]/closes[i-1]-1)
	}
	return out
}

// pearsonR returns the Pearson correlation coefficient of two equal-length
// series with ok=true, or (0,false) when the inputs are unusable: unequal
// lengths, fewer than 2 points, or zero variance in either series (a flat
// series has no defined correlation).
func pearsonR(a, b []float64) (float64, bool) {
	n := len(a)
	if n < 2 || len(b) != n {
		return 0, false
	}
	var ma, mb float64
	for i := 0; i < n; i++ {
		ma += a[i]
		mb += b[i]
	}
	ma /= float64(n)
	mb /= float64(n)
	var cov, va, vb float64
	for i := 0; i < n; i++ {
		da := a[i] - ma
		db := b[i] - mb
		cov += da * db
		va += da * da
		vb += db * db
	}
	if va == 0 || vb == 0 {
		return 0, false
	}
	return cov / math.Sqrt(va*vb), true
}

// trailing returns the last `window` elements of s, or nil when s has fewer
// than `window` elements (not enough history to assess).
func trailing(s []float64, window int) []float64 {
	if window <= 0 || len(s) < window {
		return nil
	}
	return s[len(s)-window:]
}

// clusterSlotTaken reports whether the candidate's driver cluster already
// holds at least `max` positions on the book. Only rows still on the book
// (status open or pending_fill) count — a row closed earlier this beat frees
// its slot. With max=1 this enforces one-position-per-driver breadth. An empty
// candidate cluster (ticker not in the universe) never binds.
func clusterSlotTaken(open []*models.DBTrendLedgerEntry, candidateCluster string, max int) bool {
	if candidateCluster == "" {
		return false
	}
	count := 0
	for _, row := range open {
		if row.Status != "open" && row.Status != "pending_fill" {
			continue
		}
		if models.ClusterOf(row.Ticker) == candidateCluster {
			count++
			if count >= max {
				return true
			}
		}
	}
	return false
}

// tooCorrelated reports whether the candidate's return series is positively
// correlated above `threshold` with ANY open position's return series, over
// the trailing `window` returns. Only positive correlation blocks (redundant
// concentration); a negatively-correlated position is diversifying and is
// allowed. A pair whose candidate or open series is shorter than `window` is
// treated as "cannot assess" and does not block.
func tooCorrelated(candidateReturns []float64, openReturnsByTicker map[string][]float64, threshold float64, window int) bool {
	candWin := trailing(candidateReturns, window)
	if candWin == nil {
		return false
	}
	for _, openRets := range openReturnsByTicker {
		openWin := trailing(openRets, window)
		if openWin == nil {
			continue
		}
		rho, ok := pearsonR(candWin, openWin)
		if ok && rho > threshold {
			return true
		}
	}
	return false
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./services/ -run 'TestDailyReturns|TestPearson|TestTrailing|TestClusterSlotTaken|TestTooCorrelated' -v`
Expected: PASS (all subtests green).

- [ ] **Step 5: Commit**

```bash
git add services/turtle_diversification.go services/turtle_diversification_test.go
git commit -m "feat(turtle-v2): pure diversification primitives (cluster cap + correlation guard)"
```

---

## Task 5: Refactor the executor onto the centralized universe (no new gates yet)

This task removes the duplicated `turtleUniverse`, makes the executor iterate `models.TrendUniverse`, raises the position-count cap to 6, and turns insufficient-history into a clean skip. It also updates the existing tests so the suite stays green. **No correlation/cluster gates are wired yet** — that's Task 6 — so the executor's behavior is unchanged except for the broadened basket, the cap bump, and the cleaner skip.

**Files:**
- Modify: `services/turtle_executor.go`
- Modify: `services/turtle_executor_test.go`

- [ ] **Step 1: Update the test scaffolding to the centralized universe**

In `services/turtle_executor_test.go`, add a helper near the top (just after the imports, before the stubs) and repoint `universeIneligibleExcept`:

```go
// universeTickers is the centralized basket's ticker list. Tests that need to
// set up signals/bars across the whole universe range over this instead of a
// local copy.
func universeTickers() []string { return models.TrendUniverseTickers() }
```

Then replace **every** `range turtleUniverse` with `range universeTickers()` (11 sites: in `universeIneligibleExcept`, `TestRunExits_*`, `TestColdStartStaysFalseWhenNoEntryPlaced`, `TestReconcile_FilledFlipsToOpen`, `TestReconcile_PartiallyFilledFlipsToOpenWithReducedShares`, `TestRunHeartbeat_FirstRunCreatesSession`). Find them with:

Run: `grep -n turtleUniverse services/turtle_executor_test.go`

After editing, that grep must return nothing.

- [ ] **Step 2: Make the broadened universe safe for the aggregate-risk test**

`TestRunEntries_AggregateRiskCapBlocks` manually stubs only TLT/GLD/USO/DBC/UUP/EEM; the 9 new tickers would have no signal stub and log spurious errors. Add a single line at the very start of that test body (right after `sigs, bars, trader, seg, regime, guard := fullStubs()`), so the rest of the universe is cleanly ineligible:

```go
	universeIneligibleExcept(sigs, bars, "TLT", "GLD", "USO", "DBC", "UUP", "EEM")
```

(The six excepted tickers keep the signals the test sets explicitly below.)

- [ ] **Step 3: Rewrite the position-count cap test for cap=6**

Replace the whole `TestRunEntries_PositionCountCap5Skips` function with:

```go
func TestRunEntries_PositionCountCapBlocksSeventh(t *testing.T) {
	sigs, bars, trader, seg, regime, guard := fullStubs()
	exe, ledger := newTestExecutor(t, sigs, bars, trader, seg, regime, guard)
	// Six open positions, one per cluster, each with negligible risk so the
	// 2.5% aggregate-risk cap does not pre-empt the count cap.
	for _, sym := range []string{"TLT", "GLD", "USO", "DBC", "UUP", "EEM"} {
		row := &models.DBTrendLedgerEntry{Ticker: sym, Status: "open", Strategy: "trend",
			EntryPrice: 100, Shares: 1, ATRAtEntry: 0.01, EntryDate: at1700(t, "2026-04-10")}
		_ = ledger.Save(row)
		// Hold (no exit) for these tickers.
		sigs.signals[sym] = &TrendSignal{Donchian50Low: 50}
		bars.bars[sym] = &interfaces.Bar{Open: 200}
	}
	// IEF is a valid breakout candidate; with 6 positions already open the
	// position-count cap (6) blocks any 7th entry.
	universeIneligibleExcept(sigs, bars, "TLT", "GLD", "USO", "DBC", "UUP", "EEM", "IEF")
	sigs.signals["IEF"] = goodEntrySignal("IEF")
	bars.bars["IEF"] = &interfaces.Bar{Open: 99, Close: 100}

	if _, err := exe.RunHeartbeat(context.Background(), at1700(t, "2026-05-15")); err != nil {
		t.Fatalf("RunHeartbeat: %v", err)
	}
	for _, o := range trader.placedOrders {
		if o.Side == "buy" {
			t.Errorf("no 7th buy expected at the position-count cap, got %+v", o)
		}
	}
}
```

- [ ] **Step 4: Refactor the executor**

In `services/turtle_executor.go`:

(a) Add `"errors"` to the import block (it is not currently imported):

```go
import (
	"context"
	"errors"
	"fmt"
	"io"
	"time"

	"prophet-trader/interfaces"
	"prophet-trader/models"

	"github.com/sirupsen/logrus"
)
```

(b) Delete the local universe declaration (lines 15-19):

```go
// turtleUniverse mirrors controllers.TrendUniverse — kept local so the
// executor has no upstream import on controllers, which would create a cycle.
// If these ever drift, both must be updated together; consider promoting to
// a shared models package as a follow-up.
var turtleUniverse = []string{"TLT", "GLD", "USO", "DBC", "UUP", "EEM"}
```

(c) Raise the position-count cap in the const block: change `turtlePositionCap = 5` to:

```go
	turtlePositionCap     = 6 // = cluster count; cluster caps + agg-risk cap are the binding gates
```

(d) In `runEntries`, change the loop header to iterate the centralized cluster-annotated universe. Change:

```go
	for _, ticker := range turtleUniverse {
		if _, ok := held[ticker]; ok {
			continue
		}
```

to:

```go
	for _, inst := range models.TrendUniverse {
		ticker := inst.Ticker
		if _, ok := held[ticker]; ok {
			continue
		}
```

(e) In `runEntries`, make insufficient history a clean skip. Change the signal-fetch error block:

```go
		sig, err := e.signals.GetSignal(ctx, ticker)
		if err != nil {
			e.logger.WithFields(logrus.Fields{"ticker": ticker, "stage": "entry_signal"}).WithError(err).Error("turtle entry: signal fetch failed")
			res.Errors = append(res.Errors, fmt.Sprintf("entry %s: signal: %v", ticker, err))
			continue
		}
```

to:

```go
		sig, err := e.signals.GetSignal(ctx, ticker)
		if err != nil {
			if errors.Is(err, ErrInsufficientHistory) {
				// Thin/young ETF (e.g. a recently-listed basket member): drop it
				// from the active universe for this beat with a logged skip
				// rather than a hard error. The run continues.
				res.Skips = append(res.Skips, fmt.Sprintf("%s: insufficient history (thin name) — dropped", ticker))
				continue
			}
			e.logger.WithFields(logrus.Fields{"ticker": ticker, "stage": "entry_signal"}).WithError(err).Error("turtle entry: signal fetch failed")
			res.Errors = append(res.Errors, fmt.Sprintf("entry %s: signal: %v", ticker, err))
			continue
		}
```

- [ ] **Step 5: Run the full services + controllers + cmd build and tests**

Run: `go build ./... && go test ./services/ ./controllers/ -count=1`
Expected: PASS. All existing turtle tests stay green under the broadened universe (the extra ineligible tickers don't place orders); `TestRunEntries_PositionCountCapBlocksSeventh` passes.

- [ ] **Step 6: Confirm the duplicate is gone**

Run: `grep -rn turtleUniverse services/`
Expected: no matches (the var and all test references are gone).

- [ ] **Step 7: Commit**

```bash
git add services/turtle_executor.go services/turtle_executor_test.go
git commit -m "refactor(turtle-v2): executor iterates centralized 15-ETF universe; cap 5->6; clean thin-name skip"
```

---

## Task 6: Wire the two diversification gates into the entry loop

**Files:**
- Modify: `services/turtle_executor.go` (constants, `openPositionReturns`, `runEntries`)
- Modify: `services/turtle_executor_test.go` (integration tests + synthetic-series helpers)

- [ ] **Step 1: Write the failing integration tests**

Append to `services/turtle_executor_test.go`. First add the synthetic-series helpers (near the other helpers), then the tests:

```go
// synthCloses builds a price series of len(rets)+1 starting at 100 whose
// per-step simple returns equal sign*rets[i]. Using sign=+1 vs sign=-1 on the
// same rets yields two series that are perfectly (anti-)correlated.
func synthCloses(rets []float64, sign float64) []float64 {
	closes := make([]float64, len(rets)+1)
	closes[0] = 100.0
	for i, r := range rets {
		closes[i+1] = closes[i] * (1 + sign*r)
	}
	return closes
}

// varyingReturns returns n deterministic, non-constant daily returns (so the
// resulting close series has non-zero variance and a defined correlation).
func varyingReturns(n int) []float64 {
	out := make([]float64, n)
	for i := range out {
		out[i] = 0.006 + 0.004*math.Sin(float64(i)) // ranges ~[0.002, 0.010]
	}
	return out
}

// corrEntrySignal returns a valid breakout signal (passes evaluateEntry with
// coldStart, anti-cap sizing) carrying the given close series for the
// correlation guard.
func corrEntrySignal(ticker string, closes []float64) *TrendSignal {
	sig := goodEntrySignal(ticker)
	sig.Closes = closes
	return sig
}

func TestRunEntries_SecondSameClusterBreakoutBlockedByClusterCap(t *testing.T) {
	sigs, bars, trader, seg, regime, guard := fullStubs()
	exe, ledger := newTestExecutor(t, sigs, bars, trader, seg, regime, guard)
	// One open rates position (TLT); IEF is also rates → cluster slot taken.
	row := &models.DBTrendLedgerEntry{Ticker: "TLT", Status: "open", Strategy: "trend",
		EntryPrice: 100, Shares: 1, ATRAtEntry: 0.01, EntryDate: at1700(t, "2026-04-10")}
	_ = ledger.Save(row)
	sigs.signals["TLT"] = &TrendSignal{Donchian50Low: 50} // hold, no exit
	bars.bars["TLT"] = &interfaces.Bar{Open: 200}
	universeIneligibleExcept(sigs, bars, "TLT", "IEF")
	sigs.signals["IEF"] = goodEntrySignal("IEF")
	bars.bars["IEF"] = &interfaces.Bar{Open: 99, Close: 100}

	res, err := exe.RunHeartbeat(context.Background(), at1700(t, "2026-05-15"))
	if err != nil {
		t.Fatalf("RunHeartbeat: %v", err)
	}
	for _, o := range trader.placedOrders {
		if o.Side == "buy" && o.Symbol == "IEF" {
			t.Errorf("IEF (rates) must be blocked — rates cluster already holds TLT")
		}
	}
	foundCluster := false
	for _, s := range res.Skips {
		if strings.Contains(s, "IEF") && containsCaseInsensitive(s, "cluster") {
			foundCluster = true
		}
	}
	if !foundCluster {
		t.Errorf("expected an IEF cluster-cap skip, got %v", res.Skips)
	}
}

func TestRunEntries_DifferentClusterBreakoutAllowed(t *testing.T) {
	sigs, bars, trader, seg, regime, guard := fullStubs()
	exe, ledger := newTestExecutor(t, sigs, bars, trader, seg, regime, guard)
	// One open rates position (TLT); GLD is metals → different cluster → allowed.
	row := &models.DBTrendLedgerEntry{Ticker: "TLT", Status: "open", Strategy: "trend",
		EntryPrice: 100, Shares: 1, ATRAtEntry: 0.01, EntryDate: at1700(t, "2026-04-10")}
	_ = ledger.Save(row)
	sigs.signals["TLT"] = &TrendSignal{Donchian50Low: 50}
	bars.bars["TLT"] = &interfaces.Bar{Open: 200}
	universeIneligibleExcept(sigs, bars, "TLT", "GLD")
	sigs.signals["GLD"] = goodEntrySignal("GLD")
	bars.bars["GLD"] = &interfaces.Bar{Open: 99, Close: 100}

	if _, err := exe.RunHeartbeat(context.Background(), at1700(t, "2026-05-15")); err != nil {
		t.Fatalf("RunHeartbeat: %v", err)
	}
	hasGLD := false
	for _, o := range trader.placedOrders {
		if o.Side == "buy" && o.Symbol == "GLD" {
			hasGLD = true
		}
	}
	if !hasGLD {
		t.Errorf("GLD (metals) must be allowed — different cluster from open TLT (rates)")
	}
}

func TestRunEntries_SameBeatSecondSameClusterBlocked(t *testing.T) {
	sigs, bars, trader, seg, regime, guard := fullStubs()
	exe, _ := newTestExecutor(t, sigs, bars, trader, seg, regime, guard)
	// No open positions. TLT and IEF are both rates and both break out this
	// beat. The first by iteration order (TLT) enters; the second (IEF) is
	// blocked by the cluster cap counting the same-beat entry.
	universeIneligibleExcept(sigs, bars, "TLT", "IEF")
	sigs.signals["TLT"] = goodEntrySignal("TLT")
	bars.bars["TLT"] = &interfaces.Bar{Open: 99, Close: 100}
	sigs.signals["IEF"] = goodEntrySignal("IEF")
	bars.bars["IEF"] = &interfaces.Bar{Open: 99, Close: 100}

	if _, err := exe.RunHeartbeat(context.Background(), at1700(t, "2026-05-15")); err != nil {
		t.Fatalf("RunHeartbeat: %v", err)
	}
	var ratesBuys []string
	for _, o := range trader.placedOrders {
		if o.Side == "buy" && (o.Symbol == "TLT" || o.Symbol == "IEF") {
			ratesBuys = append(ratesBuys, o.Symbol)
		}
	}
	if len(ratesBuys) != 1 {
		t.Errorf("exactly one rates entry expected this beat, got %v", ratesBuys)
	}
}

func TestRunEntries_HighlyCorrelatedCrossClusterBreakoutSkipped(t *testing.T) {
	sigs, bars, trader, seg, regime, guard := fullStubs()
	exe, ledger := newTestExecutor(t, sigs, bars, trader, seg, regime, guard)
	rets := varyingReturns(80)
	// Open EEM (intl_equity) with a known return series; DBC (commodity) is a
	// DIFFERENT cluster (cluster cap won't fire) but perfectly +correlated.
	row := &models.DBTrendLedgerEntry{Ticker: "EEM", Status: "open", Strategy: "trend",
		EntryPrice: 100, Shares: 1, ATRAtEntry: 0.01, EntryDate: at1700(t, "2026-04-10")}
	_ = ledger.Save(row)
	eemSig := &TrendSignal{Donchian50Low: 50, Closes: synthCloses(rets, +1)} // hold, no exit
	sigs.signals["EEM"] = eemSig
	bars.bars["EEM"] = &interfaces.Bar{Open: 200}
	universeIneligibleExcept(sigs, bars, "EEM", "DBC")
	sigs.signals["DBC"] = corrEntrySignal("DBC", synthCloses(rets, +1)) // identical returns → ρ=+1
	bars.bars["DBC"] = &interfaces.Bar{Open: 99, Close: 100}

	res, err := exe.RunHeartbeat(context.Background(), at1700(t, "2026-05-15"))
	if err != nil {
		t.Fatalf("RunHeartbeat: %v", err)
	}
	for _, o := range trader.placedOrders {
		if o.Side == "buy" && o.Symbol == "DBC" {
			t.Errorf("DBC must be blocked by the correlation guard (ρ=+1 vs open EEM)")
		}
	}
	foundCorr := false
	for _, s := range res.Skips {
		if strings.Contains(s, "DBC") && containsCaseInsensitive(s, "correlation") {
			foundCorr = true
		}
	}
	if !foundCorr {
		t.Errorf("expected a DBC correlation-guard skip, got %v", res.Skips)
	}
}

func TestRunEntries_AntiCorrelatedBreakoutAllowed(t *testing.T) {
	sigs, bars, trader, seg, regime, guard := fullStubs()
	exe, ledger := newTestExecutor(t, sigs, bars, trader, seg, regime, guard)
	rets := varyingReturns(80)
	// Open EEM with a return series; UUP (fx) is anti-correlated → allowed.
	row := &models.DBTrendLedgerEntry{Ticker: "EEM", Status: "open", Strategy: "trend",
		EntryPrice: 100, Shares: 1, ATRAtEntry: 0.01, EntryDate: at1700(t, "2026-04-10")}
	_ = ledger.Save(row)
	sigs.signals["EEM"] = &TrendSignal{Donchian50Low: 50, Closes: synthCloses(rets, +1)}
	bars.bars["EEM"] = &interfaces.Bar{Open: 200}
	universeIneligibleExcept(sigs, bars, "EEM", "UUP")
	sigs.signals["UUP"] = corrEntrySignal("UUP", synthCloses(rets, -1)) // negated returns → ρ=-1
	bars.bars["UUP"] = &interfaces.Bar{Open: 99, Close: 100}

	if _, err := exe.RunHeartbeat(context.Background(), at1700(t, "2026-05-15")); err != nil {
		t.Fatalf("RunHeartbeat: %v", err)
	}
	hasUUP := false
	for _, o := range trader.placedOrders {
		if o.Side == "buy" && o.Symbol == "UUP" {
			hasUUP = true
		}
	}
	if !hasUUP {
		t.Errorf("UUP must be allowed — anti-correlated (ρ=-1) with open EEM is diversifying")
	}
}

func TestRunEntries_InsufficientCorrelationHistoryAllowsEntry(t *testing.T) {
	sigs, bars, trader, seg, regime, guard := fullStubs()
	exe, ledger := newTestExecutor(t, sigs, bars, trader, seg, regime, guard)
	// Open EEM whose Closes series is too short to assess (< window+1). The
	// candidate DBC has a full series, but with no assessable open pair the
	// guard cannot block → DBC enters (cluster + agg-risk still bound it).
	row := &models.DBTrendLedgerEntry{Ticker: "EEM", Status: "open", Strategy: "trend",
		EntryPrice: 100, Shares: 1, ATRAtEntry: 0.01, EntryDate: at1700(t, "2026-04-10")}
	_ = ledger.Save(row)
	sigs.signals["EEM"] = &TrendSignal{Donchian50Low: 50, Closes: []float64{100, 101, 102}}
	bars.bars["EEM"] = &interfaces.Bar{Open: 200}
	universeIneligibleExcept(sigs, bars, "EEM", "DBC")
	sigs.signals["DBC"] = corrEntrySignal("DBC", synthCloses(varyingReturns(80), +1))
	bars.bars["DBC"] = &interfaces.Bar{Open: 99, Close: 100}

	if _, err := exe.RunHeartbeat(context.Background(), at1700(t, "2026-05-15")); err != nil {
		t.Fatalf("RunHeartbeat: %v", err)
	}
	hasDBC := false
	for _, o := range trader.placedOrders {
		if o.Side == "buy" && o.Symbol == "DBC" {
			hasDBC = true
		}
	}
	if !hasDBC {
		t.Errorf("DBC must enter — open EEM history too short to assess correlation")
	}
}
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `go test ./services/ -run 'TestRunEntries_SecondSameCluster|TestRunEntries_DifferentCluster|TestRunEntries_SameBeat|TestRunEntries_HighlyCorrelated|TestRunEntries_AntiCorrelated|TestRunEntries_InsufficientCorrelation' -v`
Expected: FAIL — the cluster/correlation gates aren't wired, so `SecondSameCluster`, `SameBeat`, and `HighlyCorrelated` place orders they shouldn't (and the skip-reason assertions fail). `DifferentCluster`, `AntiCorrelated`, and `InsufficientCorrelation` may already pass (no gate to block them) — that's fine; they lock in the allowed paths.

- [ ] **Step 3: Add the diversification constants**

In `services/turtle_executor.go`, add to the const block (alongside `turtlePositionCap`):

```go
	turtleMaxPositionsPerCluster = 1    // one position per driver cluster
	turtleCorrThreshold          = 0.70 // block entries with positive ρ above this vs any open position
	turtleCorrWindow             = 60   // trailing trading-day return window for the correlation guard
```

- [ ] **Step 4: Add `openPositionReturns`**

In `services/turtle_executor.go`, add this method (place it just above `runEntries`):

```go
// openPositionReturns builds the trailing daily-return series for each
// still-open position (status open or pending_fill) by reusing the trend
// signal feed. Returns are keyed by ticker. Positions whose signal can't be
// fetched, or whose history is too short to produce returns, are omitted — the
// correlation guard treats a missing series as "cannot assess → allow" (the
// cluster cap + aggregate-risk cap still bound the book). This re-reads the
// signal the exit loop already fetched for open rows; at a once-daily cadence
// over a handful of positions the duplicate read is negligible and keeps the
// entry path self-contained (no new data dependency).
func (e *TurtleExecutor) openPositionReturns(ctx context.Context, openRows []*models.DBTrendLedgerEntry) map[string][]float64 {
	out := map[string][]float64{}
	for _, row := range openRows {
		if row.Status != "open" && row.Status != "pending_fill" {
			continue
		}
		if _, done := out[row.Ticker]; done {
			continue
		}
		sig, err := e.signals.GetSignal(ctx, row.Ticker)
		if err != nil {
			e.logger.WithFields(logrus.Fields{"ticker": row.Ticker, "stage": "corr_open_signal"}).WithError(err).Debug("turtle corr: open-position signal unavailable — pair not assessed")
			continue
		}
		rets := dailyReturns(sig.Closes)
		if len(rets) == 0 {
			continue
		}
		out[row.Ticker] = rets
	}
	return out
}
```

- [ ] **Step 5: Wire both gates into `runEntries`**

In `services/turtle_executor.go`, at the **top** of `runEntries` (right after `coldStart := ...`), seed the working state:

```go
	entriesPlaced := 0
	coldStart := session == nil || !session.ColdStartCompleted

	// workingOpen tracks positions for the cluster cap and grows as entries are
	// placed this beat, so two same-cluster breakouts can't both enter.
	workingOpen := make([]*models.DBTrendLedgerEntry, len(openRows))
	copy(workingOpen, openRows)
	// openReturns feeds the correlation guard; same-beat entries are added as
	// they're placed so a later candidate is checked against earlier ones.
	openReturns := e.openPositionReturns(ctx, openRows)
```

Then insert the two gates **after** the aggregate-risk check and **before** the `guard.CheckBuy` block. The existing aggregate-risk block ends with:

```go
		if wouldExceedAggregateRiskCap(openRows, sig.ATR20, proposedShares, acct.PortfolioValue) {
			res.Skips = append(res.Skips, fmt.Sprintf("%s: aggregate risk cap would exceed %.1f%%", ticker, turtleAggRiskCapPct*100))
			continue
		}
```

Immediately after it, add:

```go
		// Diversification gate 1 — static cluster cap (cheap, deterministic).
		if clusterSlotTaken(workingOpen, inst.Cluster, turtleMaxPositionsPerCluster) {
			res.Skips = append(res.Skips, fmt.Sprintf("%s: cluster cap (%s, max %d)", ticker, inst.Cluster, turtleMaxPositionsPerCluster))
			continue
		}
		// Diversification gate 2 — dynamic positive-correlation guard.
		candReturns := dailyReturns(sig.Closes)
		if tooCorrelated(candReturns, openReturns, turtleCorrThreshold, turtleCorrWindow) {
			res.Skips = append(res.Skips, fmt.Sprintf("%s: correlation guard (positive rho > %.2f vs an open position)", ticker, turtleCorrThreshold))
			continue
		}
```

Finally, after a successful entry is saved, register it in the working state. The existing success tail is:

```go
		entriesPlaced++
		res.Entries = append(res.Entries, ticker)
```

Change it to:

```go
		entriesPlaced++
		res.Entries = append(res.Entries, ticker)
		// Count this entry toward the cluster cap and correlation guard for any
		// later same-beat candidate.
		workingOpen = append(workingOpen, entry)
		openReturns[ticker] = candReturns
```

- [ ] **Step 6: Run the new tests to verify they pass**

Run: `go test ./services/ -run 'TestRunEntries_SecondSameCluster|TestRunEntries_DifferentCluster|TestRunEntries_SameBeat|TestRunEntries_HighlyCorrelated|TestRunEntries_AntiCorrelated|TestRunEntries_InsufficientCorrelation' -v`
Expected: PASS (6 tests).

- [ ] **Step 7: Run the full services suite to confirm no regressions**

Run: `go test ./services/ -count=1`
Expected: PASS. The pre-existing entry tests are unaffected: single-candidate tests have no same-cluster open and `nil` `Closes` (correlation un-assessable → allowed); the aggregate-risk test's candidate (EEM) is gated by agg-risk before the new gates run.

- [ ] **Step 8: Commit**

```bash
git add services/turtle_executor.go services/turtle_executor_test.go
git commit -m "feat(turtle-v2): cluster cap + positive-correlation guard wired into entry loop"
```

---

## Task 7: Whole-tree verification + rules-doc update

**Files:**
- Modify: `TRADING_RULES_TREND.md`

- [ ] **Step 1: Update the Universe section of the rules doc**

Read `TRADING_RULES_TREND.md`. Replace the `## Universe` section (the current lines 60-77, from `## Universe` through the HARVEST overlap note) with:

```markdown
## Universe

Fifteen ETFs across six macro-driver clusters — liquid, unleveraged, non-inverse only:

| Cluster | Tickers | Driver |
|---|---|---|
| Rates | TLT, IEF, TIP | Treasury duration (long + mid curve) + inflation-linked real rates |
| Metals | GLD, SLV | Precious metals |
| Energy | USO, UNG | Oil, natural gas |
| Commodity | DBC, DBA, DBB | Broad commodity, agriculture, base metals |
| FX | UUP, FXE, FXY | US dollar, euro, yen (yen = risk-off ballast) |
| Intl equity | EEM, EFA | EM + developed-ex-US (the only equity-beta cluster) |

No other instruments. No leveraged or inverse ETFs (decay destroys trend systems). If any tool returns data on other tickers, ignore it. The single source of truth is `models.TrendUniverse` (Go); this table mirrors it.

**Diversification (two layers).** The basket was deliberately broadened from one ticker per bucket to several genuinely different drivers, so two caps keep the system from quietly concentrating into co-moving breakouts:

1. **Cluster cap (static, always on):** at most **one open position per cluster**. The strongest-trending ETF wins its cluster's slot; the intl-equity cluster is therefore held to ≤1 (the tightest), capping equity beta.
2. **Correlation guard (dynamic):** before an entry, compute the 60-trading-day daily-return correlation between the candidate and each open position; **skip the entry if positive ρ > 0.70 with any open position**. Negative correlation is diversifying and is allowed. This catches cross-cluster co-trending the static cap misses (e.g. EEM + DBC in a commodity-driven EM rally).

A basket member with insufficient Alpaca history is dropped for that beat with a logged skip (never fails the run).

**Note on overlap with HARVEST:** HARVEST sells iron condors on GLD and TLT (short vol, range-bound thesis). Turtle may go directionally long these same underlyings. This is allowed — the strategies have different return drivers. Combined notional exposure is bounded by the segment caps in each strategy's rules.
```

- [ ] **Step 2: Fix the position-count cap rationale**

In `TRADING_RULES_TREND.md`, find the line (was ~253):

```
- Six-ticker universe; cap of 5 leaves headroom and prevents the segment from being fully concentrated even when every asset is trending
```

Replace it with:

```
- Position-count cap of 6 (= the cluster count) is a backstop; the one-per-cluster caps and the 2.5% aggregate-risk cap are the binding constraints on concurrency
```

- [ ] **Step 3: Fix the enumerated entry-loop ticker list**

In `TRADING_RULES_TREND.md`, find the heartbeat-behavior line (was ~359):

```
For each ticker in [TLT, GLD, USO, DBC, UUP, EEM]:
```

Replace it with:

```
For each ticker in the basket (the 15 ETFs of `models.TrendUniverse`, across the 6 driver clusters):
```

(Leave the cross-asset section ~397-411 as-is — UUP/IEF/HYG macro proxies are still valid and unchanged.)

- [ ] **Step 4: Whole-tree build, vet, and test**

Run: `go build ./... && go vet ./... && go test ./... -count=1`
Expected: PASS across all packages.

- [ ] **Step 5: Final duplication guard**

Confirm no second hard-coded basket slice survives anywhere in Go source:

Run: `grep -rn '"TLT"' --include=*.go . | grep -v _test.go | grep -v models/trend_universe.go`
Expected: no matches (the only non-test Go definition of the basket lives in `models/trend_universe.go`).

- [ ] **Step 6: Commit**

```bash
git add TRADING_RULES_TREND.md
git commit -m "docs(turtle-v2): rules doc reflects 15-ETF basket + cluster/correlation caps"
```

---

## Self-review (completed during planning)

**Spec coverage** (against `2026-05-31-turtle-v2-broaden-basket-design.md`):
- §3 broadened 15-ETF / 6-cluster basket → Task 1. ✅
- §4 Layer 1 static cluster cap → Task 4 (`clusterSlotTaken`) + Task 6 (wiring). ✅
- §4 Layer 2 dynamic positive-correlation guard, reuse fetched bars → Task 3 (`Closes`) + Task 4 (`tooCorrelated`/`pearsonR`) + Task 6 (`openPositionReturns` + wiring). ✅
- §5 keep all mechanics unchanged → only the universe, count cap, and skip-reason change; Donchian/ATR/stop/agg-risk/cold-start/vol-floor/regime untouched. ✅
- §6 centralize universe + delete services copy + `ClusterOf` + two pure gates after existing gates + count cap ≥ 6 → Tasks 1, 2, 5, 6. ✅
- §7 pinned params (max 1 / 0.70 / 60) → Task 6 constants. ✅
- §9 every test listed (ClusterOf, clusterSlotTaken, pearsonR, tooCorrelated, entry-loop integration ordering, de-dup) → Tasks 1, 4, 6, 7. ✅
- §3 build-time liquidity/history drop → Task 5 clean-skip (see decision D-A5). ✅ (volume-liquidity explicitly out of scope)

**Placeholder scan:** no TBD/TODO/"handle edge cases"/"similar to Task N"; every code step shows complete code. ✅

**Type consistency:** `TrendInstrument{Ticker,Cluster}`, `models.TrendUniverse`, `models.ClusterOf`, `models.TrendUniverseTickers`, `models.InTrendUniverse`, `TrendSignal.Closes`, `dailyReturns`, `pearsonR`, `trailing`, `clusterSlotTaken(open, candidateCluster, max)`, `tooCorrelated(candidateReturns, openReturnsByTicker, threshold, window)`, `openPositionReturns(ctx, openRows)`, constants `turtleMaxPositionsPerCluster`/`turtleCorrThreshold`/`turtleCorrWindow`, `turtlePositionCap=6` — names/signatures consistent across all tasks. ✅
```
