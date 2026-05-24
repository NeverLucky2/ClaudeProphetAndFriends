package services

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"prophet-trader/interfaces"
	"strings"
	"testing"
	"time"

	"github.com/alpacahq/alpaca-trade-api-go/v3/alpaca"
	"github.com/sirupsen/logrus"
)

// newTestAlpacaService builds an AlpacaTradingService without touching the
// network. The broker seam is left for the caller to wire to a fake.
func newTestAlpacaService() *AlpacaTradingService {
	logger := logrus.New()
	logger.SetOutput(io.Discard)
	return &AlpacaTradingService{logger: logger}
}

// End-to-end regression for the 2026-05-19 USO incident — verifies the
// defensive snap at the Alpaca boundary actually reaches the broker request.
// The Turtle executor already rounds, but if any future caller submits an
// unrounded price this layer catches it.
func TestPlaceOrder_SnapsSubPennyLimitPriceBeforeBrokerCall(t *testing.T) {
	var capturedReq alpaca.PlaceOrderRequest
	svc := newTestAlpacaService()
	svc.brokerPlaceOrder = func(req alpaca.PlaceOrderRequest) (*alpaca.Order, error) {
		capturedReq = req
		return &alpaca.Order{ID: "order-1", ClientOrderID: req.ClientOrderID}, nil
	}

	limit := 153.7248 // the literal USO value Alpaca rejected
	order := &interfaces.Order{
		Symbol:      "USO",
		Qty:         10,
		Side:        "buy",
		Type:        "limit",
		TimeInForce: "day",
		LimitPrice:  &limit,
	}

	if _, err := svc.PlaceOrder(context.Background(), order); err != nil {
		t.Fatalf("PlaceOrder: %v", err)
	}
	if capturedReq.LimitPrice == nil {
		t.Fatal("broker request must carry LimitPrice")
	}
	got := capturedReq.LimitPrice.InexactFloat64()
	if got != 153.72 {
		t.Errorf("broker received limit_price %v, want 153.72 (snapped)", got)
	}
	if *order.LimitPrice != 153.72 {
		t.Errorf("input order.LimitPrice not updated: got %v, want 153.72", *order.LimitPrice)
	}
}

func TestIsTransientBrokerError(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"nil is not transient", nil, false},
		{"HTTP 500 is transient", fmt.Errorf("server error (HTTP 500)"), true},
		{"HTTP 502 is transient", fmt.Errorf("bad gateway (HTTP 502)"), true},
		{"HTTP 503 is transient", fmt.Errorf("service unavailable (HTTP 503)"), true},
		{"HTTP 429 rate limit is transient", fmt.Errorf("rate limited (HTTP 429)"), true},
		{"HTTP 422 validation is NOT transient", fmt.Errorf("invalid limit_price (HTTP 422, Code 42210000)"), false},
		{"HTTP 401 auth is NOT transient", fmt.Errorf("unauthorized (HTTP 401)"), false},
		{"HTTP 400 is NOT transient", fmt.Errorf("bad request (HTTP 400)"), false},
		{"i/o timeout is transient", fmt.Errorf("dial tcp: i/o timeout"), true},
		{"connection reset is transient", fmt.Errorf("read tcp: connection reset by peer"), true},
		{"EOF is transient", fmt.Errorf("unexpected EOF"), true},
		{"unknown error is NOT transient", fmt.Errorf("something weird happened"), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isTransientBrokerError(tc.err); got != tc.want {
				t.Errorf("got %v, want %v for err=%v", got, tc.want, tc.err)
			}
		})
	}
}

func TestPlaceOrder_RetriesOnTransientError(t *testing.T) {
	attempts := 0
	svc := newTestAlpacaService()
	svc.retryBackoff = 0
	svc.brokerPlaceOrder = func(req alpaca.PlaceOrderRequest) (*alpaca.Order, error) {
		attempts++
		if attempts == 1 {
			return nil, fmt.Errorf("service unavailable (HTTP 503)")
		}
		return &alpaca.Order{ID: "order-retry", ClientOrderID: req.ClientOrderID}, nil
	}

	order := &interfaces.Order{
		Symbol: "AAPL", Qty: 1, Side: "buy", Type: "market", TimeInForce: "day",
	}
	res, err := svc.PlaceOrder(context.Background(), order)
	if err != nil {
		t.Fatalf("PlaceOrder: %v", err)
	}
	if attempts != 2 {
		t.Errorf("attempts: got %d, want 2 (one retry after transient)", attempts)
	}
	if res.OrderID != "order-retry" {
		t.Errorf("OrderID: got %q, want order-retry", res.OrderID)
	}
}

func TestPlaceOrder_DoesNotRetryValidationError(t *testing.T) {
	attempts := 0
	svc := newTestAlpacaService()
	svc.retryBackoff = 0
	svc.brokerPlaceOrder = func(req alpaca.PlaceOrderRequest) (*alpaca.Order, error) {
		attempts++
		return nil, fmt.Errorf("invalid limit_price (HTTP 422, Code 42210000)")
	}

	order := &interfaces.Order{
		Symbol: "USO", Qty: 1, Side: "buy", Type: "market", TimeInForce: "day",
	}
	_, err := svc.PlaceOrder(context.Background(), order)
	if err == nil {
		t.Fatal("PlaceOrder must fail")
	}
	if attempts != 1 {
		t.Errorf("attempts: got %d, want 1 (no retry on 422)", attempts)
	}
}

func TestSnapToTradablePrice(t *testing.T) {
	cases := []struct {
		name        string
		input       float64
		wantOut     float64
		wantChanged bool
	}{
		{"USO-style sub-penny above $1 rounds to cent", 153.7248, 153.72, true},
		{"clean cent value above $1 unchanged", 153.72, 153.72, false},
		{"high-priced sub-penny rounds", 1234.5678, 1234.57, true},
		{"valid 4-decimal sub-dollar unchanged", 0.1234, 0.1234, false},
		{"5-decimal sub-dollar rounds to 4dp", 0.12349, 0.1235, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, changed := snapToTradablePrice(tc.input)
			if math.Abs(got-tc.wantOut) > 1e-9 {
				t.Errorf("price: got %v, want %v", got, tc.wantOut)
			}
			if changed != tc.wantChanged {
				t.Errorf("changed: got %v, want %v", changed, tc.wantChanged)
			}
		})
	}
}

func TestResolveOptionsClientOrderID(t *testing.T) {
	cases := []struct {
		name          string
		caller        string
		strategy      string
		wantExact     string // when non-empty, result must equal this
		wantGenerated bool   // when true, result must be non-empty and start with strategy+":"
	}{
		{name: "caller-supplied wins", caller: "v2-options-stop:SPY:123", strategy: "v2-options", wantExact: "v2-options-stop:SPY:123"},
		{name: "generated from strategy", caller: "", strategy: "v2-options", wantGenerated: true},
		{name: "empty when neither", caller: "", strategy: "", wantExact: ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := resolveOptionsClientOrderID(tc.caller, tc.strategy)
			if tc.wantGenerated {
				if !strings.HasPrefix(got, tc.strategy+":") {
					t.Fatalf("got %q, want generated %q-prefixed id", got, tc.strategy+":")
				}
			} else {
				if got != tc.wantExact {
					t.Fatalf("got %q, want %q", got, tc.wantExact)
				}
			}
		})
	}
}

func TestGetOptionsChain_RetriesOnRateLimit(t *testing.T) {
	attempts := 0
	svc := newTestAlpacaService()
	svc.optionsRetryBackoff = 0 // no real sleeping in tests
	svc.fetchChainOnce = func(ctx context.Context, underlying string, exp time.Time) ([]*interfaces.OptionContract, error) {
		attempts++
		if attempts == 1 {
			return nil, &RateLimitedError{RetryAfter: 0, Body: "too many requests"}
		}
		return []*interfaces.OptionContract{{Symbol: "SPY_C"}}, nil
	}

	got, err := svc.GetOptionsChain(context.Background(), "SPY", time.Now())
	if err != nil {
		t.Fatalf("GetOptionsChain: %v", err)
	}
	if attempts != 2 {
		t.Errorf("attempts: got %d, want 2 (one retry after 429)", attempts)
	}
	if len(got) != 1 || got[0].Symbol != "SPY_C" {
		t.Errorf("expected the recovered chain, got %#v", got)
	}
}

func TestGetOptionsChain_DoesNotRetryNonTransient(t *testing.T) {
	attempts := 0
	svc := newTestAlpacaService()
	svc.optionsRetryBackoff = 0
	svc.fetchChainOnce = func(ctx context.Context, underlying string, exp time.Time) ([]*interfaces.OptionContract, error) {
		attempts++
		return nil, fmt.Errorf("options chain API error (HTTP 422): bad params")
	}

	_, err := svc.GetOptionsChain(context.Background(), "SPY", time.Now())
	if err == nil {
		t.Fatal("expected error")
	}
	if attempts != 1 {
		t.Errorf("attempts: got %d, want 1 (4xx must not retry)", attempts)
	}
}

func TestGetOptionsChain_StopsAfterMaxRetries(t *testing.T) {
	attempts := 0
	svc := newTestAlpacaService()
	svc.optionsRetryBackoff = 0
	svc.fetchChainOnce = func(ctx context.Context, underlying string, exp time.Time) ([]*interfaces.OptionContract, error) {
		attempts++
		return nil, &RateLimitedError{RetryAfter: 0, Body: "still throttled"}
	}

	_, err := svc.GetOptionsChain(context.Background(), "SPY", time.Now())
	var rle *RateLimitedError
	if !errors.As(err, &rle) {
		t.Fatalf("final error must remain a RateLimitedError, got %v", err)
	}
	if attempts != 3 {
		t.Errorf("attempts: got %d, want 3 (1 initial + 2 retries)", attempts)
	}
}

func TestGetOptionsChain_AcquiresBeforeFetch(t *testing.T) {
	sentinel := errors.New("limiter blocked")
	called := false
	svc := newTestAlpacaService()
	svc.limiter = &fakeLimiter{err: sentinel}
	svc.fetchChainOnce = func(ctx context.Context, underlying string, exp time.Time) ([]*interfaces.OptionContract, error) {
		called = true
		return nil, nil
	}

	_, err := svc.GetOptionsChain(context.Background(), "SPY", time.Now())
	if !errors.Is(err, sentinel) {
		t.Errorf("must short-circuit on limiter error, got %v", err)
	}
	if called {
		t.Error("fetch must not run when the limiter blocks")
	}
}

func TestChainRetryBackoff(t *testing.T) {
	base := 250 * time.Millisecond
	if got := chainRetryBackoff(1, base, nil); got != 250*time.Millisecond {
		t.Errorf("attempt 1: got %v, want 250ms", got)
	}
	if got := chainRetryBackoff(2, base, nil); got != 500*time.Millisecond {
		t.Errorf("attempt 2: got %v, want 500ms", got)
	}
	// Retry-After under the cap is honored verbatim.
	if got := chainRetryBackoff(1, base, &RateLimitedError{RetryAfter: 1 * time.Second}); got != 1*time.Second {
		t.Errorf("retry-after 1s: got %v, want 1s", got)
	}
	// Retry-After over the 2s cap is clamped.
	if got := chainRetryBackoff(1, base, &RateLimitedError{RetryAfter: 9 * time.Second}); got != 2*time.Second {
		t.Errorf("retry-after 9s: got %v, want 2s (capped)", got)
	}
}

func TestOptionsQuoteFromSnapshot(t *testing.T) {
	ts := time.Date(2026, 5, 24, 14, 30, 0, 0, time.UTC)
	snap := AlpacaOptionsSnapshot{Snapshots: map[string]AlpacaOptionContract{
		"NVDA251219C00400000": {
			LatestQuote: AlpacaQuote{Timestamp: ts, BidPrice: 5.00, AskPrice: 5.20, BidSize: 10, AskSize: 12},
			LatestTrade: AlpacaTrade{Price: 5.10},
		},
	}}
	q, err := optionsQuoteFromSnapshot(snap, "NVDA251219C00400000")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if q.BidPrice != 5.00 || q.AskPrice != 5.20 || q.LastPrice != 5.10 {
		t.Errorf("bad price mapping: %+v", q)
	}
	if !q.Timestamp.Equal(ts) {
		t.Errorf("timestamp must be preserved for staleness checks, got %v", q.Timestamp)
	}
	if _, err := optionsQuoteFromSnapshot(AlpacaOptionsSnapshot{Snapshots: map[string]AlpacaOptionContract{}}, "MISSING"); err == nil {
		t.Error("missing symbol in snapshot should error")
	}
}
