package services

import (
	"context"
	"testing"
	"time"

	"prophet-trader/interfaces"
)

// almostEqual is already defined in prophet_vertical_structure_test.go (same package) — do NOT redefine it.

func TestAttributeSingleLegPnl_PureIVCrush(t *testing.T) {
	// Long call; spot & time held flat, only vol drops. All modeled P&L → IV.
	entry := SingleLegSnapshot{Spot: 100, Vol: 0.40, TimeToExpiry: 0.10}
	exit := SingleLegSnapshot{Spot: 100, Vol: 0.20, TimeToExpiry: 0.10}
	// Modeled total = (bs(exit) - bs(entry)) * 100. Pass that exact value as
	// realizedPnL so Residual is ~0 and IV carries the whole move.
	modeled := (bsPrice("call", 100, 100, 0.10, 0.20, 0) - bsPrice("call", 100, 100, 0.10, 0.40, 0)) * 100
	a := attributeSingleLegPnl("call", true, 100, entry, exit, modeled, 1)
	if !almostEqual(a.Theta, 0, 1e-9) {
		t.Fatalf("theta = %v, want 0 (time flat)", a.Theta)
	}
	if !almostEqual(a.Direction, 0, 1e-9) {
		t.Fatalf("direction = %v, want 0 (spot flat)", a.Direction)
	}
	if a.IV >= 0 {
		t.Fatalf("IV = %v, want negative (vol fell on a long option)", a.IV)
	}
	if !almostEqual(a.Residual, 0, 1e-6) {
		t.Fatalf("residual = %v, want ~0", a.Residual)
	}
}

func TestAttributeSingleLegPnl_PureDirection(t *testing.T) {
	// Long call; vol & time flat, spot rises → all modeled P&L → Direction (>0).
	entry := SingleLegSnapshot{Spot: 100, Vol: 0.30, TimeToExpiry: 0.10}
	exit := SingleLegSnapshot{Spot: 110, Vol: 0.30, TimeToExpiry: 0.10}
	modeled := (bsPrice("call", 110, 100, 0.10, 0.30, 0) - bsPrice("call", 100, 100, 0.10, 0.30, 0)) * 100
	a := attributeSingleLegPnl("call", true, 100, entry, exit, modeled, 1)
	if a.Direction <= 0 {
		t.Fatalf("direction = %v, want positive", a.Direction)
	}
	if !almostEqual(a.Theta, 0, 1e-9) || !almostEqual(a.IV, 0, 1e-9) {
		t.Fatalf("theta=%v iv=%v, want both 0", a.Theta, a.IV)
	}
}

func TestAttributeSingleLegPnl_ThetaDecayLongOption(t *testing.T) {
	// Long call; spot & vol flat, time decays → Theta < 0 (long option bleeds).
	entry := SingleLegSnapshot{Spot: 100, Vol: 0.30, TimeToExpiry: 0.10}
	exit := SingleLegSnapshot{Spot: 100, Vol: 0.30, TimeToExpiry: 0.02}
	a := attributeSingleLegPnl("call", true, 100, entry, exit, 0, 1)
	if a.Theta >= 0 {
		t.Fatalf("theta = %v, want negative (time decay on a long option)", a.Theta)
	}
}

func TestAttributeSingleLegPnl_ResidualReconciles(t *testing.T) {
	// Residual makes the four components sum to the realized P&L exactly.
	entry := SingleLegSnapshot{Spot: 100, Vol: 0.35, TimeToExpiry: 0.10}
	exit := SingleLegSnapshot{Spot: 104, Vol: 0.28, TimeToExpiry: 0.05}
	const realized = 137.0
	a := attributeSingleLegPnl("call", true, 100, entry, exit, realized, 2)
	if !almostEqual(a.Direction+a.Theta+a.IV+a.Residual, realized, 1e-9) {
		t.Fatalf("components sum = %v, want %v", a.Direction+a.Theta+a.IV+a.Residual, realized)
	}
}

func TestAttributeSingleLegPnl_LongPutDirection(t *testing.T) {
	// Long put; spot falls → Direction > 0 (a long put gains as spot drops).
	entry := SingleLegSnapshot{Spot: 100, Vol: 0.30, TimeToExpiry: 0.10}
	exit := SingleLegSnapshot{Spot: 92, Vol: 0.30, TimeToExpiry: 0.10}
	modeled := (bsPrice("put", 92, 100, 0.10, 0.30, 0) - bsPrice("put", 100, 100, 0.10, 0.30, 0)) * 100
	a := attributeSingleLegPnl("put", true, 100, entry, exit, modeled, 1)
	if a.Direction <= 0 {
		t.Fatalf("direction = %v, want positive (long put, spot fell)", a.Direction)
	}
}

type fakeSingleLegBarFetcher struct {
	bar *interfaces.Bar
	err error
}

func (f *fakeSingleLegBarFetcher) GetLatestBar(_ context.Context, _ string) (*interfaces.Bar, error) {
	return f.bar, f.err
}

type fakeSingleLegChainFetcher struct {
	chain []*interfaces.OptionContract
	err   error
}

func (f *fakeSingleLegChainFetcher) GetOptionsChain(_ context.Context, _ string, _ time.Time) ([]*interfaces.OptionContract, error) {
	return f.chain, f.err
}

func TestSingleLegSnapshotNow_HappyPath(t *testing.T) {
	now := time.Date(2026, 6, 22, 15, 0, 0, 0, time.UTC)
	sym := "QQQ260918C00400000" // expiry 2026-09-18, call, strike 400
	bars := &fakeSingleLegBarFetcher{bar: &interfaces.Bar{Close: 405}}
	chains := &fakeSingleLegChainFetcher{chain: []*interfaces.OptionContract{
		{Symbol: sym, Bid: 12.0, Ask: 12.4, ImpliedVolatility: 0.22},
	}}
	snap, mark, ok := singleLegSnapshotNow(context.Background(), bars, chains, sym, now)
	if !ok {
		t.Fatal("ok=false, want true")
	}
	if !almostEqual(snap.Spot, 405, 1e-9) {
		t.Fatalf("spot = %v, want 405", snap.Spot)
	}
	if !almostEqual(snap.Vol, 0.22, 1e-9) {
		t.Fatalf("vol = %v, want 0.22", snap.Vol)
	}
	if !almostEqual(mark, 12.2, 1e-9) { // (12.0+12.4)/2
		t.Fatalf("mark = %v, want 12.2", mark)
	}
	if snap.TimeToExpiry <= 0 {
		t.Fatalf("tte = %v, want > 0", snap.TimeToExpiry)
	}
}

func TestSingleLegSnapshotNow_NotAnOption(t *testing.T) {
	now := time.Date(2026, 6, 22, 15, 0, 0, 0, time.UTC)
	if _, _, ok := singleLegSnapshotNow(context.Background(), &fakeSingleLegBarFetcher{}, &fakeSingleLegChainFetcher{}, "QQQ", now); ok {
		t.Fatal("ok=true for a bare equity ticker, want false")
	}
}

func TestSingleLegSnapshotNow_SpotUnavailable(t *testing.T) {
	now := time.Date(2026, 6, 22, 15, 0, 0, 0, time.UTC)
	sym := "QQQ260918C00400000"
	if _, _, ok := singleLegSnapshotNow(context.Background(), &fakeSingleLegBarFetcher{bar: &interfaces.Bar{Close: 0}}, &fakeSingleLegChainFetcher{}, sym, now); ok {
		t.Fatal("ok=true with no spot, want false")
	}
}

func TestSingleLegSnapshotNow_DegradedOptionFeed(t *testing.T) {
	// Spot present but the chain has no quotes → ok=true, but vol/mark are 0.
	now := time.Date(2026, 6, 22, 15, 0, 0, 0, time.UTC)
	sym := "QQQ260918C00400000"
	snap, mark, ok := singleLegSnapshotNow(context.Background(), &fakeSingleLegBarFetcher{bar: &interfaces.Bar{Close: 405}}, &fakeSingleLegChainFetcher{chain: []*interfaces.OptionContract{{Symbol: sym, Bid: 0, Ask: 0}}}, sym, now)
	if !ok {
		t.Fatal("ok=false, want true (spot present)")
	}
	if snap.Vol != 0 || mark != 0 {
		t.Fatalf("vol=%v mark=%v, want both 0 on degraded feed", snap.Vol, mark)
	}
}
