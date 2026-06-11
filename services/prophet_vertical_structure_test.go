package services

import (
	"math"
	"testing"
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
