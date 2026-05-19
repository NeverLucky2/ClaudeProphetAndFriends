package services

import (
	"context"
	"fmt"
	"io"
	"math"
	"prophet-trader/interfaces"
	"testing"

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
