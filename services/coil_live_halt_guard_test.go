package services

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"prophet-trader/interfaces"
	"sync"
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

// I2: a corrupt/unreadable high-water state file must fail closed (block),
// never silently collapse the peak to 0. Equity here is at the baseline —
// with a legitimate absent-file first run this would ratchet and ALLOW; the
// only thing that must change the outcome is the corruption itself.
func TestHalt_CorruptHighWaterFileBlocks(t *testing.T) {
	g, dir := newTestHalt(t, 5000, 5000)
	if err := os.WriteFile(filepath.Join(dir, coilHaltStateFileName), []byte("not valid json {{{"), 0o644); err != nil {
		t.Fatalf("write garbage state file: %v", err)
	}
	if err := g.EvaluateEntry(context.Background()); err == nil {
		t.Fatal("a corrupt high-water state file must block (fail closed), got nil")
	}
}

// KNOWN LIMITATION — pinned intentionally, not an endorsement. See the
// effectiveHighWater doc comment: the baseline floor BOUNDS a lost peak, it
// does not preserve it. Here the true peak was 10000 but its state file was
// never written/was lost, so a fresh guard has no way to recover it and can
// only see max(baseline, equity). With equity 8000 and baseline 5000, that
// floors at 8000 — the guard treats 8000 as the peak and ALLOWS, even though
// the true drawdown from the real 10000 peak is -20%, well past the 15%
// limit. This is why operators must never delete the high-water state file.
func TestHalt_LostStateFileAboveBaseline_KnownLimitationAllowsEntry(t *testing.T) {
	// No state file is ever written in this test — simulating a peak of
	// 10000 that occurred but was never persisted (or whose file was lost).
	g, _ := newTestHalt(t, 8000, 5000)
	if err := g.EvaluateEntry(context.Background()); err != nil {
		t.Fatalf("documented limitation: a lost state file above baseline currently ALLOWS the entry (equity treated as the new peak); got block %v", err)
	}
}

// The high-water mark must survive a process restart: a SECOND guard built
// from the same StateDir must see the peak the FIRST guard persisted, not
// just its own baseline/equity. (The ratchet test above reuses one instance
// throughout and would pass even with zero persistence.)
func TestHalt_HighWaterPersistsAcrossRestart(t *testing.T) {
	dir := t.TempDir()
	cfg := CoilLiveHaltConfig{Enabled: true, DrawdownPct: 0.15, BaselineUSD: 5000, StateDir: dir}

	g1 := NewCoilLiveHaltGuard(cfg, &fakeHaltReader{equity: 10000})
	if err := g1.EvaluateEntry(context.Background()); err != nil {
		t.Fatalf("first guard at a new peak must be allowed and persist it, got %v", err)
	}

	// Second guard instance, same StateDir — simulating a restart. Its own
	// equity is 8400, which is -16% off the FIRST guard's 10000 peak but
	// still above the 5000 baseline. If the peak did not survive the
	// restart, this guard would compute max(5000, 8400) = 8400 and ALLOW.
	g2 := NewCoilLiveHaltGuard(cfg, &fakeHaltReader{equity: 8400})
	if err := g2.EvaluateEntry(context.Background()); err == nil {
		t.Fatal("a fresh guard instance must read the persisted 10000 peak from disk and block at -16%, got nil")
	}
}

// I1/M-ish: a latch file whose content cannot be parsed must still block —
// the block decision is (and must remain) presence-only. This guards
// against a future regression where someone adds content validation to the
// latch check and treats unparseable content as "not latched."
func TestHalt_UnreadableLatchFileBlocks(t *testing.T) {
	// Equity equals baseline (0% drawdown) so the ONLY thing that could
	// cause a block is the latch file's presence.
	g, dir := newTestHalt(t, 5000, 5000)
	if err := os.WriteFile(filepath.Join(dir, coilHaltLatchFileName), []byte("not valid json {{{"), 0o644); err != nil {
		t.Fatalf("write garbage latch file: %v", err)
	}
	if err := g.EvaluateEntry(context.Background()); err == nil {
		t.Fatal("an unreadable/unparseable latch file must still block by presence alone, got nil")
	}
}

// I4: concurrent EvaluateEntry calls must not corrupt the persisted
// high-water file or race on shared guard state. Run with -race.
func TestHalt_ConcurrentEvaluateEntryNoRace(t *testing.T) {
	dir := t.TempDir()
	cfg := CoilLiveHaltConfig{Enabled: true, DrawdownPct: 0.15, BaselineUSD: 5000, StateDir: dir}
	g := NewCoilLiveHaltGuard(cfg, &fakeHaltReader{equity: 9000}) // above baseline: every call ratchets

	const n = 50
	var wg sync.WaitGroup
	errs := make([]error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			errs[idx] = g.EvaluateEntry(context.Background())
		}(i)
	}
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Fatalf("concurrent call %d: equity at a new peak must be allowed, got %v", i, err)
		}
	}

	b, err := os.ReadFile(filepath.Join(dir, coilHaltStateFileName))
	if err != nil {
		t.Fatalf("state file must exist and be readable after concurrent writes: %v", err)
	}
	var s highWaterState
	if err := json.Unmarshal(b, &s); err != nil {
		t.Fatalf("state file must be valid JSON after concurrent writes (not truncated/corrupt): %v\ncontents: %q", err, b)
	}
	if s.HighWaterUSD != 9000 {
		t.Fatalf("expected persisted high-water 9000, got %v", s.HighWaterUSD)
	}
}
