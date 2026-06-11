package services

import (
	"math"
	"strconv"
	"testing"

	"prophet-trader/interfaces"
)

// almostEqual is the shared float comparison helper for the vertical tests.
func almostEqual(a, b, eps float64) bool { return math.Abs(a-b) <= eps }

func TestVerticalEconomics_CallDebit(t *testing.T) {
	// Long $240 call / short $260 call, $7 net debit. Width 20.
	maxLoss, maxGain, breakeven := verticalEconomics(CallDebit, 240, 260, 7)
	if !almostEqual(maxLoss, 700, 1e-9) {
		t.Fatalf("maxLoss = %v, want 700", maxLoss)
	}
	if !almostEqual(maxGain, 1300, 1e-9) { // (20 - 7) * 100
		t.Fatalf("maxGain = %v, want 1300", maxGain)
	}
	if !almostEqual(breakeven, 247, 1e-9) { // longStrike + debit
		t.Fatalf("breakeven = %v, want 247", breakeven)
	}
}

func TestVerticalEconomics_PutDebit(t *testing.T) {
	// Long $230 put / short $220 put, $3 net debit. Width 10.
	maxLoss, maxGain, breakeven := verticalEconomics(PutDebit, 230, 220, 3)
	if !almostEqual(maxLoss, 300, 1e-9) {
		t.Fatalf("maxLoss = %v, want 300", maxLoss)
	}
	if !almostEqual(maxGain, 700, 1e-9) { // (10 - 3) * 100
		t.Fatalf("maxGain = %v, want 700", maxGain)
	}
	if !almostEqual(breakeven, 227, 1e-9) { // longStrike - debit
		t.Fatalf("breakeven = %v, want 227", breakeven)
	}
}

func chainFixture() map[string]*interfaces.OptionContract {
	// Strikes 220..260 step 5, both calls and puts.
	m := map[string]*interfaces.OptionContract{}
	for k := 220.0; k <= 260; k += 5 {
		for _, typ := range []string{"call", "put"} {
			sym := typ + "-" + strconvFloat(k)
			m[sym] = &interfaces.OptionContract{Symbol: sym, ContractType: typ, StrikePrice: k}
		}
	}
	return m
}

// strconvFloat keeps the fixture key unique without pulling fmt into asserts.
func strconvFloat(f float64) string { return strconv.FormatFloat(f, 'f', 0, 64) }

func TestPickVerticalStrikes_CallDebit_SnapsAndOrders(t *testing.T) {
	chain := chainFixture()
	long, short, ok := pickVerticalStrikes(chain, CallDebit, 241, 18)
	if !ok {
		t.Fatal("expected ok=true")
	}
	if long.StrikePrice != 240 {
		t.Fatalf("long strike = %v, want 240", long.StrikePrice)
	}
	if short.StrikePrice != 260 {
		t.Fatalf("short strike = %v, want 260", short.StrikePrice)
	}
	if short.StrikePrice <= long.StrikePrice {
		t.Fatal("call-debit short must be strictly above long")
	}
}

func TestPickVerticalStrikes_PutDebit_SnapsBelow(t *testing.T) {
	chain := chainFixture()
	long, short, ok := pickVerticalStrikes(chain, PutDebit, 231, 12)
	if !ok {
		t.Fatal("expected ok=true")
	}
	if long.StrikePrice != 230 {
		t.Fatalf("long strike = %v, want 230", long.StrikePrice)
	}
	if short.StrikePrice != 220 {
		t.Fatalf("short strike = %v, want 220", short.StrikePrice)
	}
}

func TestPickVerticalStrikes_Degenerate_NotOK(t *testing.T) {
	chain := map[string]*interfaces.OptionContract{
		"c1": {Symbol: "c1", ContractType: "call", StrikePrice: 240},
	}
	if _, _, ok := pickVerticalStrikes(chain, CallDebit, 240, 20); ok {
		t.Fatal("expected ok=false for a degenerate single-strike chain")
	}
	if _, _, ok := pickVerticalStrikes(chainFixture(), CallDebit, 240, 0); ok {
		t.Fatal("expected ok=false for non-positive width")
	}
}
