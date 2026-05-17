package services

import (
	"math"
	"testing"

	"prophet-trader/models"
)

// ---- evaluateEntry ----

func TestEvaluateEntry_AllConditionsHold(t *testing.T) {
	sig := &TrendSignal{
		Ticker: "TLT", LastClose: 95.00, Donchian100High: 92.00,
		SMA200: 90.00, ATR20: 1.50, BarsCount: 300,
	}
	res := evaluateEntry(sig, false)
	if !res.Eligible {
		t.Errorf("expected eligible, got reason=%q", res.Reason)
	}
}

func TestEvaluateEntry_NilSignalIneligible(t *testing.T) {
	res := evaluateEntry(nil, false)
	if res.Eligible {
		t.Errorf("nil signal must not be eligible")
	}
}

func TestEvaluateEntry_FailsOnLowBarsCount(t *testing.T) {
	sig := &TrendSignal{LastClose: 95.0, Donchian100High: 92.0, SMA200: 90.0, ATR20: 1.50, BarsCount: 249}
	res := evaluateEntry(sig, false)
	if res.Eligible {
		t.Errorf("expected ineligible (insufficient bars), got eligible")
	}
}

func TestEvaluateEntry_FailsOnNotAboveDonchian(t *testing.T) {
	sig := &TrendSignal{LastClose: 91.50, Donchian100High: 92.00, SMA200: 90.00, ATR20: 1.50, BarsCount: 300}
	res := evaluateEntry(sig, false)
	if res.Eligible || res.Reason == "" {
		t.Errorf("expected ineligible, got %+v", res)
	}
}

func TestEvaluateEntry_FailsOnBelowSMA200(t *testing.T) {
	sig := &TrendSignal{LastClose: 93.00, Donchian100High: 92.00, SMA200: 94.00, ATR20: 1.50, BarsCount: 300}
	res := evaluateEntry(sig, false)
	if res.Eligible {
		t.Errorf("expected ineligible (below sma200), got eligible")
	}
}

func TestEvaluateEntry_FailsOnFlatATR(t *testing.T) {
	// ATR/close = 0.30/100 = 0.003 < 0.005
	sig := &TrendSignal{LastClose: 100.00, Donchian100High: 99.00, SMA200: 95.00, ATR20: 0.30, BarsCount: 300}
	res := evaluateEntry(sig, false)
	if res.Eligible {
		t.Errorf("expected ineligible (ATR floor), got eligible")
	}
}

func TestEvaluateEntry_FailsOnZeroLastClose(t *testing.T) {
	sig := &TrendSignal{LastClose: 0.0, Donchian100High: 92.0, SMA200: 90.0, ATR20: 1.50, BarsCount: 300}
	res := evaluateEntry(sig, false)
	if res.Eligible {
		t.Errorf("zero last_close must not be eligible (avoid division by zero)")
	}
}

func TestEvaluateEntry_ColdStartProximityFilter(t *testing.T) {
	// Far above breakout: 100 close, 92 high → distance 8, ATR 1.5 → reject
	sig := &TrendSignal{LastClose: 100.00, Donchian100High: 92.00, SMA200: 90.00, ATR20: 1.50, BarsCount: 300}
	res := evaluateEntry(sig, true)
	if res.Eligible {
		t.Errorf("expected cold-start ineligibility (too far above breakout), got eligible")
	}
	// Within ATR of breakout: 92.5 close, 92 high → distance 0.5, ATR 1.5 → eligible
	sig.LastClose = 92.50
	res = evaluateEntry(sig, true)
	if !res.Eligible {
		t.Errorf("expected cold-start eligibility within ATR proximity, got %q", res.Reason)
	}
}

func TestEvaluateEntry_ColdStartHasNoEffectWhenColdStartFalse(t *testing.T) {
	// Same far-above-breakout config as above; coldStart=false should pass all other checks.
	sig := &TrendSignal{LastClose: 100.00, Donchian100High: 92.00, SMA200: 90.00, ATR20: 1.50, BarsCount: 300}
	res := evaluateEntry(sig, false)
	if !res.Eligible {
		t.Errorf("once coldStart completes, far-above-breakout entries are eligible (got reason=%q)", res.Reason)
	}
}

// ---- evaluateExit ----

func mkLedgerOpen(ticker string, entryPx float64, shares int, atr float64) *models.DBTrendLedgerEntry {
	return &models.DBTrendLedgerEntry{
		Ticker: ticker, EntryPrice: entryPx, Shares: shares, ATRAtEntry: atr,
		Status: "open",
	}
}

func TestEvaluateExit_TrailingStopFires(t *testing.T) {
	sig := &TrendSignal{Donchian50Low: 91.00}
	entry := mkLedgerOpen("TLT", 95.0, 100, 1.5)
	got := evaluateExit(entry, sig, 90.50, 5)
	if got.Reason != "trailing_stop" {
		t.Errorf("expected trailing_stop, got %q", got.Reason)
	}
}

func TestEvaluateExit_InitialHardStopFiresWithin20Days(t *testing.T) {
	sig := &TrendSignal{Donchian50Low: 80.00}
	entry := mkLedgerOpen("TLT", 95.0, 100, 1.5)
	entry.InitialStop = 95.0 - 2*1.5 // 92.0
	got := evaluateExit(entry, sig, 91.50, 10)
	if got.Reason != "initial_hard_stop" {
		t.Errorf("expected initial_hard_stop, got %q", got.Reason)
	}
}

func TestEvaluateExit_HardStopActiveOnBoundaryDay20(t *testing.T) {
	// Boundary check: days_since_entry == 20 is still active.
	sig := &TrendSignal{Donchian50Low: 80.00}
	entry := mkLedgerOpen("TLT", 95.0, 100, 1.5)
	entry.InitialStop = 92.0
	got := evaluateExit(entry, sig, 91.50, 20)
	if got.Reason != "initial_hard_stop" {
		t.Errorf("day 20 hard stop must still fire, got %q", got.Reason)
	}
}

func TestEvaluateExit_HardStopInactivePast20Days(t *testing.T) {
	sig := &TrendSignal{Donchian50Low: 80.00}
	entry := mkLedgerOpen("TLT", 95.0, 100, 1.5)
	entry.InitialStop = 92.0
	got := evaluateExit(entry, sig, 91.50, 21)
	if got.Reason == "initial_hard_stop" {
		t.Errorf("hard stop should not fire past 20 days, got %q", got.Reason)
	}
}

func TestEvaluateExit_NoExitWhenAboveAllStops(t *testing.T) {
	sig := &TrendSignal{Donchian50Low: 91.00}
	entry := mkLedgerOpen("TLT", 95.0, 100, 1.5)
	entry.InitialStop = 92.0
	got := evaluateExit(entry, sig, 96.0, 10)
	if got.Reason != "" {
		t.Errorf("expected no exit, got %q", got.Reason)
	}
}

func TestEvaluateExit_NilEntryHolds(t *testing.T) {
	if got := evaluateExit(nil, &TrendSignal{Donchian50Low: 100}, 50, 5); got.Reason != "" {
		t.Errorf("nil entry must produce no exit, got %q", got.Reason)
	}
}

func TestEvaluateExit_NilSigHolds(t *testing.T) {
	entry := mkLedgerOpen("TLT", 95.0, 100, 1.5)
	if got := evaluateExit(entry, nil, 50, 5); got.Reason != "" {
		t.Errorf("nil sig must produce no exit, got %q", got.Reason)
	}
}

func TestEvaluateExit_TrailingTakesPriorityOverHardStop(t *testing.T) {
	// Both rules trigger; the function should return the first one (trailing).
	// Today's open is below both donchian_50_low (91) AND initial_stop (92).
	sig := &TrendSignal{Donchian50Low: 91.00}
	entry := mkLedgerOpen("TLT", 95.0, 100, 1.5)
	entry.InitialStop = 92.0
	got := evaluateExit(entry, sig, 90.50, 5)
	if got.Reason != "trailing_stop" {
		t.Errorf("when both fire, trailing_stop wins (it's the always-active rule); got %q", got.Reason)
	}
}

// ---- computePositionDollars ----

func TestComputePositionDollars_ATRSizingHitsRiskTarget(t *testing.T) {
	// portfolio=$100k, risk 0.5% = $500
	// ATR=$10, lastClose=$100 → stopDistance=$20 → dollars = $500 / ($20/$100) = $2,500
	// (must use high-vol ATR so raw stays under the 4% / $4,000 hard cap
	// from TRADING_RULES_TREND.md line 253; otherwise the test would
	// observe the cap clip rather than the risk-budget formula)
	dollars := computePositionDollars(100_000, 100.0, 10.0, 1.0)
	if dollars < 2_400 || dollars > 2_600 {
		t.Errorf("got $%.2f, want roughly $2,500", dollars)
	}
}

func TestComputePositionDollars_CapsAt4PctOfPortfolio(t *testing.T) {
	// ATR=$0.50, lastClose=$100 → stopDistance=$1 → uncapped = $50,000 (50%)
	// Cap = 4% → $4000
	dollars := computePositionDollars(100_000, 100.0, 0.50, 1.0)
	if dollars > 4_000+1 {
		t.Errorf("expected cap at $4000, got $%.2f", dollars)
	}
}

func TestComputePositionDollars_AppliesSizingMultiplier(t *testing.T) {
	// Use high-vol ATR so we observe pure multiplier scaling without the
	// 4% notional cap clipping both calls to the same ceiling value.
	full := computePositionDollars(100_000, 100.0, 10.0, 1.0)
	half := computePositionDollars(100_000, 100.0, 10.0, 0.5)
	if math.Abs(half-full*0.5) > 1.0 {
		t.Errorf("multiplier not applied: full=%.2f half=%.2f", full, half)
	}
}

func TestComputePositionDollars_ReturnsZeroOnBadInput(t *testing.T) {
	cases := []struct {
		name                                string
		portfolio, lastClose, atr20, sizing float64
	}{
		{"zero portfolio", 0, 100, 1.5, 1.0},
		{"negative portfolio", -100, 100, 1.5, 1.0},
		{"zero lastClose", 100_000, 0, 1.5, 1.0},
		{"zero atr", 100_000, 100, 0, 1.0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := computePositionDollars(tc.portfolio, tc.lastClose, tc.atr20, tc.sizing)
			if got != 0 {
				t.Errorf("expected 0 for %s, got %.2f", tc.name, got)
			}
		})
	}
}

func TestComputePositionDollars_RegimeGateZeroMultiplierGivesZero(t *testing.T) {
	// Regime RED tier sets multiplier=0.0; entry should size to zero.
	got := computePositionDollars(100_000, 100.0, 1.50, 0.0)
	if got != 0 {
		t.Errorf("zero sizingMultiplier must produce $0, got %.2f", got)
	}
}
