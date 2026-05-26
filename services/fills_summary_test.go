package services

import (
	"testing"
	"time"

	"prophet-trader/interfaces"
)

// ptrF returns a pointer to f — Order.FilledAvgPrice is *float64.
func ptrF(f float64) *float64 { return &f }

// mkOrder builds a minimal interfaces.Order for SummarizeFills tests.
func mkOrder(symbol, side, status, clientOrderID string, qty float64, avg *float64, filledAt *time.Time) *interfaces.Order {
	return &interfaces.Order{
		Symbol:         symbol,
		Side:           side,
		Status:         status,
		ClientOrderID:  clientOrderID,
		Strategy:       interfaces.ParseStrategyFromClientOrderID(clientOrderID),
		FilledQty:      qty,
		FilledAvgPrice: avg,
		FilledAt:       filledAt,
	}
}

func TestSummarizeFills(t *testing.T) {
	since := time.Date(2026, 5, 26, 4, 0, 0, 0, time.UTC) // ~midnight ET
	t0 := since.Add(6 * time.Hour)                        // 10:00 ET
	t1 := since.Add(7 * time.Hour)                        // 11:00 ET
	before := since.Add(-2 * time.Hour)                   // prior session

	orders := []*interfaces.Order{
		mkOrder("AAPL", "buy", "filled", "mean-rev-rsi2:u1", 12, ptrF(184.20), &t1),
		mkOrder("MSFT", "buy", "filled", "mean-rev-rsi2:u2", 8, ptrF(402.10), &t0),
		mkOrder("NKE", "sell", "filled", "mean-rev-rsi2:u3", 15, nil, &t0),       // nil avg → 0
		mkOrder("TSLA", "buy", "filled", "turtle-trend:u4", 3, ptrF(250.0), &t0), // other strategy
		mkOrder("GOOG", "buy", "canceled", "mean-rev-rsi2:u5", 5, nil, &t0),      // not filled
		mkOrder("AMZN", "buy", "filled", "mean-rev-rsi2:u6", 4, ptrF(180.0), &before), // before since
		mkOrder("META", "buy", "filled", "mean-rev-rsi2:u7", 2, ptrF(500.0), nil),     // nil FilledAt
		nil, // defensive: nil entry
	}

	got := SummarizeFills(orders, "mean-rev-rsi2", since)

	if got.Count != 3 {
		t.Fatalf("Count = %d, want 3 (AAPL, MSFT, NKE)", got.Count)
	}
	if got.Strategy != "mean-rev-rsi2" {
		t.Errorf("Strategy = %q, want mean-rev-rsi2", got.Strategy)
	}
	// Sorted ascending by FilledAt: MSFT(t0), NKE(t0), AAPL(t1). t0 ties keep input order.
	if got.Fills[len(got.Fills)-1].Symbol != "AAPL" {
		t.Errorf("last fill = %q, want AAPL (latest FilledAt)", got.Fills[len(got.Fills)-1].Symbol)
	}
	// NKE had nil avg price → 0.
	for _, f := range got.Fills {
		if f.Symbol == "NKE" && f.AvgPrice != 0 {
			t.Errorf("NKE AvgPrice = %v, want 0 (nil source)", f.AvgPrice)
		}
		if f.Symbol == "MSFT" && (f.Qty != 8 || f.AvgPrice != 402.10 || f.Side != "buy") {
			t.Errorf("MSFT mapped wrong: %+v", f)
		}
	}
}

func TestSummarizeFills_EmptyStrategyMatchesAll(t *testing.T) {
	since := time.Date(2026, 5, 26, 4, 0, 0, 0, time.UTC)
	at := since.Add(time.Hour)
	orders := []*interfaces.Order{
		mkOrder("AAPL", "buy", "filled", "mean-rev-rsi2:u1", 1, ptrF(1), &at),
		mkOrder("TSLA", "buy", "filled", "turtle-trend:u2", 1, ptrF(1), &at),
		mkOrder("BARE", "buy", "filled", "", 1, ptrF(1), &at), // untagged
	}
	got := SummarizeFills(orders, "", since)
	if got.Count != 3 {
		t.Fatalf("Count = %d, want 3 (empty strategy matches all filled)", got.Count)
	}
}
