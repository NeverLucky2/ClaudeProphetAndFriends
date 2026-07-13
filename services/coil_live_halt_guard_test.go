package services

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"prophet-trader/interfaces"
	"testing"
)

type fakeHaltReader struct {
	equity float64
	err    error
}

func (f *fakeHaltReader) GetAccount(_ context.Context) (*interfaces.Account, error) {
	if f.err != nil {
		return nil, f.err
	}
	return &interfaces.Account{PortfolioValue: f.equity}, nil
}

func newTestHalt(t *testing.T, equity float64, baseline float64) (*CoilLiveHaltGuard, string) {
	t.Helper()
	dir := t.TempDir()
	g := NewCoilLiveHaltGuard(CoilLiveHaltConfig{
		Enabled:     true,
		DrawdownPct: 0.15,
		BaselineUSD: baseline,
		StateDir:    dir,
	}, &fakeHaltReader{equity: equity})
	return g, dir
}

func TestHalt_DisabledIsNoOp(t *testing.T) {
	g := NewCoilLiveHaltGuard(CoilLiveHaltConfig{Enabled: false}, &fakeHaltReader{equity: 1})
	if err := g.EvaluateEntry(context.Background()); err != nil {
		t.Fatalf("disabled guard must allow, got %v", err)
	}
}

func TestHalt_AllowsAboveThreshold(t *testing.T) {
	// Baseline 5000, equity 4300 => 14% drawdown, just inside the 15% limit.
	g, _ := newTestHalt(t, 4300, 5000)
	if err := g.EvaluateEntry(context.Background()); err != nil {
		t.Fatalf("14%% drawdown must be allowed, got %v", err)
	}
}

func TestHalt_BlocksAtThreshold(t *testing.T) {
	// Baseline 5000, equity 4250 => exactly -15%.
	g, dir := newTestHalt(t, 4250, 5000)
	if err := g.EvaluateEntry(context.Background()); err == nil {
		t.Fatal("-15% drawdown must block, got nil")
	}
	if _, err := os.Stat(filepath.Join(dir, coilHaltLatchFileName)); err != nil {
		t.Fatalf("crossing the threshold must write the latch file: %v", err)
	}
}

// The mark ratchets UP with equity and never down — a drawdown is measured from
// the peak, not from the funded baseline.
func TestHalt_HighWaterRatchetsUp(t *testing.T) {
	dir := t.TempDir()
	reader := &fakeHaltReader{equity: 10000}
	cfg := CoilLiveHaltConfig{Enabled: true, DrawdownPct: 0.15, BaselineUSD: 5000, StateDir: dir}

	g := NewCoilLiveHaltGuard(cfg, reader)
	if err := g.EvaluateEntry(context.Background()); err != nil {
		t.Fatalf("equity at a new peak must be allowed, got %v", err)
	}

	// Equity falls to 8600 — only 14% off the 10000 peak: still allowed.
	reader.equity = 8600
	if err := g.EvaluateEntry(context.Background()); err != nil {
		t.Fatalf("14%% off peak must be allowed, got %v", err)
	}

	// 8400 is -16% off the 10000 peak, though still far above the 5000 baseline.
	reader.equity = 8400
	if err := g.EvaluateEntry(context.Background()); err == nil {
		t.Fatal("-16% off the high-water peak must block even while above baseline")
	}
}

// A lost state file must not silently re-arm the guard mid-drawdown. The
// baseline floors the mark, so the halt still fires.
func TestHalt_LostStateFileFallsBackToBaseline(t *testing.T) {
	g, _ := newTestHalt(t, 4000, 5000) // no prior state file exists at all
	if err := g.EvaluateEntry(context.Background()); err == nil {
		t.Fatal("with no state file, HWM must floor at the baseline and block at -20%")
	}
}

// Fail closed: an unreadable account blocks the entry.
func TestHalt_AccountErrorFailsClosed(t *testing.T) {
	dir := t.TempDir()
	g := NewCoilLiveHaltGuard(CoilLiveHaltConfig{
		Enabled: true, DrawdownPct: 0.15, BaselineUSD: 5000, StateDir: dir,
	}, &fakeHaltReader{err: errors.New("broker down")})
	if err := g.EvaluateEntry(context.Background()); err == nil {
		t.Fatal("unreadable account must fail closed, got nil")
	}
}

// Fail closed: enabled but unconfigured baseline is a misconfiguration.
func TestHalt_ZeroBaselineFailsClosed(t *testing.T) {
	dir := t.TempDir()
	g := NewCoilLiveHaltGuard(CoilLiveHaltConfig{
		Enabled: true, DrawdownPct: 0.15, BaselineUSD: 0, StateDir: dir,
	}, &fakeHaltReader{equity: 5000})
	if err := g.EvaluateEntry(context.Background()); err == nil {
		t.Fatal("enabled guard with no baseline must fail closed, got nil")
	}
}

// The latch survives recovery: once tripped, equity climbing back does NOT
// re-arm. Re-arm is deliberate file deletion only.
func TestHalt_LatchRequiresManualRearm(t *testing.T) {
	dir := t.TempDir()
	reader := &fakeHaltReader{equity: 4000}
	cfg := CoilLiveHaltConfig{Enabled: true, DrawdownPct: 0.15, BaselineUSD: 5000, StateDir: dir}

	g := NewCoilLiveHaltGuard(cfg, reader)
	if err := g.EvaluateEntry(context.Background()); err == nil {
		t.Fatal("expected the halt to trip")
	}

	// Equity fully recovers. A fresh guard (simulating a restart) must STILL block.
	reader.equity = 6000
	g2 := NewCoilLiveHaltGuard(cfg, reader)
	err := g2.EvaluateEntry(context.Background())
	if err == nil {
		t.Fatal("a tripped latch must survive restart and recovery — got nil")
	}

	// Deleting the latch re-arms it.
	if rmErr := os.Remove(filepath.Join(dir, coilHaltLatchFileName)); rmErr != nil {
		t.Fatalf("remove latch: %v", rmErr)
	}
	g3 := NewCoilLiveHaltGuard(cfg, reader)
	if err := g3.EvaluateEntry(context.Background()); err != nil {
		t.Fatalf("after manual re-arm the guard must allow, got %v", err)
	}
}

func TestHalt_ManualKillBlocks(t *testing.T) {
	g, dir := newTestHalt(t, 5000, 5000)
	if err := os.WriteFile(filepath.Join(dir, coilHaltKillFileName), []byte("{}"), 0o644); err != nil {
		t.Fatalf("write kill file: %v", err)
	}
	if err := g.EvaluateEntry(context.Background()); err == nil {
		t.Fatal("manual kill file must block entries")
	}
}
