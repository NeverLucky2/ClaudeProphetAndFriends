package controllers

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"prophet-trader/interfaces"
	"prophet-trader/services"
)

// recordingTradingService captures every PlaceOrder call so a test can assert
// exactly what hit the broker boundary. The other TradingService methods are
// no-ops returning nil; tests that exercise paths through them should extend.
type recordingTradingService struct {
	mu                  sync.Mutex
	recordedOrders      []*interfaces.Order
	portfolio           float64
	cash                float64
	optionsOrdersPlaced int
}

func (r *recordingTradingService) PlaceOrder(_ context.Context, order *interfaces.Order) (*interfaces.OrderResult, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	cp := *order
	r.recordedOrders = append(r.recordedOrders, &cp)
	return &interfaces.OrderResult{OrderID: "rec-" + order.Symbol, Status: "accepted"}, nil
}

func (r *recordingTradingService) CancelOrder(_ context.Context, _ string) error { return nil }
func (r *recordingTradingService) GetOrder(_ context.Context, _ string) (*interfaces.Order, error) {
	return nil, nil
}
func (r *recordingTradingService) ListOrders(_ context.Context, _ string) ([]*interfaces.Order, error) {
	return nil, nil
}
func (r *recordingTradingService) GetPositions(_ context.Context) ([]*interfaces.Position, error) {
	return nil, nil
}
func (r *recordingTradingService) GetAccount(_ context.Context) (*interfaces.Account, error) {
	return &interfaces.Account{PortfolioValue: r.portfolio, Cash: r.cash, LastEquity: r.portfolio}, nil
}
func (r *recordingTradingService) PlaceOptionsOrder(_ context.Context, order *interfaces.OptionsOrder) (*interfaces.OrderResult, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.optionsOrdersPlaced++
	return &interfaces.OrderResult{OrderID: "opt-" + order.Symbol, Status: "accepted"}, nil
}
func (r *recordingTradingService) GetOptionsChain(_ context.Context, _ string, _ time.Time) ([]*interfaces.OptionContract, error) {
	return nil, nil
}
func (r *recordingTradingService) GetOptionsQuote(_ context.Context, _ string) (*interfaces.OptionsQuote, error) {
	return nil, nil
}
func (r *recordingTradingService) GetOptionsPosition(_ context.Context, _ string) (*interfaces.OptionsPosition, error) {
	return nil, nil
}
func (r *recordingTradingService) ListOptionsPositions(_ context.Context) ([]*interfaces.OptionsPosition, error) {
	return nil, nil
}

// noopStorage satisfies interfaces.StorageService with empty behavior so the
// controller's SaveOrder call doesn't crash. Not the focus of these tests.
type noopStorage struct{}

func (noopStorage) SaveBars(_ []*interfaces.Bar) error  { return nil }
func (noopStorage) GetBars(_ string, _, _ time.Time) ([]*interfaces.Bar, error) {
	return nil, nil
}
func (noopStorage) SaveOrder(_ *interfaces.Order) error { return nil }
func (noopStorage) GetOrder(_ string) (*interfaces.Order, error) { return nil, nil }
func (noopStorage) GetOrders(_ string) ([]*interfaces.Order, error) { return nil, nil }
func (noopStorage) GetSymbolStrategyAttribution() (map[string]string, error) {
	return map[string]string{}, nil
}
func (noopStorage) CleanupOldData(_ time.Time) error { return nil }

// TestHandleSell_LimitOrderRoundTrip pins the field-binding contract that
// produced Spark's 2026-05-18 LAND fiasco. The MCP server was sending
// `order_type: "limit"` but SellRequest binds on `json:"type"` — so req.Type
// stayed empty and defaulted to "market" inside Sell(), while limit_price was
// forwarded correctly, producing a market order with a limit_price attached.
// Alpaca rejected with HTTP 422 code 40010001 ("market orders require no stop
// or limit price"). This test asserts that a well-formed POST with `type` and
// `limit_price` reaches the trading service as an actual limit order.
func TestHandleSell_LimitOrderRoundTrip(t *testing.T) {
	gin.SetMode(gin.TestMode)

	trading := &recordingTradingService{}
	oc := NewOrderController(trading, nil, noopStorage{})

	router := gin.New()
	router.POST("/api/v1/orders/sell", oc.HandleSell)

	body := bytes.NewBufferString(`{
		"symbol": "LAND",
		"qty": 216,
		"type": "limit",
		"limit_price": 9.58,
		"strategy": "penny-momentum"
	}`)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/orders/sell", body)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status: want 200, got %d (body=%s)", w.Code, w.Body.String())
	}

	if len(trading.recordedOrders) != 1 {
		t.Fatalf("expected 1 order at trading boundary, got %d", len(trading.recordedOrders))
	}
	o := trading.recordedOrders[0]
	if o.Type != "limit" {
		t.Errorf("trading boundary received Type=%q, want \"limit\" (pre-fix would default to \"market\")", o.Type)
	}
	if o.Side != "sell" {
		t.Errorf("Side=%q, want sell", o.Side)
	}
	if o.LimitPrice == nil {
		t.Fatal("LimitPrice should be set for a limit order")
	}
	if *o.LimitPrice != 9.58 {
		t.Errorf("LimitPrice=%v, want 9.58", *o.LimitPrice)
	}
	if o.Strategy != "penny-momentum" {
		t.Errorf("Strategy=%q, want penny-momentum (attribution must propagate)", o.Strategy)
	}
}

// TestHandleSell_DefaultsToMarketOnEmptyType pins the legitimate legacy
// behavior of the type-default. A caller that sends NO type and NO limit_price
// gets a market order — that path is fine and existing HTTP clients depend on
// it. The 2026-05-18 bug was specifically the mismatch where the binding
// silently dropped a value rather than the default itself being wrong.
func TestHandleSell_DefaultsToMarketOnEmptyType(t *testing.T) {
	gin.SetMode(gin.TestMode)

	trading := &recordingTradingService{}
	oc := NewOrderController(trading, nil, noopStorage{})

	router := gin.New()
	router.POST("/api/v1/orders/sell", oc.HandleSell)

	body := bytes.NewBufferString(`{"symbol": "AAPL", "qty": 10}`)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/orders/sell", body)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status: want 200, got %d (body=%s)", w.Code, w.Body.String())
	}
	if len(trading.recordedOrders) != 1 {
		t.Fatalf("expected 1 order, got %d", len(trading.recordedOrders))
	}
	if trading.recordedOrders[0].Type != "market" {
		t.Errorf("Type=%q, want market (default for empty type)", trading.recordedOrders[0].Type)
	}
}

// stubGuardLister is a minimal positionLister for constructing a TradeGuard in
// controller tests. It reports no managed positions so the only factor is the
// per-trade notional check.
type stubGuardLister struct{}

func (stubGuardLister) ListManagedPositions(_ string) []*services.ManagedPosition { return nil }

// TestHandleBuy_LimitOrderRoundTrip mirrors the sell test on the buy path —
// same field-binding bug class, same fix obligation. We pin both so neither
// silently regresses.
func TestHandleBuy_LimitOrderRoundTrip(t *testing.T) {
	gin.SetMode(gin.TestMode)

	trading := &recordingTradingService{}
	oc := NewOrderController(trading, nil, noopStorage{})

	router := gin.New()
	router.POST("/api/v1/orders/buy", oc.HandleBuy)

	body := bytes.NewBufferString(`{
		"symbol": "III",
		"qty": 100,
		"type": "limit",
		"limit_price": 4.20,
		"strategy": "penny-momentum"
	}`)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/orders/buy", body)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status: want 200, got %d (body=%s)", w.Code, w.Body.String())
	}
	if len(trading.recordedOrders) != 1 {
		t.Fatalf("expected 1 order, got %d", len(trading.recordedOrders))
	}
	o := trading.recordedOrders[0]
	if o.Type != "limit" {
		t.Errorf("Type=%q, want limit", o.Type)
	}
	if o.Side != "buy" {
		t.Errorf("Side=%q, want buy", o.Side)
	}
	if o.LimitPrice == nil || *o.LimitPrice != 4.20 {
		t.Errorf("LimitPrice=%v, want 4.20", o.LimitPrice)
	}
}

// TestBuy_AttributesByStrategyTagNotAgentSource asserts that the guard agent
// is derived from the strategy tag when agent_source is absent — reproducing
// the production attribution gap where every order defaulted to AgentMain.
func TestBuy_AttributesByStrategyTagNotAgentSource(t *testing.T) {
	// Production sends strategy="penny-momentum" and NO agent_source. The guard
	// must see AgentPenny so the $500 penny per-position cap applies.
	rec := &recordingTradingService{portfolio: 100000, cash: 100000}
	guard := services.NewTradeGuard(&stubGuardLister{}, rec, services.TradeGuardConfig{
		PennyMaxPositionDollars: 500, PennyMaxCapitalPct: 0.20,
	})
	oc := NewOrderController(rec, nil, noopStorage{})
	oc.SetGuard(guard)
	lp := 1.0
	// $1 * 600 = $600 > $500 penny per-position cap — only blocks if attributed to penny.
	_, err := oc.Buy(context.Background(), BuyRequest{
		Symbol: "ABCD", Qty: 600, Type: "limit", LimitPrice: &lp, Strategy: "penny-momentum",
	})
	if err == nil {
		t.Fatal("expected penny per-position cap to block a $600 buy attributed via strategy tag")
	}
	if !strings.Contains(err.Error(), "per-position cap") {
		t.Fatalf("expected penny per-position cap error, got: %v", err)
	}
}

// TestBuy_ComputesAllocationForAllAgents asserts that the per-position cap
// fires on a non-penny (main) buy. Before the fix, allocationDollars was
// always 0 for non-penny agents, so the cap could never trigger.
func TestBuy_ComputesAllocationForAllAgents(t *testing.T) {
	rec := &recordingTradingService{portfolio: 100000, cash: 100000}
	guard := services.NewTradeGuard(&stubGuardLister{}, rec, services.TradeGuardConfig{
		EnablePositionCaps: true, MaxPositionPct: 0.12, MaxDeployedPct: 0.50,
	})
	oc := NewOrderController(rec, nil, noopStorage{})
	oc.SetGuard(guard)
	lp := 100.0
	// 200 * $100 = $20k > 12% of $100k — must block a MAIN (non-penny) buy.
	_, err := oc.Buy(context.Background(), BuyRequest{
		Symbol: "AAPL", Qty: 200, Type: "limit", LimitPrice: &lp, Strategy: "v2-options",
	})
	if err == nil {
		t.Fatal("expected per-position cap to block a $20k main stock buy")
	}
	// Discriminating assertion: the block must come from the real per-position
	// cap (computed $20k notional), NOT the indeterminate-notional fail-closed
	// path. The pre-fix penny-only code left allocationDollars=0 for main, which
	// would have blocked with "could not be determined" instead — so this keeps
	// the test honest as a red→green regression guard.
	if !strings.Contains(err.Error(), "per-position cap") {
		t.Fatalf("expected per-position cap error (from computed notional), got: %v", err)
	}
}

func TestPlaceOptionsOrder_GuardBlocksOversizedOpen(t *testing.T) {
	gin.SetMode(gin.TestMode)
	rec := &recordingTradingService{portfolio: 100000, cash: 100000}
	guard := services.NewTradeGuard(&stubGuardLister{}, rec, services.TradeGuardConfig{
		EnablePositionCaps: true, MaxPositionPct: 0.12, MaxDeployedPct: 0.50,
	})
	oc := NewOrderController(rec, nil, noopStorage{})
	oc.SetGuard(guard)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	// 30 * $6 * 100 = $18,000 > 12% of $100k → blocked on buy_to_open.
	body := `{"symbol":"SPY260116C00500000","underlying":"SPY","qty":30,"side":"buy","position_intent":"buy_to_open","type":"limit","limit_price":6,"strategy":"v2-options"}`
	c.Request = httptest.NewRequest("POST", "/options/order", bytes.NewBufferString(body))
	c.Request.Header.Set("Content-Type", "application/json")
	oc.PlaceOptionsOrder(c)
	if rec.optionsOrdersPlaced != 0 {
		t.Fatalf("guard should block before placement, placed=%d", rec.optionsOrdersPlaced)
	}
}

func TestPlaceOptionsOrder_CloseNotBlocked(t *testing.T) {
	gin.SetMode(gin.TestMode)
	rec := &recordingTradingService{portfolio: 100000, cash: 95000}
	guard := services.NewTradeGuard(&stubGuardLister{}, rec, services.TradeGuardConfig{
		EnablePositionCaps: true, MaxPositionPct: 0.12, MaxDeployedPct: 0.50,
	})
	oc := NewOrderController(rec, nil, noopStorage{})
	oc.SetGuard(guard)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	body := `{"symbol":"SPY260116C00500000","underlying":"SPY","qty":30,"side":"sell","position_intent":"sell_to_close","type":"market","strategy":"v2-options"}`
	c.Request = httptest.NewRequest("POST", "/options/order", bytes.NewBufferString(body))
	c.Request.Header.Set("Content-Type", "application/json")
	oc.PlaceOptionsOrder(c)
	if rec.optionsOrdersPlaced != 1 {
		t.Fatalf("close order must not be blocked, placed=%d", rec.optionsOrdersPlaced)
	}
}

