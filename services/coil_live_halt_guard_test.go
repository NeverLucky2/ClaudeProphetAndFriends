package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"prophet-trader/interfaces"
	"sync"
	"sync/atomic"
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

// sequencedHaltReader hands out a distinct equity per call, in call order.
// Used to make concurrent EvaluateEntry calls on ONE shared guard exercise
// varying payloads instead of writing byte-identical state every time.
type sequencedHaltReader struct {
	mu       sync.Mutex
	equities []float64
	next     int
}

func (r *sequencedHaltReader) GetAccount(_ context.Context) (*interfaces.Account, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.next >= len(r.equities) {
		return nil, errors.New("sequencedHaltReader: exhausted")
	}
	v := r.equities[r.next]
	r.next++
	return &interfaces.Account{PortfolioValue: v}, nil
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
// high-water file or race on shared guard state.
//
// This is split into two tests instead of one, deliberately: combining a
// tight-loop concurrent reader with a strict "the final value must equal
// the exact max" assertion is flaky on Windows for a reason that has
// nothing to do with the guard's correctness. os.Open on Windows does not
// request FILE_SHARE_DELETE, so a reader with an open handle can make a
// concurrent os.Rename(tmp, target) fail with ERROR_ACCESS_DENIED /
// ERROR_SHARING_VIOLATION (confirmed empirically here: a busy-loop reader
// caused roughly half of 50 writes to be denied). writeHighWater treats
// that as non-fatal by design (see its doc comment: equity is already at a
// new peak on THIS call, so failing to persist it doesn't create a
// drawdown on THIS call) — but it does mean "which specific write, if any,
// loses the race with a reader's open handle" is genuinely nondeterministic
// noise, not a signal. Asserting an exact final value while also
// maximizing reader/writer contention conflates that noise with the actual
// bug class (a lost ratchet from an unserialized read-modify-write). Two
// separate, single-purpose tests avoid that:
//   - the first drives 50 concurrent EvaluateEntry calls with distinct
//     equities and NO competing reader, so every write's rename has a clear
//     path and the final value deterministically pins down whether g.mu
//     correctly serialized the read-decide-write sequence;
//   - the second drives concurrent writes AND a concurrent reader and
//     asserts only that the reader never observes truncated/invalid
//     content — the property atomicWriteFile's rename actually guarantees,
//     regardless of whether any individual write is denied by the OS.
//
// `-race` cannot run on this machine (CGO_ENABLED=0, no C toolchain), so
// both tests are written to be meaningful without it.

// TestHalt_ConcurrentEvaluateEntryNoRace: 50 goroutines call EvaluateEntry
// on ONE shared guard with DISTINCT, varying equities (not one shared
// value — a version that fed every goroutine the same equity would emit
// byte-identical writes and could not detect a lost ratchet at all). The
// final persisted high-water mark must equal the MAXIMUM equity any call
// saw. This is deterministic and timing-independent: exercising g.mu is
// what makes it deterministic despite 50 goroutines racing to read, decide,
// and write against shared state.
func TestHalt_ConcurrentEvaluateEntryNoRace(t *testing.T) {
	dir := t.TempDir()
	cfg := CoilLiveHaltConfig{Enabled: true, DrawdownPct: 0.15, BaselineUSD: 5000, StateDir: dir}

	const n = 50

	// Hands out a DISTINCT, strictly-above-baseline equity per call (in
	// whatever order goroutines happen to acquire g.mu), so every ratcheting
	// write's payload differs from the others. The spread stays under the
	// 15% drawdown limit end-to-end (5933 vs 5100 is ~14.0%) so no ordering
	// of these calls can spuriously trip the latch — the only thing under
	// test here is the ratchet, not the drawdown block.
	equities := make([]float64, n)
	maxEquity := 0.0
	for i := 0; i < n; i++ {
		equities[i] = 5100 + float64(i)*17
		if equities[i] > maxEquity {
			maxEquity = equities[i]
		}
	}
	reader := &sequencedHaltReader{equities: equities}
	g := NewCoilLiveHaltGuard(cfg, reader) // ONE shared guard: exercises g.mu for real

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
	if s.HighWaterUSD != maxEquity {
		t.Fatalf("lost ratchet: expected persisted high-water to equal the max equity seen (%v), got %v", maxEquity, s.HighWaterUSD)
	}
}

// TestHalt_ConcurrentReaderNeverObservesTornWrite runs concurrent
// ratcheting writes (varying equity, same shared-guard setup as above)
// alongside a goroutine that continuously reads the state file for the
// whole duration. It asserts only that any read which DOES return bytes is
// always well-formed: valid JSON with a positive HighWaterUSD, never
// truncated/partial content. This is exactly what atomicWriteFile's
// temp-file+rename exists to guarantee for any external reader (an ops
// script, the Status() endpoint, ...) that isn't holding g.mu. It
// deliberately does NOT assert anything about the final persisted value —
// see the doc comment above for why combining that assertion with a
// contentious concurrent reader is flaky on Windows for reasons unrelated
// to correctness.
func TestHalt_ConcurrentReaderNeverObservesTornWrite(t *testing.T) {
	dir := t.TempDir()
	cfg := CoilLiveHaltConfig{Enabled: true, DrawdownPct: 0.15, BaselineUSD: 5000, StateDir: dir}

	const n = 50
	equities := make([]float64, n)
	for i := 0; i < n; i++ {
		equities[i] = 5100 + float64(i)*17
	}
	reader := &sequencedHaltReader{equities: equities}
	g := NewCoilLiveHaltGuard(cfg, reader)

	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = g.EvaluateEntry(context.Background())
		}()
	}

	var successfulReads int64
	readErrs := make(chan error, 2000)
	stopReading := make(chan struct{})
	var readerWg sync.WaitGroup
	readerWg.Add(1)
	go func() {
		defer readerWg.Done()
		for {
			select {
			case <-stopReading:
				return
			default:
			}
			b, err := os.ReadFile(filepath.Join(dir, coilHaltStateFileName))
			if err != nil {
				// fs.ErrNotExist: no write yet. Any other error (permission
				// denied, sharing violation, "used by another process", ...):
				// the OS denied the open outright during a concurrent
				// rename-replace — zero bytes observed, so this cannot be a
				// torn read; it's the OS refusing access rather than handing
				// back partial content. Retry either way; neither is a
				// failure — only a successful-but-malformed read is.
				continue
			}
			atomic.AddInt64(&successfulReads, 1)
			var s highWaterState
			if err := json.Unmarshal(b, &s); err != nil {
				readErrs <- fmt.Errorf("torn/invalid JSON observed mid-write: %v (contents: %q)", err, b)
				continue
			}
			if s.HighWaterUSD <= 0 {
				readErrs <- fmt.Errorf("torn write observed: parsed but zero-valued high_water_usd (contents: %q)", b)
			}
		}
	}()

	wg.Wait()
	close(stopReading)
	readerWg.Wait()
	close(readErrs)

	if successfulReads == 0 {
		t.Fatal("concurrent reader never observed a successful read at all — test did not exercise anything, cannot trust the no-torn-read result")
	}
	t.Logf("concurrent reader completed %d successful reads during the write window", successfulReads)
	for err := range readErrs {
		t.Errorf("concurrent reader: %v", err)
	}
}

// N1: a vanished StateDir — the PARENT directory itself, not just a file
// inside it — must BLOCK, not silently disarm. Before the coilStateDirStatable
// fix, os.Stat on killPath/latchPath/statePath all returned fs.ErrNotExist
// once the parent directory was gone, which coilHaltFileExists and
// readPersistedHighWater each (correctly, in isolation) read as "legitimately
// absent": kill file absent, latch absent, AND high-water file absent (=
// fresh first run, found=false/err=nil). The peak would silently reset to
// current equity and a TRIPPED latch would disarm with no block and no
// error — confirmed empirically by the reviewer this task is closing.
func TestHalt_VanishedStateDirBlocksEvenWithTrippedLatch(t *testing.T) {
	dir := t.TempDir()
	reader := &fakeHaltReader{equity: 4000}
	cfg := CoilLiveHaltConfig{Enabled: true, DrawdownPct: 0.15, BaselineUSD: 5000, StateDir: dir}
	g := NewCoilLiveHaltGuard(cfg, reader)

	// Trip the latch (baseline 5000, equity 4000 => -20% drawdown).
	if err := g.EvaluateEntry(context.Background()); err == nil {
		t.Fatal("expected the drawdown halt to trip")
	}
	if _, err := os.Stat(filepath.Join(dir, coilHaltLatchFileName)); err != nil {
		t.Fatalf("expected the latch file to exist after tripping: %v", err)
	}

	// Simulate the StateDir vanishing: os.RemoveAll(StateDir), an unmounted
	// volume, or an ephemeral container dir that never persisted.
	if err := os.RemoveAll(dir); err != nil {
		t.Fatalf("remove state dir: %v", err)
	}
	if _, statErr := os.Stat(dir); !errors.Is(statErr, fs.ErrNotExist) {
		t.Fatalf("precondition: StateDir must be gone, got stat err %v", statErr)
	}

	// Equity fully recovering would normally matter, but must NOT matter
	// here: a vanished StateDir means the guard can no longer trust ANY
	// on-disk conclusion (kill file, latch, high-water) about this account,
	// so it must block regardless of what equity says.
	reader.equity = 6000
	if err := g.EvaluateEntry(context.Background()); err == nil {
		t.Fatal("a vanished StateDir must BLOCK (fail closed) even though every file-level stat inside it now reads as fs.ErrNotExist — got nil (fail-open)")
	}
}

// A StateDir that was never created (a true bootstrap-before-first-write) is,
// on disk, indistinguishable from a vanished one: os.Stat on a path inside
// either returns fs.ErrNotExist. For a money rail the correct default is
// fail-closed in both cases — this pins that deliberate design choice. (In
// production StateDir defaults to the database's own directory, which
// necessarily exists whenever the bot is running, so this does not create a
// real deadlock — see the coilStateDirStatable doc comment.)
func TestHalt_NeverCreatedStateDirBlocks(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "never-created-subdir")
	g := NewCoilLiveHaltGuard(CoilLiveHaltConfig{
		Enabled: true, DrawdownPct: 0.15, BaselineUSD: 5000, StateDir: dir,
	}, &fakeHaltReader{equity: 5000})
	if err := g.EvaluateEntry(context.Background()); err == nil {
		t.Fatal("a StateDir that has never been created must fail closed (block), got nil")
	}
}

// LOW: a syntactically valid but semantically empty state file (`{}` or
// `null`) parses without error to a zero-value highWaterState, which must be
// treated as corrupt (block) rather than accepted as HighWaterUSD == 0 — a
// $0 persisted peak is not real data about a funded live account.
func TestHalt_EmptyStateFileBlocks(t *testing.T) {
	for _, content := range []string{"{}", "null"} {
		t.Run(content, func(t *testing.T) {
			g, dir := newTestHalt(t, 5000, 5000)
			if err := os.WriteFile(filepath.Join(dir, coilHaltStateFileName), []byte(content), 0o644); err != nil {
				t.Fatalf("write %q state file: %v", content, err)
			}
			if err := g.EvaluateEntry(context.Background()); err == nil {
				t.Fatalf("a %q state file (zero high-water) must block (fail closed), got nil", content)
			}
		})
	}
}
