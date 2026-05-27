package services

import (
	"strings"
	"testing"
)

// Managed positions are equity-only: sizing assumes 1 unit = 1 share (no ×100
// options multiplier), entries go through the stock order path, and the stock
// quote endpoint 400s on OCC symbols. An OCC option symbol must be rejected up
// front — reproducing Prophet's 2026-05-27 QQQ260717C00728000 attempt, which
// otherwise failed cryptically deep in the price fetch (and would have oversized
// ~100x if the quote had succeeded).
func TestValidateRequest_RejectsOptionSymbol(t *testing.T) {
	pm := &PositionManager{}
	stop, target := 10.0, 20.0
	req := &PlaceManagedPositionRequest{
		Symbol:            "QQQ260717C00728000",
		Side:              "buy",
		AllocationDollars: 9892,
		StopLossPercent:   &stop,
		TakeProfitPercent: &target,
	}
	err := pm.validateRequest(req)
	if err == nil {
		t.Fatal("expected an error rejecting the option symbol, got nil")
	}
	if !strings.Contains(err.Error(), "place_options_order") {
		t.Errorf("error should point to place_options_order, got: %v", err)
	}
}

func TestValidateRequest_AllowsStockSymbol(t *testing.T) {
	pm := &PositionManager{}
	stop, target := 10.0, 20.0
	req := &PlaceManagedPositionRequest{
		Symbol:            "QQQ",
		Side:              "buy",
		AllocationDollars: 9892,
		StopLossPercent:   &stop,
		TakeProfitPercent: &target,
	}
	if err := pm.validateRequest(req); err != nil {
		t.Errorf("a stock symbol must validate, got error: %v", err)
	}
}
