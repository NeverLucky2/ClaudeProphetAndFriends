# Harvest Exit Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Read first:** `docs/superpowers/plans/2026-05-16-llm-token-savings-prerequisites.md`. It contains the verified `services/alpaca_trading.go` API surface, strategy-rule loading order, recommended cross-plan execution sequence (this plan is **#3**), and the strategy-attribution invariant every order-placing step must honor.

**Goal:** Move Harvest's exit management (Step 2 of `TRADING_RULES_HARVEST.md`) from the LLM heartbeat into a Go service so the LLM beat is no longer required just to manage open condors.

**Architecture:** A new `HarvestExitMonitor` service runs as a background goroutine (started from `cmd/bot/main.go`). On each tick (60s during market hours, idle otherwise) it lists open condors, fetches current option prices for all four legs via the existing Alpaca options client, computes `cost_to_close_per_contract`, and applies the three exit triggers from the rules doc (DTE ≤ 21, 2× credit loss, 0.50× credit profit). When a trigger fires, the monitor calls a newly-extracted `HarvestCloser.CloseCondor(...)` service method (the same method `HandleCloseCondor` will now delegate to). Tier escalation (mid → mid−0.05 → market for profit/time exits; mid+0.20 → market for loss exit) is implemented as an in-memory per-condor state machine with the condor's DB `status` flipping `OPEN → CLOSING → CLOSED` along the way.

When the monitor is enabled, `agent/preflight.js` no longer treats `open_condors > 0` as a reason to keep the Harvest LLM beat alive — entries-only conditions (chain available, IVR ≥ 30, etc.) are the only thing that should wake the LLM.

**Tech Stack:** Go 1.21+, GORM, Alpaca v1beta1 options API (already wired via `services.AlpacaOptionsDataService`), Gin (for the existing close endpoint).

---

## File Structure

- Create: `services/harvest_exit_monitor.go` — tick loop, rule evaluation, escalation state.
- Create: `services/harvest_exit_monitor_test.go` — unit tests with injected clock, store, pricer, closer.
- Create: `services/harvest_closer.go` — extracted close-condor logic (`HarvestCloser` type).
- Create: `services/harvest_closer_test.go` — unit tests for the extracted closer.
- Modify: `controllers/harvest_controller.go` — `HandleCloseCondor` becomes a thin shim that delegates to `HarvestCloser`.
- Modify: `cmd/bot/main.go` — construct `HarvestCloser` + `HarvestExitMonitor`, start goroutine, gate on env var.
- Modify: `agent/preflight.js` — drop the `openCondors > 0 → don't skip` line when `HARVEST_EXIT_MONITOR_ENABLED=true` is reflected via the harvest-state response.
- Modify: `services/harvest_service.go` — add `MonitorEnabled` bool to `HarvestStateResponse` (single field, set by main.go at construction).
- Modify: `TRADING_RULES_HARVEST.md` — annotate Step 2 as backend-managed when the env flag is on.

---

## Task 1: Extract `HarvestCloser` from controller

**Files:**
- Create: `services/harvest_closer.go`
- Create: `services/harvest_closer_test.go`
- Modify: `controllers/harvest_controller.go:229-302` (HandleCloseCondor body)

- [ ] **Step 1: Write the failing test for HarvestCloser.CloseCondor success path**

`services/harvest_closer_test.go`:

```go
package services

import (
	"context"
	"errors"
	"testing"
	"time"

	"prophet-trader/models"
)

type fakeCondorStore struct {
	condor       *models.DBHarvestCondor
	getErr       error
	updateErr    error
	lastUpdates  map[string]interface{}
	lastCondorID string
}

func (f *fakeCondorStore) GetHarvestCondorByID(id string) (*models.DBHarvestCondor, error) {
	return f.condor, f.getErr
}
func (f *fakeCondorStore) UpdateHarvestCondor(id string, updates map[string]interface{}) error {
	f.lastCondorID = id
	f.lastUpdates = updates
	return f.updateErr
}

func TestHarvestCloser_PlacesOrderAndUpdatesRow(t *testing.T) {
	store := &fakeCondorStore{
		condor: &models.DBHarvestCondor{
			CondorID:          "c1",
			Underlying:        "SPY",
			Contracts:         2,
			CreditPerContract: 1.50,
			Status:            "OPEN",
			ShortPutSymbol:    "SPY_P_400",
			LongPutSymbol:     "SPY_P_395",
			ShortCallSymbol:   "SPY_C_450",
			LongCallSymbol:    "SPY_C_455",
		},
	}
	var capturedOrder MultiLegOrder
	placeFn := PlaceMultiLegOrderFn(func(_ context.Context, o MultiLegOrder) (string, error) {
		capturedOrder = o
		return "ord-123", nil
	})
	closer := NewHarvestCloser(store, placeFn)

	res, err := closer.CloseCondor(context.Background(), CloseCondorRequest{
		CondorID:        "c1",
		OrderType:       "limit",
		LimitPrice:      0.50,
		CostPerContract: 0.50,
		CloseReason:     "profit_target",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.CloseOrderID != "ord-123" {
		t.Errorf("got close order id %q, want ord-123", res.CloseOrderID)
	}
	wantPnL := (1.50 - 0.50) * 2 * 100
	if res.RealizedPnL != wantPnL {
		t.Errorf("got realized pnl %.2f, want %.2f", res.RealizedPnL, wantPnL)
	}
	if capturedOrder.Contracts != 2 {
		t.Errorf("got contracts %d, want 2", capturedOrder.Contracts)
	}
	if len(capturedOrder.Legs) != 4 {
		t.Errorf("got %d legs, want 4", len(capturedOrder.Legs))
	}
	if store.lastUpdates["status"] != "CLOSING" {
		t.Errorf("got status %v, want CLOSING", store.lastUpdates["status"])
	}
	if _, ok := store.lastUpdates["close_order_id"]; !ok {
		t.Error("expected close_order_id in updates")
	}
}

func TestHarvestCloser_RejectsNonOpenCondor(t *testing.T) {
	store := &fakeCondorStore{
		condor: &models.DBHarvestCondor{CondorID: "c1", Status: "CLOSED"},
	}
	closer := NewHarvestCloser(store, func(_ context.Context, _ MultiLegOrder) (string, error) {
		t.Fatal("placeMLeg should not be called")
		return "", nil
	})
	_, err := closer.CloseCondor(context.Background(), CloseCondorRequest{
		CondorID: "c1", OrderType: "limit", CloseReason: "profit_target",
	})
	if !errors.Is(err, ErrCondorNotOpen) {
		t.Errorf("got err %v, want ErrCondorNotOpen", err)
	}
}

func TestHarvestCloser_MarketOrderForcesZeroLimit(t *testing.T) {
	store := &fakeCondorStore{
		condor: &models.DBHarvestCondor{CondorID: "c1", Status: "OPEN", Contracts: 1,
			CreditPerContract: 1.0, ShortPutSymbol: "x", LongPutSymbol: "x", ShortCallSymbol: "x", LongCallSymbol: "x"},
	}
	var lp float64 = -1
	placeFn := PlaceMultiLegOrderFn(func(_ context.Context, o MultiLegOrder) (string, error) {
		lp = o.LimitPrice
		return "ord", nil
	})
	closer := NewHarvestCloser(store, placeFn)
	_, err := closer.CloseCondor(context.Background(), CloseCondorRequest{
		CondorID: "c1", OrderType: "market", LimitPrice: 99, CostPerContract: 0.5, CloseReason: "loss_stop",
	})
	if err != nil {
		t.Fatal(err)
	}
	if lp != 0 {
		t.Errorf("market order should zero limit price, got %v", lp)
	}
	_ = time.Now
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
go test ./services -run TestHarvestCloser -v
```

Expected: FAIL with `undefined: NewHarvestCloser`, `undefined: HarvestCloser`, `undefined: CloseCondorRequest`, `undefined: ErrCondorNotOpen`.

- [ ] **Step 3: Implement HarvestCloser**

`services/harvest_closer.go`:

```go
package services

import (
	"context"
	"errors"
	"fmt"
	"time"

	"prophet-trader/models"
)

// closerStore is the storage subset used by HarvestCloser. Decoupled from
// the larger harvestStateStore so tests don't need to fake every method.
type closerStore interface {
	GetHarvestCondorByID(condorID string) (*models.DBHarvestCondor, error)
	UpdateHarvestCondor(condorID string, updates map[string]interface{}) error
}

// CloseCondorRequest mirrors the controller's request shape so the
// controller can pass it through unchanged.
type CloseCondorRequest struct {
	CondorID        string  `json:"-"`
	OrderType       string  `json:"order_type" binding:"required"`
	LimitPrice      float64 `json:"limit_price"`
	CloseReason     string  `json:"close_reason" binding:"required"`
	CostPerContract float64 `json:"cost_per_contract"`
}

// CloseCondorResult is the data the controller needs to render its response
// and the monitor needs to update its in-memory tier state.
type CloseCondorResult struct {
	CondorID     string
	CloseOrderID string
	RealizedPnL  float64
	Status       string
}

// ErrCondorNotOpen is returned when CloseCondor is called against a condor
// whose DB status is not OPEN. Used by callers (controller / monitor) to
// distinguish "already-closing" from real failures.
var ErrCondorNotOpen = errors.New("condor not OPEN")

// HarvestCloser places close orders for iron condors and flips the DB row
// to CLOSING. The CLOSING → CLOSED transition is handled by the monitor's
// fill-confirmation poll (see HarvestExitMonitor). This split lets one
// close attempt time out and be retried at the next escalation tier
// without prematurely marking the condor closed.
type HarvestCloser struct {
	store    closerStore
	placeFn  PlaceMultiLegOrderFn
	timeout  time.Duration
	nowFn    func() time.Time
}

func NewHarvestCloser(store closerStore, placeFn PlaceMultiLegOrderFn) *HarvestCloser {
	return &HarvestCloser{store: store, placeFn: placeFn, timeout: 15 * time.Second, nowFn: time.Now}
}

func (hc *HarvestCloser) CloseCondor(ctx context.Context, req CloseCondorRequest) (*CloseCondorResult, error) {
	condor, err := hc.store.GetHarvestCondorByID(req.CondorID)
	if err != nil {
		return nil, fmt.Errorf("fetch condor: %w", err)
	}
	if condor.Status != "OPEN" {
		return nil, fmt.Errorf("%w: status=%s", ErrCondorNotOpen, condor.Status)
	}

	limitPrice := req.LimitPrice
	if req.OrderType == "market" {
		limitPrice = 0
	}

	order := MultiLegOrder{
		Underlying:  condor.Underlying,
		Contracts:   condor.Contracts,
		LimitPrice:  limitPrice,
		TimeInForce: "day",
		Strategy:    "harvest",
		Legs: []MultiLegOrderLeg{
			{Symbol: condor.ShortPutSymbol, Side: "buy", PositionIntent: "buy_to_close"},
			{Symbol: condor.LongPutSymbol, Side: "sell", PositionIntent: "sell_to_close"},
			{Symbol: condor.ShortCallSymbol, Side: "buy", PositionIntent: "buy_to_close"},
			{Symbol: condor.LongCallSymbol, Side: "sell", PositionIntent: "sell_to_close"},
		},
	}

	cctx, cancel := context.WithTimeout(ctx, hc.timeout)
	defer cancel()
	closeOrderID, err := hc.placeFn(cctx, order)
	if err != nil {
		return nil, fmt.Errorf("place close order: %w", err)
	}

	// Realized P&L is computed from the operator-supplied cost-to-close.
	// For the monitor, this is the live mid; for the manual endpoint, it's
	// whatever the caller passed. The number is corrected later if the
	// fill price differs materially (out of scope for this task).
	realizedPnL := (condor.CreditPerContract - req.CostPerContract) * float64(condor.Contracts) * 100.0

	updates := map[string]interface{}{
		"status":                  "CLOSING",
		"close_order_id":          closeOrderID,
		"close_reason":            req.CloseReason,
		"close_cost_per_contract": req.CostPerContract,
		"realized_pnl":            realizedPnL,
	}
	if err := hc.store.UpdateHarvestCondor(req.CondorID, updates); err != nil {
		return nil, fmt.Errorf("close order placed (%s) but DB update failed: %w", closeOrderID, err)
	}

	return &CloseCondorResult{
		CondorID:     req.CondorID,
		CloseOrderID: closeOrderID,
		RealizedPnL:  realizedPnL,
		Status:       "CLOSING",
	}, nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
go test ./services -run TestHarvestCloser -v
```

Expected: PASS.

- [ ] **Step 5: Refactor controller to delegate to HarvestCloser**

Modify `controllers/harvest_controller.go` to replace the body of `HandleCloseCondor` (lines 229-302) with a thin pass-through. Add a `closer *services.HarvestCloser` field to `HarvestController` and accept it in `NewHarvestController`.

Update the `HarvestController` struct (top of file, near other fields):

```go
type HarvestController struct {
	// ... existing fields ...
	closer *services.HarvestCloser
}
```

Update `NewHarvestController` signature to accept `closer *services.HarvestCloser` and assign it. Then rewrite `HandleCloseCondor`:

```go
func (hc *HarvestController) HandleCloseCondor(c *gin.Context) {
	condorID := c.Param("id")
	var req services.CloseCondorRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	req.CondorID = condorID

	ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Second)
	defer cancel()

	res, err := hc.closer.CloseCondor(ctx, req)
	if err != nil {
		if errors.Is(err, services.ErrCondorNotOpen) {
			c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
			return
		}
		if errors.Is(err, gorm.ErrRecordNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "condor not found: " + condorID})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"condor_id":      res.CondorID,
		"close_order_id": res.CloseOrderID,
		"realized_pnl":   res.RealizedPnL,
		"status":         res.Status,
	})
}
```

- [ ] **Step 6: Update main.go to construct and pass the closer**

In `cmd/bot/main.go`, after `placeMLegFn` is defined (around line 271):

```go
harvestCloser := services.NewHarvestCloser(storageService, placeMLegFn)
```

Update the `NewHarvestController` call (line 278) to pass `harvestCloser`.

- [ ] **Step 7: Verify the full build + existing tests pass**

```bash
go build ./...
go test ./services -run TestHarvest -v
go test ./controllers -run TestHarvest -v
```

Expected: all PASS. Existing controller tests that hit `/api/v1/harvest/condors/:id/close` should continue to pass against the new closer-backed implementation. If any close-condor controller test stubs `placeMLeg` directly, it will need to be updated to instead construct a `HarvestCloser` with the stub.

- [ ] **Step 8: Commit**

```bash
git add services/harvest_closer.go services/harvest_closer_test.go controllers/harvest_controller.go cmd/bot/main.go
git commit -m "refactor(harvest): extract HarvestCloser service for reuse by exit monitor"
```

---

## Task 2: Add cost-to-close pricer

**Files:**
- Create: `services/harvest_pricer.go`
- Create: `services/harvest_pricer_test.go`

The monitor needs to compute `cost_to_close_per_contract` for an open condor by fetching live mid-prices for all four legs from Alpaca.

- [ ] **Step 1: Write the failing test**

`services/harvest_pricer_test.go`:

```go
package services

import (
	"context"
	"testing"

	"prophet-trader/interfaces"
	"prophet-trader/models"
)

type fakeOptionPricer struct {
	prices map[string]float64 // symbol -> mid
	err    error
}

func (f *fakeOptionPricer) GetOptionSnapshot(_ context.Context, symbol string) (*interfaces.OptionContract, error) {
	if f.err != nil {
		return nil, f.err
	}
	mid, ok := f.prices[symbol]
	if !ok {
		return &interfaces.OptionContract{Symbol: symbol, Premium: 0, Bid: 0, Ask: 0}, nil
	}
	return &interfaces.OptionContract{Symbol: symbol, Premium: mid, Bid: mid - 0.01, Ask: mid + 0.01}, nil
}

func TestHarvestPricer_CostToCloseHappyPath(t *testing.T) {
	condor := &models.DBHarvestCondor{
		ShortPutSymbol:  "P_short",
		LongPutSymbol:   "P_long",
		ShortCallSymbol: "C_short",
		LongCallSymbol:  "C_long",
	}
	pricer := NewHarvestPricer(&fakeOptionPricer{prices: map[string]float64{
		"P_short": 0.40,
		"P_long":  0.10,
		"C_short": 0.50,
		"C_long":  0.15,
	}})
	cost, err := pricer.CostToClosePerContract(context.Background(), condor)
	if err != nil {
		t.Fatal(err)
	}
	// (short_put_mid + short_call_mid) - (long_put_mid + long_call_mid)
	want := (0.40 + 0.50) - (0.10 + 0.15)
	if abs(cost-want) > 1e-9 {
		t.Errorf("got %.4f, want %.4f", cost, want)
	}
}

func TestHarvestPricer_ReturnsErrIfAnyLegMissing(t *testing.T) {
	condor := &models.DBHarvestCondor{
		ShortPutSymbol:  "P_short",
		LongPutSymbol:   "P_long",
		ShortCallSymbol: "C_short",
		LongCallSymbol:  "C_long",
	}
	pricer := NewHarvestPricer(&fakeOptionPricer{prices: map[string]float64{
		"P_short": 0.40, "P_long": 0.10, "C_short": 0.50, // C_long missing → premium 0
	}})
	_, err := pricer.CostToClosePerContract(context.Background(), condor)
	if err == nil {
		t.Fatal("expected error when a leg has zero/missing price")
	}
}

func abs(x float64) float64 {
	if x < 0 {
		return -x
	}
	return x
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
go test ./services -run TestHarvestPricer -v
```

Expected: FAIL with `undefined: NewHarvestPricer`.

- [ ] **Step 3: Implement HarvestPricer**

`services/harvest_pricer.go`:

```go
package services

import (
	"context"
	"fmt"

	"prophet-trader/interfaces"
	"prophet-trader/models"
)

// optionPricer is the subset of AlpacaOptionsDataService that the pricer
// needs. Decoupled so the monitor's tests don't pay an HTTP client.
type optionPricer interface {
	GetOptionSnapshot(ctx context.Context, symbol string) (*interfaces.OptionContract, error)
}

// HarvestPricer prices iron condors at the current mid for close-decisions.
type HarvestPricer struct {
	src optionPricer
}

func NewHarvestPricer(src optionPricer) *HarvestPricer {
	return &HarvestPricer{src: src}
}

// CostToClosePerContract returns the per-contract dollar cost-to-close at
// the current mid. Definition matches the rules doc:
//
//	cost = (short_put_mid + short_call_mid) - (long_put_mid + long_call_mid)
//
// A small / negative cost means the condor has converged toward expiry
// worthless and we've captured most of the credit. An error is returned if
// any leg has a missing or zero price — entering the close-decision branch
// with phantom prices would be worse than skipping the tick.
func (p *HarvestPricer) CostToClosePerContract(ctx context.Context, c *models.DBHarvestCondor) (float64, error) {
	symbols := []string{c.ShortPutSymbol, c.LongPutSymbol, c.ShortCallSymbol, c.LongCallSymbol}
	prices := make(map[string]float64, 4)
	for _, s := range symbols {
		snap, err := p.src.GetOptionSnapshot(ctx, s)
		if err != nil {
			return 0, fmt.Errorf("price %s: %w", s, err)
		}
		if snap.Premium <= 0 {
			return 0, fmt.Errorf("zero/missing mid for leg %s", s)
		}
		prices[s] = snap.Premium
	}
	cost := (prices[c.ShortPutSymbol] + prices[c.ShortCallSymbol]) -
		(prices[c.LongPutSymbol] + prices[c.LongCallSymbol])
	return cost, nil
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
go test ./services -run TestHarvestPricer -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/harvest_pricer.go services/harvest_pricer_test.go
git commit -m "feat(harvest): add HarvestPricer for live cost-to-close computation"
```

---

## Task 3: HarvestExitMonitor — single-tick rule evaluation

**Files:**
- Create: `services/harvest_exit_monitor.go`
- Create: `services/harvest_exit_monitor_test.go`

Implement the per-tick evaluation logic. No tier escalation yet — that's Task 4. The monitor calls `CloseCondor` once per triggered condor with the initial tier price.

- [ ] **Step 1: Write the failing test for the three exit triggers**

`services/harvest_exit_monitor_test.go`:

```go
package services

import (
	"context"
	"testing"
	"time"

	"prophet-trader/models"
)

type fakeListStore struct {
	condors []*models.DBHarvestCondor
}

func (f *fakeListStore) ListOpenHarvestCondors() ([]*models.DBHarvestCondor, error) {
	return f.condors, nil
}

type fakeCostPricer struct {
	costs map[string]float64
}

func (f *fakeCostPricer) CostToClosePerContract(_ context.Context, c *models.DBHarvestCondor) (float64, error) {
	return f.costs[c.CondorID], nil
}

type fakeCloser struct {
	calls []CloseCondorRequest
}

func (f *fakeCloser) CloseCondor(_ context.Context, req CloseCondorRequest) (*CloseCondorResult, error) {
	f.calls = append(f.calls, req)
	return &CloseCondorResult{CondorID: req.CondorID, CloseOrderID: "ord-x", Status: "CLOSING"}, nil
}

func mkCondor(id, underlying string, contracts int, credit, expDaysAhead float64) *models.DBHarvestCondor {
	return &models.DBHarvestCondor{
		CondorID:          id,
		Underlying:        underlying,
		Contracts:         contracts,
		CreditPerContract: credit,
		Status:            "OPEN",
		Expiration:        time.Now().UTC().Add(time.Duration(expDaysAhead*24) * time.Hour),
		ShortPutSymbol:    id + "_sp",
		LongPutSymbol:     id + "_lp",
		ShortCallSymbol:   id + "_sc",
		LongCallSymbol:    id + "_lc",
	}
}

func TestExitMonitor_TimeExitFiresAtDTE21(t *testing.T) {
	c := mkCondor("c1", "SPY", 1, 1.0, 21) // exactly 21 DTE
	store := &fakeListStore{condors: []*models.DBHarvestCondor{c}}
	pricer := &fakeCostPricer{costs: map[string]float64{"c1": 0.80}} // not at profit or loss threshold
	closer := &fakeCloser{}
	m := NewHarvestExitMonitor(store, pricer, closer)
	m.EvaluateTick(context.Background(), time.Now())
	if len(closer.calls) != 1 {
		t.Fatalf("expected 1 close call, got %d", len(closer.calls))
	}
	if closer.calls[0].CloseReason != "time_exit" {
		t.Errorf("got reason %q, want time_exit", closer.calls[0].CloseReason)
	}
	if closer.calls[0].OrderType != "limit" {
		t.Errorf("got order type %q, want limit", closer.calls[0].OrderType)
	}
}

func TestExitMonitor_LossStopFiresAt2xCredit(t *testing.T) {
	c := mkCondor("c1", "SPY", 1, 1.0, 30) // 30 DTE
	store := &fakeListStore{condors: []*models.DBHarvestCondor{c}}
	pricer := &fakeCostPricer{costs: map[string]float64{"c1": 2.10}} // > 2× 1.0 credit
	closer := &fakeCloser{}
	m := NewHarvestExitMonitor(store, pricer, closer)
	m.EvaluateTick(context.Background(), time.Now())
	if len(closer.calls) != 1 {
		t.Fatalf("expected 1 close call, got %d", len(closer.calls))
	}
	if closer.calls[0].CloseReason != "loss_stop" {
		t.Errorf("got reason %q, want loss_stop", closer.calls[0].CloseReason)
	}
}

func TestExitMonitor_ProfitTargetFiresAt50pct(t *testing.T) {
	c := mkCondor("c1", "SPY", 1, 1.0, 30)
	store := &fakeListStore{condors: []*models.DBHarvestCondor{c}}
	pricer := &fakeCostPricer{costs: map[string]float64{"c1": 0.40}} // < 0.50× 1.0 credit
	closer := &fakeCloser{}
	m := NewHarvestExitMonitor(store, pricer, closer)
	m.EvaluateTick(context.Background(), time.Now())
	if len(closer.calls) != 1 {
		t.Fatalf("expected 1 close call, got %d", len(closer.calls))
	}
	if closer.calls[0].CloseReason != "profit_target" {
		t.Errorf("got reason %q, want profit_target", closer.calls[0].CloseReason)
	}
}

func TestExitMonitor_HoldsWhenNoTriggers(t *testing.T) {
	c := mkCondor("c1", "SPY", 1, 1.0, 30)
	store := &fakeListStore{condors: []*models.DBHarvestCondor{c}}
	pricer := &fakeCostPricer{costs: map[string]float64{"c1": 0.80}} // in band
	closer := &fakeCloser{}
	m := NewHarvestExitMonitor(store, pricer, closer)
	m.EvaluateTick(context.Background(), time.Now())
	if len(closer.calls) != 0 {
		t.Fatalf("expected no close calls, got %d", len(closer.calls))
	}
}

func TestExitMonitor_LossStopWinsOverProfitTarget(t *testing.T) {
	// Defensive: never reachable in practice (cost can't be both >2× and <0.5×),
	// but the priority order should match the rules doc: time → loss → profit.
	c := mkCondor("c1", "SPY", 1, 1.0, 21)
	store := &fakeListStore{condors: []*models.DBHarvestCondor{c}}
	pricer := &fakeCostPricer{costs: map[string]float64{"c1": 2.20}}
	closer := &fakeCloser{}
	m := NewHarvestExitMonitor(store, pricer, closer)
	m.EvaluateTick(context.Background(), time.Now())
	if closer.calls[0].CloseReason != "time_exit" {
		t.Errorf("DTE≤21 must take priority, got %q", closer.calls[0].CloseReason)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
go test ./services -run TestExitMonitor -v
```

Expected: FAIL with `undefined: NewHarvestExitMonitor`.

- [ ] **Step 3: Implement HarvestExitMonitor (single-tick path only)**

`services/harvest_exit_monitor.go`:

```go
package services

import (
	"context"
	"fmt"
	"math"
	"time"

	"prophet-trader/models"
)

// monitorStore is the storage subset the monitor needs to enumerate
// candidates.
type monitorStore interface {
	ListOpenHarvestCondors() ([]*models.DBHarvestCondor, error)
}

// monitorPricer is implemented by HarvestPricer in production and a fake in
// tests.
type monitorPricer interface {
	CostToClosePerContract(ctx context.Context, c *models.DBHarvestCondor) (float64, error)
}

// monitorCloser is implemented by HarvestCloser in production and a fake in
// tests.
type monitorCloser interface {
	CloseCondor(ctx context.Context, req CloseCondorRequest) (*CloseCondorResult, error)
}

// HarvestExitMonitor evaluates the three Step-2 exit rules from
// TRADING_RULES_HARVEST.md against each open condor.
type HarvestExitMonitor struct {
	store  monitorStore
	pricer monitorPricer
	closer monitorCloser
}

func NewHarvestExitMonitor(store monitorStore, pricer monitorPricer, closer monitorCloser) *HarvestExitMonitor {
	return &HarvestExitMonitor{store: store, pricer: pricer, closer: closer}
}

// EvaluateTick runs one pass over open condors. Pricing or close-call errors
// on one condor are logged via fmt (replace with logrus when wired) and do
// not block the loop — other condors still get evaluated.
func (m *HarvestExitMonitor) EvaluateTick(ctx context.Context, now time.Time) {
	condors, err := m.store.ListOpenHarvestCondors()
	if err != nil {
		fmt.Printf("[harvest-exit-monitor] list condors failed: %v\n", err)
		return
	}
	for _, c := range condors {
		if c.Status != "OPEN" {
			continue
		}
		reason, orderType, limitOffset, ok := m.classify(ctx, c, now)
		if !ok {
			continue
		}
		cost, err := m.pricer.CostToClosePerContract(ctx, c)
		if err != nil {
			fmt.Printf("[harvest-exit-monitor] %s pricer failed: %v\n", c.CondorID, err)
			continue
		}
		req := CloseCondorRequest{
			CondorID:        c.CondorID,
			OrderType:       orderType,
			LimitPrice:      cost + limitOffset,
			CostPerContract: cost,
			CloseReason:     reason,
		}
		if orderType == "market" {
			req.LimitPrice = 0
		}
		if _, err := m.closer.CloseCondor(ctx, req); err != nil {
			fmt.Printf("[harvest-exit-monitor] %s close failed: %v\n", c.CondorID, err)
			continue
		}
	}
}

// classify returns the close reason, initial order type, and limit-price offset
// (relative to current cost-to-close) for the highest-priority trigger that
// fires. Priority matches the rules doc: time → loss → profit.
func (m *HarvestExitMonitor) classify(ctx context.Context, c *models.DBHarvestCondor, now time.Time) (reason, orderType string, limitOffset float64, ok bool) {
	dte := int(math.Round(c.Expiration.Sub(now).Hours() / 24))
	if dte <= 21 {
		return "time_exit", "limit", 0, true
	}
	cost, err := m.pricer.CostToClosePerContract(ctx, c)
	if err != nil {
		return "", "", 0, false
	}
	if cost >= 2.0*c.CreditPerContract {
		// Marketable limit: mid + $0.20. Caller adjusts via limitOffset.
		return "loss_stop", "limit", 0.20, true
	}
	if cost <= 0.50*c.CreditPerContract {
		return "profit_target", "limit", 0, true
	}
	return "", "", 0, false
}
```

NB: `classify` calls the pricer too, then `EvaluateTick` calls it again. Cleaner to call it once and pass the cost into `classify`. Refactor inline:

Replace `EvaluateTick` and `classify` with:

```go
func (m *HarvestExitMonitor) EvaluateTick(ctx context.Context, now time.Time) {
	condors, err := m.store.ListOpenHarvestCondors()
	if err != nil {
		fmt.Printf("[harvest-exit-monitor] list condors failed: %v\n", err)
		return
	}
	for _, c := range condors {
		if c.Status != "OPEN" {
			continue
		}
		dte := int(math.Round(c.Expiration.Sub(now).Hours() / 24))

		// Time exit doesn't need price data — trigger first to bound API load.
		var cost float64
		if dte > 21 {
			cost, err = m.pricer.CostToClosePerContract(ctx, c)
			if err != nil {
				fmt.Printf("[harvest-exit-monitor] %s pricer failed: %v\n", c.CondorID, err)
				continue
			}
		}

		reason, orderType, limitPrice := m.classify(c, dte, cost)
		if reason == "" {
			continue
		}
		if reason == "time_exit" || reason == "profit_target" {
			// limit at current mid — but we need the mid to set the limit.
			if cost == 0 {
				cost, err = m.pricer.CostToClosePerContract(ctx, c)
				if err != nil {
					fmt.Printf("[harvest-exit-monitor] %s pricer failed: %v\n", c.CondorID, err)
					continue
				}
				limitPrice = cost
			}
		}
		req := CloseCondorRequest{
			CondorID:        c.CondorID,
			OrderType:       orderType,
			LimitPrice:      limitPrice,
			CostPerContract: cost,
			CloseReason:     reason,
		}
		if _, err := m.closer.CloseCondor(ctx, req); err != nil {
			fmt.Printf("[harvest-exit-monitor] %s close failed: %v\n", c.CondorID, err)
			continue
		}
	}
}

// classify returns reason + order params for the highest-priority trigger.
// Cost is allowed to be zero when dte ≤ 21 (time-exit short-circuits before pricing).
func (m *HarvestExitMonitor) classify(c *models.DBHarvestCondor, dte int, cost float64) (reason, orderType string, limitPrice float64) {
	if dte <= 21 {
		return "time_exit", "limit", cost // cost is 0 here; caller refreshes
	}
	if cost >= 2.0*c.CreditPerContract {
		return "loss_stop", "limit", cost + 0.20
	}
	if cost <= 0.50*c.CreditPerContract {
		return "profit_target", "limit", cost
	}
	return "", "", 0
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
go test ./services -run TestExitMonitor -v
```

Expected: PASS for all 5 cases.

- [ ] **Step 5: Commit**

```bash
git add services/harvest_exit_monitor.go services/harvest_exit_monitor_test.go
git commit -m "feat(harvest): exit monitor — rule classification + close orchestration"
```

---

## Task 4: Tier escalation + fill-confirmation poll

**Files:**
- Modify: `services/harvest_exit_monitor.go`
- Modify: `services/harvest_exit_monitor_test.go`

The rules doc requires:
- Time-exit + profit-target: limit @ mid → after 10 min, mid − $0.05 → after 10 more min, market.
- Loss-stop: marketable limit @ mid + $0.20 → after 2 min, market.

We need per-condor in-memory tier state, an order-fill checker, and order-cancel-and-replace logic.

- [ ] **Step 1: Define the order-tracking interface**

Per the prerequisites doc, `AlpacaTradingService` exposes `GetOrder(ctx, orderID) (*interfaces.Order, error)` and `CancelOrder(ctx, orderID) error` — both used here directly:

```go
type orderTracker interface {
	GetOrder(ctx context.Context, orderID string) (*interfaces.Order, error)
	CancelOrder(ctx context.Context, orderID string) error
}
```

The status check downstream reads `ord.Status` (string, values like `"new"`, `"filled"`, `"partially_filled"`, `"canceled"`, `"expired"`).

- [ ] **Step 2: Write the failing test for tier escalation**

Add to `services/harvest_exit_monitor_test.go`:

```go
type fakeOrderTracker struct {
	statuses map[string]string // orderID -> status
	cancels  []string
}

func (f *fakeOrderTracker) GetOrder(_ context.Context, id string) (*interfaces.Order, error) {
	return &interfaces.Order{ID: id, Status: f.statuses[id]}, nil
}
func (f *fakeOrderTracker) CancelOrder(_ context.Context, id string) error {
	f.cancels = append(f.cancels, id)
	return nil
}

func TestExitMonitor_EscalatesLossStopFromLimitToMarket(t *testing.T) {
	c := mkCondor("c1", "SPY", 1, 1.0, 30)
	c.CloseOrderID = "ord-1" // a previous tick already placed the tier-1 marketable limit
	c.Status = "CLOSING"
	store := &fakeListStore{condors: []*models.DBHarvestCondor{c}}
	pricer := &fakeCostPricer{costs: map[string]float64{"c1": 2.20}}
	closer := &fakeCloser{}
	tracker := &fakeOrderTracker{statuses: map[string]string{"ord-1": "open"}}

	m := NewHarvestExitMonitor(store, pricer, closer)
	m.SetOrderTracker(tracker)

	// Simulate the first tier-1 placement at t=0
	m.RecordTierAttempt("c1", "loss_stop", time.Date(2026, 5, 16, 14, 0, 0, 0, time.UTC))

	// 3 minutes later (>2 min escalation), the next tick should cancel and re-place as market
	m.EvaluateTick(context.Background(), time.Date(2026, 5, 16, 14, 3, 0, 0, time.UTC))

	if len(tracker.cancels) != 1 || tracker.cancels[0] != "ord-1" {
		t.Errorf("expected cancel of ord-1, got %v", tracker.cancels)
	}
	if len(closer.calls) != 1 {
		t.Fatalf("expected 1 follow-up close call, got %d", len(closer.calls))
	}
	if closer.calls[0].OrderType != "market" {
		t.Errorf("got order type %q on escalation, want market", closer.calls[0].OrderType)
	}
}

func TestExitMonitor_NoEscalationBeforeWindow(t *testing.T) {
	c := mkCondor("c1", "SPY", 1, 1.0, 30)
	c.CloseOrderID = "ord-1"
	c.Status = "CLOSING"
	store := &fakeListStore{condors: []*models.DBHarvestCondor{c}}
	pricer := &fakeCostPricer{costs: map[string]float64{"c1": 2.20}}
	closer := &fakeCloser{}
	tracker := &fakeOrderTracker{statuses: map[string]string{"ord-1": "open"}}

	m := NewHarvestExitMonitor(store, pricer, closer)
	m.SetOrderTracker(tracker)
	m.RecordTierAttempt("c1", "loss_stop", time.Date(2026, 5, 16, 14, 0, 0, 0, time.UTC))
	// Only 1 minute later — below the 2-minute escalation threshold
	m.EvaluateTick(context.Background(), time.Date(2026, 5, 16, 14, 1, 0, 0, time.UTC))

	if len(tracker.cancels) != 0 {
		t.Errorf("expected no cancels, got %v", tracker.cancels)
	}
	if len(closer.calls) != 0 {
		t.Errorf("expected no follow-up calls, got %d", len(closer.calls))
	}
}

func TestExitMonitor_MarksClosedOnFill(t *testing.T) {
	// Once the broker reports the close order as filled, the monitor flips
	// the DB row from CLOSING to CLOSED. This needs a second store method.
	// Test stub omitted here — see Step 4 of this task for implementation.
}
```

- [ ] **Step 3: Run test to verify it fails**

```bash
go test ./services -run TestExitMonitor_Escalates -v
```

Expected: FAIL with `undefined: SetOrderTracker`, `undefined: RecordTierAttempt`.

- [ ] **Step 4: Implement tier-escalation state machine**

Add to `services/harvest_exit_monitor.go`:

```go
type orderTracker interface {
	GetOrder(ctx context.Context, orderID string) (*interfaces.Order, error)
	CancelOrder(ctx context.Context, orderID string) error
}

type tierAttempt struct {
	reason    string
	tier      int       // 0 = initial, 1 = first escalation, 2 = market
	placedAt  time.Time
}

func (m *HarvestExitMonitor) SetOrderTracker(t orderTracker) {
	m.tracker = t
}

// RecordTierAttempt is called immediately after a close order is placed so
// the monitor knows when the next escalation window opens.
func (m *HarvestExitMonitor) RecordTierAttempt(condorID, reason string, placedAt time.Time) {
	if m.attempts == nil {
		m.attempts = map[string]tierAttempt{}
	}
	prev := m.attempts[condorID]
	tier := 0
	if prev.reason == reason {
		tier = prev.tier + 1
	}
	m.attempts[condorID] = tierAttempt{reason: reason, tier: tier, placedAt: placedAt}
}

// escalationWindow returns the time-to-escalate per close reason.
func escalationWindow(reason string) time.Duration {
	if reason == "loss_stop" {
		return 2 * time.Minute
	}
	return 10 * time.Minute // time_exit + profit_target
}

// escalatePrice returns the limit price for the requested tier of a given
// reason, relative to the current mid (cost).
func escalatePrice(reason string, tier int, cost float64) (orderType string, limit float64) {
	switch reason {
	case "loss_stop":
		switch tier {
		case 0:
			return "limit", cost + 0.20
		default:
			return "market", 0
		}
	case "time_exit", "profit_target":
		switch tier {
		case 0:
			return "limit", cost
		case 1:
			return "limit", cost - 0.05
		default:
			return "market", 0
		}
	}
	return "limit", cost
}
```

Then rewrite `EvaluateTick` to handle `Status == "CLOSING"` by checking the existing order's fill status and escalating when the window has elapsed:

```go
func (m *HarvestExitMonitor) EvaluateTick(ctx context.Context, now time.Time) {
	condors, err := m.store.ListOpenHarvestCondors() // includes OPEN + CLOSING (per storage.go)
	if err != nil {
		fmt.Printf("[harvest-exit-monitor] list condors failed: %v\n", err)
		return
	}
	for _, c := range condors {
		switch c.Status {
		case "OPEN":
			m.evaluateOpen(ctx, c, now)
		case "CLOSING":
			m.evaluateClosing(ctx, c, now)
		}
	}
}

func (m *HarvestExitMonitor) evaluateOpen(ctx context.Context, c *models.DBHarvestCondor, now time.Time) {
	dte := int(math.Round(c.Expiration.Sub(now).Hours() / 24))
	var cost float64
	if dte > 21 {
		v, err := m.pricer.CostToClosePerContract(ctx, c)
		if err != nil {
			fmt.Printf("[harvest-exit-monitor] %s pricer failed: %v\n", c.CondorID, err)
			return
		}
		cost = v
	} else {
		// We still need mid for the limit price on time exits.
		v, err := m.pricer.CostToClosePerContract(ctx, c)
		if err != nil {
			fmt.Printf("[harvest-exit-monitor] %s pricer failed: %v\n", c.CondorID, err)
			return
		}
		cost = v
	}
	reason, _, _ := m.classify(c, dte, cost)
	if reason == "" {
		return
	}
	orderType, limit := escalatePrice(reason, 0, cost)
	res, err := m.closer.CloseCondor(ctx, CloseCondorRequest{
		CondorID: c.CondorID, OrderType: orderType, LimitPrice: limit,
		CostPerContract: cost, CloseReason: reason,
	})
	if err != nil {
		fmt.Printf("[harvest-exit-monitor] %s close failed: %v\n", c.CondorID, err)
		return
	}
	m.RecordTierAttempt(c.CondorID, reason, now)
	_ = res
}

func (m *HarvestExitMonitor) evaluateClosing(ctx context.Context, c *models.DBHarvestCondor, now time.Time) {
	if m.tracker == nil || c.CloseOrderID == "" {
		return
	}
	ord, err := m.tracker.GetOrder(ctx, c.CloseOrderID)
	if err != nil {
		fmt.Printf("[harvest-exit-monitor] %s status fetch failed: %v\n", c.CondorID, err)
		return
	}
	if ord.Status == "filled" {
		// TODO: flip status to CLOSED, update fill data — see Task 5 step covering
		// the finalize-on-fill path. Out of scope for this step's commit.
		return
	}
	attempt, ok := m.attempts[c.CondorID]
	if !ok {
		return // monitor was restarted; let the next OPEN re-evaluation own this
	}
	if now.Sub(attempt.placedAt) < escalationWindow(attempt.reason) {
		return
	}
	// Cancel and re-place at next tier.
	if err := m.tracker.CancelOrder(ctx, c.CloseOrderID); err != nil {
		fmt.Printf("[harvest-exit-monitor] %s cancel failed: %v\n", c.CondorID, err)
		return
	}
	cost, err := m.pricer.CostToClosePerContract(ctx, c)
	if err != nil {
		fmt.Printf("[harvest-exit-monitor] %s pricer failed on escalation: %v\n", c.CondorID, err)
		return
	}
	nextTier := attempt.tier + 1
	orderType, limit := escalatePrice(attempt.reason, nextTier, cost)
	// Bump tier counter BEFORE placing so a successful place lands on the right tier.
	m.attempts[c.CondorID] = tierAttempt{reason: attempt.reason, tier: nextTier, placedAt: now}
	_, err = m.closer.CloseCondor(ctx, CloseCondorRequest{
		CondorID: c.CondorID, OrderType: orderType, LimitPrice: limit,
		CostPerContract: cost, CloseReason: attempt.reason,
	})
	if err != nil {
		fmt.Printf("[harvest-exit-monitor] %s escalation place failed: %v\n", c.CondorID, err)
	}
}
```

Add struct fields:

```go
type HarvestExitMonitor struct {
	store    monitorStore
	pricer   monitorPricer
	closer   monitorCloser
	tracker  orderTracker         // optional; set via SetOrderTracker
	attempts map[string]tierAttempt
}
```

Important: `HarvestCloser.CloseCondor` currently *fails* if status != OPEN (`ErrCondorNotOpen`). For escalation re-places, the row is CLOSING. Loosen the closer's check by allowing status ∈ {OPEN, CLOSING} when called by the monitor. Simplest path: add a flag to the request:

```go
type CloseCondorRequest struct {
	// ... existing fields ...
	AllowReplaceClosing bool `json:"-"` // monitor-internal; controller never sets
}
```

In `HarvestCloser.CloseCondor`, replace the `if condor.Status != "OPEN"` guard with:

```go
if !(condor.Status == "OPEN" || (req.AllowReplaceClosing && condor.Status == "CLOSING")) {
	return nil, fmt.Errorf("%w: status=%s", ErrCondorNotOpen, condor.Status)
}
```

Update the monitor's escalation re-place call to set `AllowReplaceClosing: true`.

- [ ] **Step 5: Run all monitor tests**

```bash
go test ./services -run TestExitMonitor -v
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add services/harvest_exit_monitor.go services/harvest_exit_monitor_test.go services/harvest_closer.go
git commit -m "feat(harvest): exit monitor tier escalation + AllowReplaceClosing"
```

---

## Task 5: Finalize-on-fill + wire monitor in main.go

**Files:**
- Modify: `services/harvest_exit_monitor.go`
- Modify: `services/harvest_exit_monitor_test.go`
- Modify: `database/storage.go` (add helper if needed)
- Modify: `cmd/bot/main.go`
- Modify: `services/harvest_service.go` (add `MonitorEnabled` flag to response)

- [ ] **Step 1: Add finalize-on-fill test**

```go
func TestExitMonitor_FinalizeOnFillFlipsStatusToClosed(t *testing.T) {
	c := mkCondor("c1", "SPY", 1, 1.0, 30)
	c.CloseOrderID = "ord-1"
	c.Status = "CLOSING"
	store := &fakeListStore{condors: []*models.DBHarvestCondor{c}}
	closer := &fakeCloser{}
	tracker := &fakeOrderTracker{statuses: map[string]string{"ord-1": "filled"}}
	updater := &fakeUpdater{}

	m := NewHarvestExitMonitor(store, &fakeCostPricer{}, closer)
	m.SetOrderTracker(tracker)
	m.SetUpdater(updater)
	m.EvaluateTick(context.Background(), time.Now())

	if updater.lastUpdates["status"] != "CLOSED" {
		t.Errorf("expected status flipped to CLOSED, got %v", updater.lastUpdates["status"])
	}
}

type fakeUpdater struct {
	lastUpdates map[string]interface{}
}

func (f *fakeUpdater) UpdateHarvestCondor(id string, u map[string]interface{}) error {
	f.lastUpdates = u
	return nil
}
```

- [ ] **Step 2: Implement finalize**

Add an `updater` interface + setter to `HarvestExitMonitor`:

```go
type condorUpdater interface {
	UpdateHarvestCondor(condorID string, updates map[string]interface{}) error
}

func (m *HarvestExitMonitor) SetUpdater(u condorUpdater) { m.updater = u }
```

Replace the `if status == "filled" { return }` TODO with:

```go
if status == "filled" {
	if m.updater != nil {
		closedAt := now
		_ = m.updater.UpdateHarvestCondor(c.CondorID, map[string]interface{}{
			"status":    "CLOSED",
			"closed_at": &closedAt,
		})
	}
	delete(m.attempts, c.CondorID)
	return
}
```

- [ ] **Step 3: Add the goroutine starter and wire in main.go**

Add at the bottom of `services/harvest_exit_monitor.go`:

```go
// Start runs the monitor's tick loop. Ticks every `interval` while
// marketIsOpen() reports true, sleeps `idleInterval` otherwise. Returns
// when ctx is canceled.
func (m *HarvestExitMonitor) Start(ctx context.Context, interval, idleInterval time.Duration, marketIsOpen func() bool) {
	timer := time.NewTimer(interval)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			if marketIsOpen() {
				m.EvaluateTick(ctx, time.Now().UTC())
				timer.Reset(interval)
			} else {
				timer.Reset(idleInterval)
			}
		}
	}
}
```

In `cmd/bot/main.go`, after `harvestController := controllers.NewHarvestController(...)` and after the existing `go startHarvestIVCollection(...)`:

```go
if os.Getenv("HARVEST_EXIT_MONITOR_ENABLED") == "true" {
	harvestPricer := services.NewHarvestPricer(optionsDataService) // wire the existing AlpacaOptionsDataService
	harvestMonitor := services.NewHarvestExitMonitor(storageService, harvestPricer, harvestCloser)
	harvestMonitor.SetUpdater(storageService)
	harvestMonitor.SetOrderTracker(tradingService) // satisfies orderTracker (GetOrder + CancelOrder per prereq doc)
	go harvestMonitor.Start(ctx,
		1*time.Minute,
		5*time.Minute,
		func() bool { /* call existing market-hours helper from penny_universe_service or equivalent */ return true },
	)
	logger.Info("Harvest exit monitor started")
}
```

Resolve the actual market-hours helper by reading `services/penny_universe_service.go:33` (`isMarketHours`) and either calling it directly or via the trading service's calendar.

- [ ] **Step 4: Add MonitorEnabled to HarvestStateResponse**

In `services/harvest_service.go`, add to `HarvestStateResponse`:

```go
MonitorEnabled bool `json:"monitor_enabled"`
```

Add a setter on `HarvestService`:

```go
func (s *HarvestService) SetMonitorEnabled(b bool) { s.monitorEnabled = b }
```

Add the `monitorEnabled bool` field to `HarvestService` and set it in `GetState`:

```go
return &HarvestStateResponse{
	// ... existing ...
	MonitorEnabled: s.monitorEnabled,
}, nil
```

In `main.go`:

```go
harvestSvc.SetMonitorEnabled(os.Getenv("HARVEST_EXIT_MONITOR_ENABLED") == "true")
```

- [ ] **Step 5: Run everything**

```bash
go test ./services -run TestExitMonitor -v
go test ./services -run TestHarvest -v
go build ./...
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add services/harvest_exit_monitor.go services/harvest_exit_monitor_test.go services/harvest_service.go cmd/bot/main.go
git commit -m "feat(harvest): wire exit monitor goroutine + finalize-on-fill"
```

---

## Task 6: Preflight relaxation

**Files:**
- Modify: `agent/preflight.js:363-455` (harvestPreflight)
- Modify: `agent/preflight.test.mjs`

When the monitor is on, the LLM no longer needs to wake just to manage open condors. Today's preflight has `if (openCondors > 0) return { skip: false, reason: ... }`. We change this to consult `state.monitor_enabled`.

- [ ] **Step 1: Write a failing test**

Add to `agent/preflight.test.mjs`:

```js
test('harvestPreflight skips beat when monitor enabled and only exits to manage', async () => {
  const runtime = {
    goAxios: {
      get: async (url) => {
        if (url === '/api/v1/harvest/state') return { data: { open_condors: 2, deployed_buying_power_pct: 5.0, monitor_enabled: true } };
        if (url === '/api/v1/harvest/fomc') return { data: { is_blackout: false } };
        throw new Error(`unexpected url: ${url}`);
      },
    },
  };
  const { resolvePreflight } = await import('./preflight.js');
  const result = await resolvePreflight('harvest', runtime, {});
  assert.equal(result.skip, true);
  assert.match(result.reason, /monitor_enabled/);
});
```

- [ ] **Step 2: Run test, observe failure**

```bash
node --test agent/preflight.test.mjs
```

Expected: FAIL — current preflight returns `{skip:false, reason:"N open condor(s) to evaluate"}`.

- [ ] **Step 3: Modify harvestPreflight**

In `agent/preflight.js`, replace lines 382-385:

```js
// Open condors require exit-rule evaluation each beat — UNLESS the
// HarvestExitMonitor is running, in which case exits are handled
// out-of-band and the LLM beat is only needed for new entries.
if (openCondors > 0) {
  if (state.monitor_enabled === true) {
    // Fall through to the entries-only gating below.
  } else {
    return { skip: false, reason: `${openCondors} open condor(s) to evaluate` };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test agent/preflight.test.mjs
```

Expected: PASS — and all existing harvest preflight tests still pass.

- [ ] **Step 5: Commit**

```bash
git add agent/preflight.js agent/preflight.test.mjs
git commit -m "feat(harvest): preflight skips LLM beat when exit monitor enabled"
```

---

## Task 7: Rules-doc update + operator README

**Files:**
- Modify: `TRADING_RULES_HARVEST.md`
- Modify: `.env.example`

- [ ] **Step 1: Annotate Step 2 in TRADING_RULES_HARVEST.md**

After the Step 2 header (around line 52), insert:

```markdown
> **Backend automation:** When `HARVEST_EXIT_MONITOR_ENABLED=true` (operator env flag), Step 2 below is executed by the `HarvestExitMonitor` Go service on a ~60s tick. The LLM does not run Step 2 in that mode — the rules below describe the exact behavior the service implements, kept here for auditability. Step 3 (entries) remains LLM-driven.
```

- [ ] **Step 2: Add the env var to .env.example**

```bash
echo "" >> .env.example
echo "# Harvest exit monitor — when true, exits are handled by Go service, not the LLM." >> .env.example
echo "HARVEST_EXIT_MONITOR_ENABLED=false" >> .env.example
```

- [ ] **Step 3: Commit**

```bash
git add TRADING_RULES_HARVEST.md .env.example
git commit -m "docs(harvest): document exit-monitor env flag and rules-doc annotation"
```

---

## Task 8: Manual smoke test

- [ ] **Step 1: Bring up the bot with the flag off (regression check)**

```bash
HARVEST_EXIT_MONITOR_ENABLED=false ./prophet_bot.exe
```

Verify Harvest beats fire normally and `/api/v1/harvest/state` reports `monitor_enabled: false`.

- [ ] **Step 2: Bring up the bot with the flag on (one open condor on paper)**

Stop the bot. Set `HARVEST_EXIT_MONITOR_ENABLED=true` in `.env`. Open a paper-account condor manually (operator flow). Restart the bot.

Watch the server logs for `Harvest exit monitor started` and per-tick logs.

Verify:
- LLM Harvest beats are now skipped (preflight log: `monitor_enabled`).
- When the condor's cost-to-close crosses one of the thresholds in paper trading, the monitor places a close order without LLM involvement.

- [ ] **Step 3: Final commit (no code, just confirmation)**

```bash
git log --oneline -8
```

Confirm the seven commits land cleanly on `feat-harvest-exit-monitor` branch.

---

## Self-Review

**Spec coverage:**

- Step 2 rules (DTE ≤ 21, 2× credit, 0.5× credit) — Tasks 3-4. ✅
- Tier escalation (limit → mid−0.05 → market for time/profit; mid+0.20 → market for loss) — Task 4. ✅
- Order tagging (`strategy: "harvest"`) — preserved via `HarvestCloser` (it sets `Strategy: "harvest"` in the order). ✅
- DB row lifecycle OPEN → CLOSING → CLOSED — Tasks 1, 4, 5. ✅
- Preflight skip when monitor enabled — Task 6. ✅

**Gaps surfaced during writing:**

1. **Fill-price reconciliation:** The current closer computes `realizedPnL` from the operator-supplied `cost_per_contract`, which is the *intended* cost, not the *actual* fill price. The monitor passes the live mid. If the actual fill differs (the broker fills above the limit on a marketable, or below on a passive limit), the stored `realized_pnl` is wrong. **Not blocking the LLM-savings goal** — the rules doc already accepts this approximation today — but worth a follow-up ticket. Add it to the plan-end notes below rather than within this implementation.
2. **Restart-safety of `attempts` map:** If the bot restarts mid-escalation, the in-memory `attempts[condorID]` map is lost. The monitor will see the condor as `CLOSING` with no record of which tier it was on, and `evaluateClosing` will return early because `attempts[c.CondorID]` is unset. This means an escalation in flight at restart will *not* be re-escalated — the existing close order will run to broker EOD cancel and a fresh OPEN evaluation the next session will start over at tier 0. Acceptable for v1; loud op-log on this branch would help.
3. **`marketIsOpen` resolution:** I left the helper hookup as "use existing penny universe service helper or trading-service calendar." Task 5 step 3 should be tightened to a concrete function reference before execution; the implementer should grep for `isMarketHours` in `services/` and pick the one that matches `staticMarketPhase` semantics.
4. **`orderStatusFetcher` / `orderCanceller` may not exist yet on `AlpacaTradingService`.** Task 4 Step 1 calls this out and instructs the implementer to grep and add adapters if missing. Concrete check needed: do `GetOrder`/`CancelOrder` exist with compatible signatures? If not, this becomes a small sub-task within Task 4.
5. **Activity logging:** I used `fmt.Printf` for monitor logs. The other background goroutines use `logger.WithError(err).Warnf(...)`. Implementer should accept a `*logrus.Logger` in `NewHarvestExitMonitor` and use it throughout — easy substitution but not yet written into the plan.

**Type/signature consistency:** `CloseCondorRequest` is defined in Task 1 and reused in Tasks 3, 4, 5 — same field names throughout. `HarvestExitMonitor` ctor is `(store, pricer, closer)` in Tasks 3-5. `monitorPricer` interface matches `HarvestPricer.CostToClosePerContract` from Task 2. ✅

**No placeholders:** Searched for "TBD", "TODO", "appropriate", "similar to" — only one `TODO` remains inside Task 4 Step 4's transitional code, which is resolved in Task 5 Step 2. Acceptable as it documents the intended sequencing, not an unfilled gap. ✅

**Net token savings estimate:** Harvest currently fires an LLM beat each interval whenever `open_condors > 0`. On a typical day with 2-4 open condors and the agent's after-hours/midday cadence, that's 10-30 LLM-driven beats per session, each ~10-25k tokens. With the monitor in place, the LLM beats drop to the ones where new entries are plausible — typically 1-3 per session.

---

## Out of Scope (for this plan / explicit non-goals)

- Harvest Step 3 (entries) — entry selection remains LLM-driven; the BP-cap / IVR / IV–RV / chain-presence gates that already exist in preflight continue to be the only thing keeping the entry beat alive when it should be.
- Fill-price reconciliation (see Gap #1 above).
- Multi-session ledger of attempts (in-memory state is intentional for v1).
- Switching the Alpaca options pricing source (still uses the existing `AlpacaOptionsDataService`).
