package controllers

import (
	"bytes"
	"context"
	"errors"
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
	optionsQuote        *interfaces.OptionsQuote
	optionsQuoteErr     error
	optionsQuoteCalls   int
	listOrdersResult    []*interfaces.Order
	listOrdersErr       error
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
	return r.listOrdersResult, r.listOrdersErr
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
	r.mu.Lock()
	defer r.mu.Unlock()
	r.optionsQuoteCalls++
	return r.optionsQuote, r.optionsQuoteErr
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
		"strategy": "v2-options"
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
	if o.Strategy != "v2-options" {
		t.Errorf("Strategy=%q, want v2-options (attribution must propagate)", o.Strategy)
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
		"strategy": "v2-options"
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
// TestBuy_ComputesAllocationForAllAgents asserts that the per-position cap
// fires on a non-main agent buy. Before the fix, allocationDollars was
// always 0 for non-main agents, so the cap could never trigger.
func TestBuy_ComputesAllocationForAllAgents(t *testing.T) {
	rec := &recordingTradingService{portfolio: 100000, cash: 100000}
	guard := services.NewTradeGuard(&stubGuardLister{}, rec, services.TradeGuardConfig{
		EnablePositionCaps: true, MaxPositionPct: 0.12, MaxDeployedPct: 0.50,
	})
	oc := NewOrderController(rec, nil, noopStorage{})
	oc.SetGuard(guard)
	lp := 100.0
	// 200 * $100 = $20k > 12% of $100k — must block a main buy.
	_, err := oc.Buy(context.Background(), BuyRequest{
		Symbol: "AAPL", Qty: 200, Type: "limit", LimitPrice: &lp, Strategy: "v2-options",
	})
	if err == nil {
		t.Fatal("expected per-position cap to block a $20k main stock buy")
	}
	// Discriminating assertion: the block must come from the real per-position
	// cap (computed $20k notional), NOT the indeterminate-notional fail-closed
	// path. The pre-fix code left allocationDollars=0 for main, which
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

func postOptionsOrder(t *testing.T, oc *OrderController, body string) *httptest.ResponseRecorder {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.POST("/options/order", oc.PlaceOptionsOrder)
	req := httptest.NewRequest("POST", "/options/order", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestPlaceOptionsOrder_UniverseAndSpreadGates(t *testing.T) {
	floor := map[string]bool{"NVDA": true}
	guard := services.NewTradeGuard(nil, nil, services.TradeGuardConfig{
		EnableUniverseGate:      true,
		TradableUnderlyings:     floor,
		EnableOptionsSpreadGate: true,
		SpreadMaxPct:            0.10,
		OptionsQuoteMaxAge:      60 * time.Second,
	})

	// (a) off-floor underlying via OCC fallback (blank Underlying) -> 422, never placed.
	ts := &recordingTradingService{optionsQuote: &interfaces.OptionsQuote{BidPrice: 1, AskPrice: 1.02, Timestamp: time.Now()}}
	oc := NewOrderController(ts, nil, nil)
	oc.SetGuard(guard)
	w := postOptionsOrder(t, oc, `{"symbol":"PLUG251219C00010000","qty":1,"side":"buy","type":"limit","limit_price":1.0,"strategy":"v2-options"}`)
	if w.Code != 422 {
		t.Fatalf("off-floor OCC fallback should 422, got %d (body=%s)", w.Code, w.Body.String())
	}
	if ts.optionsOrdersPlaced != 0 {
		t.Errorf("broker must not be called for off-floor open, placed=%d", ts.optionsOrdersPlaced)
	}

	// (b) on-floor + wide spread -> 422, exactly one quote fetch.
	ts2 := &recordingTradingService{optionsQuote: &interfaces.OptionsQuote{BidPrice: 1.0, AskPrice: 1.3, Timestamp: time.Now()}}
	oc2 := NewOrderController(ts2, nil, nil)
	oc2.SetGuard(guard)
	w2 := postOptionsOrder(t, oc2, `{"symbol":"NVDA251219C00400000","underlying":"NVDA","qty":1,"side":"buy","type":"limit","limit_price":1.0,"strategy":"v2-options"}`)
	if w2.Code != 422 {
		t.Fatalf("wide spread should 422, got %d (body=%s)", w2.Code, w2.Body.String())
	}
	if ts2.optionsQuoteCalls != 1 {
		t.Errorf("expected exactly one quote fetch (shared), got %d", ts2.optionsQuoteCalls)
	}

	// (c) on-floor + tight spread -> placed (200 or 201).
	ts3 := &recordingTradingService{optionsQuote: &interfaces.OptionsQuote{BidPrice: 5.0, AskPrice: 5.1, Timestamp: time.Now()}}
	oc3 := NewOrderController(ts3, nil, noopStorage{})
	oc3.SetGuard(guard)
	w3 := postOptionsOrder(t, oc3, `{"symbol":"NVDA251219C00400000","underlying":"NVDA","qty":1,"side":"buy","type":"limit","limit_price":5.0,"strategy":"v2-options"}`)
	if w3.Code != 200 && w3.Code != 201 {
		t.Fatalf("tight-spread on-floor order should place, got %d (body=%s)", w3.Code, w3.Body.String())
	}

	// (d) close of an off-floor name is never gated.
	ts4 := &recordingTradingService{optionsQuote: &interfaces.OptionsQuote{BidPrice: 1.0, AskPrice: 1.3, Timestamp: time.Now()}}
	oc4 := NewOrderController(ts4, nil, noopStorage{})
	oc4.SetGuard(guard)
	w4 := postOptionsOrder(t, oc4, `{"symbol":"PLUG251219C00010000","qty":1,"side":"sell","position_intent":"sell_to_close","type":"limit","limit_price":1.0,"strategy":"v2-options"}`)
	if w4.Code == 422 {
		t.Error("closing an off-floor position must never be blocked by the open gates")
	}
}

func TestPlaceOptionsOrder_FullPath_GatedAndAttributedToMain(t *testing.T) {
	gin.SetMode(gin.TestMode)

	// Gap #1: with caps on, an $18k buy is gated (not placed) — proves options
	// now reach the guard.
	rec := &recordingTradingService{portfolio: 100000, cash: 100000}
	guard := services.NewTradeGuard(&stubGuardLister{}, rec, services.TradeGuardConfig{
		EnablePositionCaps: true, MaxPositionPct: 0.12, MaxDeployedPct: 0.50,
	})
	oc := NewOrderController(rec, nil, noopStorage{})
	oc.SetGuard(guard)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	big := `{"symbol":"SPY260116C00500000","underlying":"SPY","qty":30,"side":"buy","position_intent":"buy_to_open","type":"limit","limit_price":6,"strategy":"v2-options"}`
	c.Request = httptest.NewRequest("POST", "/options/order", bytes.NewBufferString(big))
	c.Request.Header.Set("Content-Type", "application/json")
	oc.PlaceOptionsOrder(c)
	if rec.optionsOrdersPlaced != 0 {
		t.Fatalf("gap #1: options order should be gated, placed=%d", rec.optionsOrdersPlaced)
	}

	// Gap #2: a small buy (caps off) attributes to AgentMain via strategy tag.
	rec2 := &recordingTradingService{portfolio: 100000, cash: 100000}
	guard2 := services.NewTradeGuard(&stubGuardLister{}, rec2, services.TradeGuardConfig{})
	oc2 := NewOrderController(rec2, nil, noopStorage{})
	oc2.SetGuard(guard2)
	c2, _ := gin.CreateTestContext(httptest.NewRecorder())
	small := `{"symbol":"SPY260116C00500000","underlying":"SPY","qty":1,"side":"buy","position_intent":"buy_to_open","type":"limit","limit_price":1,"strategy":"v2-options"}`
	c2.Request = httptest.NewRequest("POST", "/options/order", bytes.NewBufferString(small))
	c2.Request.Header.Set("Content-Type", "application/json")
	oc2.PlaceOptionsOrder(c2)
	st := guard2.Status(context.Background())
	found := false
	for _, s := range st.MainSymbols {
		if s == "SPY260116C00500000" {
			found = true
		}
	}
	if !found {
		t.Fatal("gap #2: options buy with strategy=v2-options must attribute to AgentMain")
	}
}

// chainErrTradingService embeds the recording stub (for its full method set)
// and overrides GetOptionsChain to return a preset error, so we can assert the
// controller's HTTP status mapping.
type chainErrTradingService struct {
	*recordingTradingService
	err error
}

func (s *chainErrTradingService) GetOptionsChain(_ context.Context, _ string, _ time.Time) ([]*interfaces.OptionContract, error) {
	return nil, s.err
}

func TestGetOptionsChain_RateLimitedReturns429(t *testing.T) {
	gin.SetMode(gin.TestMode)
	trading := &chainErrTradingService{
		recordingTradingService: &recordingTradingService{},
		err:                     &services.RateLimitedError{RetryAfter: 4 * time.Second, Body: "too many requests"},
	}
	oc := NewOrderController(trading, nil, noopStorage{})

	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Params = gin.Params{{Key: "symbol", Value: "SPY"}}
	c.Request = httptest.NewRequest(http.MethodGet, "/api/options/chain/SPY", nil)

	oc.GetOptionsChain(c)

	if w.Code != http.StatusTooManyRequests {
		t.Errorf("status: got %d, want 429", w.Code)
	}
	if got := w.Header().Get("Retry-After"); got != "4" {
		t.Errorf("Retry-After: got %q, want \"4\"", got)
	}
}

func TestGetOptionsChain_OtherErrorReturns500(t *testing.T) {
	gin.SetMode(gin.TestMode)
	trading := &chainErrTradingService{
		recordingTradingService: &recordingTradingService{},
		err:                     errors.New("options chain API error (HTTP 503): boom"),
	}
	oc := NewOrderController(trading, nil, noopStorage{})

	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Params = gin.Params{{Key: "symbol", Value: "SPY"}}
	c.Request = httptest.NewRequest(http.MethodGet, "/api/options/chain/SPY", nil)

	oc.GetOptionsChain(c)

	if w.Code != http.StatusInternalServerError {
		t.Errorf("status: got %d, want 500", w.Code)
	}
}

// TestHandleFillsSummary verifies the endpoint passes the strategy + since
// filters through to SummarizeFills and returns the JSON summary.
func TestHandleFillsSummary(t *testing.T) {
	gin.SetMode(gin.TestMode)

	since := time.Date(2026, 5, 26, 4, 0, 0, 0, time.UTC)
	filledAt := since.Add(6 * time.Hour)
	avg := 184.20
	trading := &recordingTradingService{
		listOrdersResult: []*interfaces.Order{
			{Symbol: "AAPL", Side: "buy", Status: "filled", ClientOrderID: "mean-rev-rsi2:u1",
				Strategy: "mean-rev-rsi2", FilledQty: 12, FilledAvgPrice: &avg, FilledAt: &filledAt},
			{Symbol: "TSLA", Side: "buy", Status: "filled", ClientOrderID: "turtle-trend:u2",
				Strategy: "turtle-trend", FilledQty: 3, FilledAvgPrice: &avg, FilledAt: &filledAt},
		},
	}
	oc := NewOrderController(trading, nil, noopStorage{})

	router := gin.New()
	router.GET("/api/v1/fills/summary", oc.HandleFillsSummary)

	url := "/api/v1/fills/summary?strategy=mean-rev-rsi2&since=" + since.Format(time.RFC3339)
	req := httptest.NewRequest(http.MethodGet, url, nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status: want 200, got %d (body=%s)", w.Code, w.Body.String())
	}
	body := w.Body.String()
	if !strings.Contains(body, `"count":1`) {
		t.Errorf("want count 1 (only the mean-rev fill), got body=%s", body)
	}
	if !strings.Contains(body, `"symbol":"AAPL"`) || strings.Contains(body, "TSLA") {
		t.Errorf("want AAPL only, not TSLA; body=%s", body)
	}
}

func TestHandleFillsSummary_ListOrdersError(t *testing.T) {
	gin.SetMode(gin.TestMode)
	trading := &recordingTradingService{listOrdersErr: errors.New("alpaca down")}
	oc := NewOrderController(trading, nil, noopStorage{})

	router := gin.New()
	router.GET("/api/v1/fills/summary", oc.HandleFillsSummary)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/fills/summary?strategy=x", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("status: want 500 on ListOrders error, got %d", w.Code)
	}
}

// TestStartOfEtTradingDay pins midnight-ET semantics without hardcoding offsets.
func TestStartOfEtTradingDay(t *testing.T) {
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatalf("tzdata unavailable: %v", err)
	}
	now := time.Date(2026, 5, 26, 18, 30, 0, 0, time.UTC) // 14:30 ET (EDT)
	got := startOfEtTradingDay(now)
	et := got.In(loc)
	if et.Hour() != 0 || et.Minute() != 0 || et.Second() != 0 {
		t.Errorf("not midnight ET: %s", et)
	}
	if et.Year() != 2026 || et.Month() != time.May || et.Day() != 26 {
		t.Errorf("wrong ET date: %s, want 2026-05-26", et)
	}
}

