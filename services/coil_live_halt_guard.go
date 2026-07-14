package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"sync"
	"time"

	"prophet-trader/interfaces"

	"github.com/sirupsen/logrus"
)

const (
	coilHaltKillFileName  = "KILL_COIL_LIVE"
	coilHaltLatchFileName = "coil_live_halt.json"
	coilHaltStateFileName = "coil_live_highwater.json"
)

// HaltAccountReader is the narrow broker-read surface the halt needs.
// interfaces.TradingService satisfies it.
type HaltAccountReader interface {
	GetAccount(ctx context.Context) (*interfaces.Account, error)
}

// CoilLiveHaltConfig parameterizes the live drawdown halt.
type CoilLiveHaltConfig struct {
	Enabled     bool
	DrawdownPct float64 // 0.15 = halt at -15% from the high-water mark
	BaselineUSD float64 // funded baseline; floors the high-water mark. <=0 => fail closed when enabled
	StateDir    string
}

// CoilLiveHaltGuard blocks NEW ENTRIES once live equity falls DrawdownPct below
// its high-water mark. It is the only code-enforced rail bounding real-money
// loss on the live Coil account — every other Coil cap (position size,
// concurrency, deploy ceiling) is prose the LLM is trusted to self-police, which
// is acceptable on paper and not acceptable here.
//
// FAILS CLOSED on every uncertainty: missing baseline, invalid drawdown pct,
// a nil reader, a StateDir that is missing/not-a-directory/unstatable (see
// coilStateDirStatable — checked BEFORE any file-presence check, because a
// vanished StateDir makes every file inside it stat as "absent" too), an
// unreadable account, a present (or unreadable — see coilHaltFileExists)
// kill/latch file, an unreadable/corrupt/zero-valued high-water state file,
// or a persist-degraded guard (see persistDegraded below) all block the
// entry. Consulted only from TradeGuard.CheckBuy, so exits are never
// blocked.
//
// EvaluateEntry is safe for concurrent use: mu serializes the
// read-high-water / decide / write-high-water sequence so two concurrent
// buys cannot interleave and lose a ratchet or a latch write, and all state
// files are written atomically (temp file + rename) so a crash or a
// concurrent reader can never observe a truncated file.
//
// Re-arm is deliberate: delete the latch file. There is intentionally no
// programmatic re-arm. Do NOT delete the high-water state file to "fix" a
// halt — see the effectiveHighWater doc comment for why that only bounds,
// rather than eliminates, the resulting loss of the true peak.
//
// hwmMem is a same-process backstop for a failed persist (see writeHighWater
// and effectiveHighWater): a denied atomic write/rename — full disk,
// transient I/O error, or (confirmed empirically on Windows: a concurrent
// reader with an open handle denies roughly half of a tight loop of renames
// because os.Open there omits FILE_SHARE_DELETE) a concurrent Status() call
// racing the rename — must not make the guard forget a peak it already
// observed. It is NOT a substitute for the state file: it does not survive a
// restart (see TestHalt_InMemoryHighWaterDoesNotSurviveRestart), and the file
// remains the only thing that does.
//
// persistDegraded (N-1) is the complementary fix for what hwmMem alone does
// NOT cover: hwmMem only protects the CURRENT process's memory of a peak it
// already observed, but whatever denies a write to StateDir — a full disk, a
// read-only remount, an unwritable mount — denies writeHighWater, tripLatch,
// AND fallbackKillFile alike. Without persistDegraded, the guard would keep
// ALLOWING entries for as long as the process stays up (equity ratchets
// happily in memory even though nothing reaches disk), and only reveal the
// problem on the NEXT restart: hwmMem dies with the process, the mark
// reverts to whatever was last durably written (stale and LOWER than the
// true peak), and an entry that should have blocked gets allowed. That
// contradicts this file's own "FAILS CLOSED" contract — a doc comment
// describing the danger honestly is not a rail. persistDegraded closes it:
// once ANY persist attempt fails (high-water write, latch write, or the
// kill-file fallback), the flag is set under g.mu and EvaluateEntry checks
// it FIRST, before anything else, and blocks every subsequent entry for the
// life of the process. It is deliberately NOT auto-cleared — recovery is an
// operator action (fix StateDir, RECONCILE THE HIGH-WATER MARK against the
// account's true peak — it stopped ratcheting while degraded — then restart
// the process) — and it is safe to be
// this aggressive because EvaluateEntry is only ever consulted for NEW
// entries: a degraded guard cannot trap an already-open position, since
// exits never route through it.
type CoilLiveHaltGuard struct {
	cfg    CoilLiveHaltConfig
	reader HaltAccountReader
	logger *logrus.Logger

	mu              sync.Mutex
	hwmMem          float64
	persistDegraded bool

	// testPersistFailure, when non-nil, makes writeHighWater, tripLatch, and
	// fallbackKillFile each log-and-return without attempting the real disk
	// write, deterministically simulating a denied atomic write/rename across
	// ALL of StateDir at once — the realistic shape of the N-1 failure mode
	// (a full disk or read-only remount denies every write, not just one
	// file). Set only by tests in this package (white-box) to exercise NEW-1
	// and N-1 without depending on OS-specific permission behavior, which is
	// unreliable on Windows for this exact scenario (see the concurrency
	// tests below). Nil in production — see
	// TestHalt_ConstructorLeavesTestPersistFailureUnset, which pins that the
	// constructor never sets it, so it has exactly one writer: tests in this
	// file, deliberately.
	testPersistFailure error
}

func NewCoilLiveHaltGuard(cfg CoilLiveHaltConfig, reader HaltAccountReader) *CoilLiveHaltGuard {
	logger := logrus.New()
	logger.SetFormatter(&logrus.TextFormatter{FullTimestamp: true})
	return &CoilLiveHaltGuard{cfg: cfg, reader: reader, logger: logger}
}

func (g *CoilLiveHaltGuard) killPath() string {
	return filepath.Join(g.cfg.StateDir, coilHaltKillFileName)
}
func (g *CoilLiveHaltGuard) latchPath() string {
	return filepath.Join(g.cfg.StateDir, coilHaltLatchFileName)
}
func (g *CoilLiveHaltGuard) statePath() string {
	return filepath.Join(g.cfg.StateDir, coilHaltStateFileName)
}

// coilHaltFileExists reports whether a guard file (kill switch or latch)
// should be treated as PRESENT, given that its parent StateDir is already
// known to be a statable directory (see coilStateDirStatable, which
// EvaluateEntry and Status both call BEFORE this function). A stat error on
// the file itself that is NOT "file does not exist" — a permission error,
// an I/O error, a mid-write race — is never read as "absent"; only a
// definitive fs.ErrNotExist is.
//
// This function alone cannot distinguish "file legitimately absent from a
// healthy directory" from "file absent because the whole parent directory
// vanished" — os.Stat on a path inside a missing directory ALSO returns
// fs.ErrNotExist, for the same reason a missing leaf file does. That
// ambiguity is exactly why callers must verify StateDir itself first: this
// function only ever runs once that precondition holds.
func coilHaltFileExists(p string) bool {
	_, err := os.Stat(p)
	if err == nil {
		return true
	}
	return !errors.Is(err, fs.ErrNotExist)
}

// coilStateDirStatable verifies StateDir itself is a real, statable
// directory before ANY "file is absent" conclusion (coilHaltFileExists,
// readPersistedHighWater) is trusted. This closes the fail-open where a
// vanished StateDir — deleted via os.RemoveAll, unmounted, renamed, or an
// ephemeral container dir that never persisted — made os.Stat on every file
// inside it return fs.ErrNotExist. Read in isolation, that made the kill
// file read as absent, the latch read as absent, AND the high-water file
// read as a legitimate first run (found=false, err=nil) all at once: the
// peak would silently reset to current equity and a TRIPPED latch would
// disarm with no block and no error.
//
// Any failure here — StateDir unset, missing, or a path that exists but is
// not a directory — blocks. This deliberately includes a StateDir that has
// never been created: on disk, "never created" and "vanished" are the same
// fs.ErrNotExist, so a money rail cannot tell them apart and must not
// assume the more comfortable interpretation. In production StateDir
// defaults to the database's own directory (see cmd/bot/main.go), which
// necessarily already exists whenever the bot is running a DB-backed
// account, so this does not introduce a real bootstrap deadlock — it only
// blocks the genuinely abnormal case of a missing or broken StateDir.
func coilStateDirStatable(dir string) error {
	if dir == "" {
		return errors.New("StateDir is not configured")
	}
	info, err := os.Stat(dir)
	if err != nil {
		return fmt.Errorf("cannot stat StateDir %q: %w", dir, err)
	}
	if !info.IsDir() {
		return fmt.Errorf("StateDir %q exists but is not a directory", dir)
	}
	return nil
}

// coilHaltWriteProbeFileName is the throwaway file CoilStateDirWritable
// writes-then-removes to prove StateDir is actually writable, not just
// statable. Named distinctly from the three real state files so it can never
// collide with coilHaltFileExists/readPersistedHighWater's notion of
// "present" for the kill switch, latch, or high-water mark.
const coilHaltWriteProbeFileName = "coil_live_write_probe.tmp"

// coilStateDirWriteProbeFunc performs the probe write inside
// CoilStateDirWritable. It is atomicWriteFile in production — always, with
// exactly one writer (the var initializer below; nothing else in production
// code reassigns it). Tests in this package (white-box) may temporarily swap
// it to deterministically simulate a denied probe write without depending on
// OS-specific permission/ACL behavior, which is unreliable on Windows for
// this exact scenario — the same rationale as testPersistFailure above,
// applied here because CoilStateDirWritable is a package-level function with
// no guard instance (and therefore no struct field) to hang a test hook off
// of at arm time, before any guard is constructed.
var coilStateDirWriteProbeFunc = atomicWriteFile

// CoilStateDirWritable is the exported ARM-TIME check, called from
// cmd/bot/main.go before NewCoilLiveHaltGuard is even constructed, so a
// misconfigured or unwritable COIL_LIVE_STATE_DIR fails loudly at startup
// (logger.Fatalf) instead of silently degrading every live entry with
// nothing but a repeating log line to explain why.
//
// This closes the hole a stat-only check leaves open: a directory can be
// perfectly statable — exists, is a directory — and still be unwritable (a
// full disk, a read-only remount, an ACL change). The old CoilStateDirStatable
// name is gone because a stat alone is no longer what arm time trusts. The
// failure loop a stat-only check invited: StateDir goes unwritable while the
// bot is running -> persistDegraded correctly trips and blocks new entries,
// telling the operator to "fix StateDir and restart the process" -> the
// operator restarts WITHOUT fixing the disk (the message invited exactly
// that) -> the new process starts with persistDegraded=false and hwmMem=0,
// the stat-only check passes because the dir still stats fine, and the guard
// resumes measuring drawdown against a high-water mark that stopped
// ratcheting the moment the old process degraded — stale and LOWER than the
// true peak, so a real drawdown reads as a small one and an entry that
// should block gets allowed. An unwritable StateDir must refuse to BOOT
// rather than silently resume from stale state; booting into a state the
// guard cannot persist is the fail-open this closes.
//
// First runs coilStateDirStatable (the existing empty-path / stat-error /
// not-a-directory checks — kept as-is, the probe below is an ADDITION, not a
// replacement) and returns immediately on failure, before ever touching the
// filesystem for a write. Only once that passes does this write a probe file
// via atomicWriteFile — the SAME temp-file-then-rename mechanism the real
// persists (writeHighWater, tripLatch, fallbackKillFile) use, not a bare
// os.Create — so the probe exercises the actual write path, then removes it.
// Any failure to write the probe is returned as an error for main.go's
// existing logger.Fatalf to act on: fail closed, refuse to start.
//
// Deliberately does NOT create StateDir if it is missing — coilStateDirStatable
// already rejects that case above before any write is attempted, and even
// the probe write's call into atomicWriteFile (which does its own
// os.MkdirAll) is therefore only ever reached when StateDir already exists,
// so it can never resurrect a vanished directory. See coilStateDirStatable's
// doc comment: resurrecting a vanished StateDir would silently drop whatever
// latch/kill state used to live there across a restart, which is the exact
// fail-open a previous review round closed and this one must not reopen.
//
// A failure to remove the probe file after a successful write is logged (if
// a logger is supplied) but does NOT itself block boot — the write succeeded,
// which is what this check exists to prove; a harmless leftover probe file
// is not evidence StateDir is unwritable.
func CoilStateDirWritable(dir string, logger *logrus.Logger) error {
	if err := coilStateDirStatable(dir); err != nil {
		return err
	}
	probePath := filepath.Join(dir, coilHaltWriteProbeFileName)
	if err := coilStateDirWriteProbeFunc(dir, probePath, []byte("coil live halt write probe\n"), 0o600); err != nil {
		return fmt.Errorf("StateDir %q is not writable: %w", dir, err)
	}
	if rmErr := os.Remove(probePath); rmErr != nil && !errors.Is(rmErr, fs.ErrNotExist) {
		if logger != nil {
			logger.WithError(rmErr).WithField("probe_path", probePath).
				Warn("coil live halt: write probe succeeded but removing the probe file afterward failed; " +
					"the leftover file is harmless and does not block boot, but should be cleaned up manually")
		}
	}
	return nil
}

func (g *CoilLiveHaltGuard) block(reason string) error {
	g.logger.WithFields(logrus.Fields{"coil_live_halt_block": true, "reason": reason}).
		Warn("Coil live halt blocked a new entry")
	return fmt.Errorf("coil live halt: %s", reason)
}

// highWaterState is the persisted peak. Written on every ratchet-up.
type highWaterState struct {
	HighWaterUSD float64   `json:"high_water_usd"`
	UpdatedAt    time.Time `json:"updated_at"`
}

// readPersistedHighWater distinguishes three cases so a corrupt or
// unreadable state file can never be silently treated as "no prior peak":
//   - absent (fs.ErrNotExist): legitimate first run — found=false, err=nil
//   - present but unreadable, unparseable, or parseable-but-nonsensical
//     (corruption, permission fault, truncated write, valid JSON `{}` or
//     `null` that parses to a zero HighWaterUSD, ...): err != nil — the
//     caller MUST fail closed
//   - present and valid: value, found=true, err=nil
//
// A zero or negative HighWaterUSD is deliberately treated the same as
// unparseable content: `{}` and `null` are both syntactically valid JSON
// that unmarshal to a zero-value highWaterState with no error, but a
// real high-water mark is always a positive USD figure — a persisted peak
// of $0 is not data about the account, it is a sign the file was
// truncated, replaced by an empty write, or never actually written by this
// guard. Silently accepting it would collapse the peak exactly like the
// truncated-write bug atomicWriteFile exists to prevent.
func (g *CoilLiveHaltGuard) readPersistedHighWater() (value float64, found bool, err error) {
	b, statErr := os.ReadFile(g.statePath())
	if statErr != nil {
		if errors.Is(statErr, fs.ErrNotExist) {
			return 0, false, nil
		}
		return 0, false, fmt.Errorf("high-water state file unreadable: %w", statErr)
	}
	var s highWaterState
	if jsonErr := json.Unmarshal(b, &s); jsonErr != nil {
		return 0, false, fmt.Errorf("high-water state file corrupt: %w", jsonErr)
	}
	if s.HighWaterUSD <= 0 {
		return 0, false, fmt.Errorf("high-water state file has non-positive high_water_usd %.2f (treated as corrupt)", s.HighWaterUSD)
	}
	return s.HighWaterUSD, true, nil
}

// atomicWriteFile writes data to target by writing a temp file in dir and
// renaming it over target. os.WriteFile is truncate-then-write: a crash or a
// concurrent writer mid-write can leave target truncated, which (for the
// high-water file) would previously have parsed as 0 and destroyed the peak.
// Rename is atomic on both POSIX and Windows (Go's os.Rename uses
// MoveFileEx with MOVEFILE_REPLACE_EXISTING there), so a reader always sees
// either the fully-old or fully-new contents, never a partial write.
//
// N-3: the MkdirAll below WOULD resurrect a vanished StateDir — recreating
// it here would silently drop whatever latch/kill/high-water state used to
// live there across the vanish, exactly the fail-open coilStateDirStatable's
// doc comment describes and closes. This is only safe because every
// production caller of atomicWriteFile (writeHighWater, tripLatch,
// fallbackKillFile) is reached exclusively through EvaluateEntry, which
// calls coilStateDirStatable and blocks BEFORE any of them run. Do not call
// atomicWriteFile — or add a new caller of it — from anywhere that has not
// first passed coilStateDirStatable(dir); doing so would silently
// reintroduce the vanished-dir fail-open.
func atomicWriteFile(dir, target string, data []byte, perm os.FileMode) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("cannot create state dir: %w", err)
	}
	tmp, err := os.CreateTemp(dir, filepath.Base(target)+".tmp-*")
	if err != nil {
		return fmt.Errorf("cannot create temp file: %w", err)
	}
	tmpPath := tmp.Name()
	cleanup := func() { _ = os.Remove(tmpPath) }

	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		cleanup()
		return fmt.Errorf("cannot write temp file: %w", err)
	}
	if err := tmp.Chmod(perm); err != nil {
		_ = tmp.Close()
		cleanup()
		return fmt.Errorf("cannot chmod temp file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return fmt.Errorf("cannot close temp file: %w", err)
	}
	if err := os.Rename(tmpPath, target); err != nil {
		cleanup()
		return fmt.Errorf("cannot rename temp file into place: %w", err)
	}
	return nil
}

// writeHighWater persists the ratcheted peak atomically (see
// atomicWriteFile). Errors are logged loudly but do not block the CURRENT
// call: equity is at or above the high-water mark here (that is why we are
// ratcheting), so there is no drawdown to protect against on this entry.
//
// A failed persist no longer loses the peak within this process: the caller
// (EvaluateEntry) updates hwmMem under g.mu BEFORE calling writeHighWater, so
// effectiveHighWater's max(...) still sees the observed peak on every later
// call in this process even if the bytes never reached disk. Only a
// RESTART loses hwmMem — that is what the state file is for, and it is why a
// failed persist must still be logged loudly: an operator needs to know the
// file is stale before the process restarts and the memory backstop goes
// away with it.
//
// N-1: a failed persist also sets g.persistDegraded (under g.mu — this
// method is only ever called from EvaluateEntry, which already holds the
// lock for the whole call, so this is a direct field write, not a re-lock).
// hwmMem alone only protects THIS process's memory; it says nothing about
// whether StateDir can be written to at all. A write failure here is
// evidence it cannot, and the same fault will just as surely deny tripLatch
// and fallbackKillFile on any later beat that needs them — so the guard must
// stop trusting its own ability to persist a halt, not just log about it.
func (g *CoilLiveHaltGuard) writeHighWater(v float64) {
	b, err := json.MarshalIndent(highWaterState{HighWaterUSD: v, UpdatedAt: time.Now().UTC()}, "", "  ")
	if err != nil {
		g.persistDegraded = true
		g.logger.WithError(err).Error("coil live halt: failed to marshal high-water mark")
		return
	}
	if g.testPersistFailure != nil {
		g.persistDegraded = true
		g.logger.WithError(g.testPersistFailure).Error("coil live halt: failed to persist high-water mark (test-injected failure)")
		return
	}
	if err := atomicWriteFile(g.cfg.StateDir, g.statePath(), b, 0o644); err != nil {
		g.persistDegraded = true
		g.logger.WithError(err).Error("coil live halt: failed to persist high-water mark")
	}
}

// effectiveHighWater is max(baseline, persisted, hwmMem, equity).
//
// hwmMem closes the gap a failed writeHighWater would otherwise leave: if the
// atomic write/rename for a prior ratchet was denied (full disk, transient
// I/O error, or — confirmed empirically in this package's own concurrency
// tests — a concurrent reader on Windows denying the rename), the on-disk
// persisted value can be stale and LOWER than a peak this same process
// already observed and ratcheted to in memory. Without hwmMem in the max,
// that stale disk value alone would silently become the mark, understating
// the true drawdown and potentially ALLOWING an entry that should block: a
// concrete failure mode is persisted=$12,000 (last successful write), a
// later beat at equity $14,000 whose ratchet write is denied (hwmMem still
// advances to $14,000 in memory), then equity $11,900 — the correct
// drawdown is 15% (blocks); computed from the stale $12,000 alone it would
// be 0.83% (silently allows). See TestHalt_FailedPersistDoesNotLoseInMemoryPeak.
//
// hwmMem is NOT a substitute for the file: it lives only as long as the
// process does. Honest limitation on the file side: the baseline floor
// BOUNDS how far a lost/reset high-water mark can fall ACROSS A RESTART — it
// does NOT make losing the state file safe in general. It is only a no-op
// when equity is already at or below the baseline. If the true peak was
// above the baseline (the normal case in any drawdown that started from a
// real peak), losing the file AND the process restarting (so hwmMem is also
// gone) resets the mark down to CURRENT EQUITY, not to the true peak.
// Example: true peak $14,000, baseline $10,000, equity now $12,000 — lose
// the state file across a restart and the mark becomes $12,000, so the halt
// fires at $10,200 instead of the correct $11,900 it would have fired at
// against the true peak. The floor prevents the mark from falling BELOW the
// baseline; it does not preserve the peak above it. Operators must NOT
// delete coilHaltStateFileName. Only the latch file (coilHaltLatchFileName)
// is meant to be deleted, and only deliberately, to re-arm after a reviewed
// halt.
//
// A corrupt or unreadable state file is a DIFFERENT case and is not floored
// here at all: readPersistedHighWater reports it as an error and
// EvaluateEntry fails closed (blocks) rather than silently treating it as an
// absent file.
//
// hwmMem is taken as a PARAMETER rather than read from g.hwmMem directly
// (N-2): EvaluateEntry calls this while holding g.mu, so a direct field read
// there is safe, but Status() calls it from OUTSIDE the lock (Status must
// never take g.mu for its full duration — see its doc comment). Passing the
// value in lets each caller decide how to obtain it safely: EvaluateEntry
// reads g.hwmMem inline (already under mu), Status() takes a point-in-time
// snapshot via snapshotMu() first. Reading the shared field directly inside
// this function would race with EvaluateEntry's writes to it whenever called
// from Status(), which is exactly the bug N-2 reported.
func (g *CoilLiveHaltGuard) effectiveHighWater(equity, hwmMem float64) (float64, error) {
	persisted, _, err := g.readPersistedHighWater()
	if err != nil {
		return 0, err
	}
	return math.Max(g.cfg.BaselineUSD, math.Max(persisted, math.Max(hwmMem, equity))), nil
}

// snapshotMu returns the current in-memory high-water mark and the sticky
// persist-degraded flag, read together and atomically under g.mu. Callers
// outside EvaluateEntry (i.e. Status()) MUST go through this rather than
// reading g.hwmMem or g.persistDegraded directly — see N-2. This takes the
// lock only long enough to copy two fields; it is not held for the rest of
// the caller's work, so Status()'s subsequent broker call is never
// serialized against EvaluateEntry the way EvaluateEntry's own broker call
// is (EvaluateEntry holds g.mu for its entire body, including its
// GetAccount call). EvaluateEntry itself must never call Status() or
// snapshotMu() — sync.Mutex is not reentrant and either would deadlock.
func (g *CoilLiveHaltGuard) snapshotMu() (hwmMem float64, degraded bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.hwmMem, g.persistDegraded
}

type coilHaltLatch struct {
	Reason       string    `json:"reason"`
	EngagedAt    time.Time `json:"engaged_at"`
	EquityUSD    float64   `json:"equity_usd"`
	HighWaterUSD float64   `json:"high_water_usd"`
	DrawdownPct  float64   `json:"drawdown_pct"`
}

// tripLatch persists the halt latch atomically and reports failure to the
// caller. A failed latch write must never be silently swallowed: with no
// latch on disk, a later beat would see equity recover and re-arm itself
// with no operator action, which is exactly what "manual re-arm only"
// forbids. On failure this makes a best-effort attempt to write the kill
// file instead, so the block still survives a process restart even without
// a latch file. The caller (EvaluateEntry) blocks the CURRENT call
// regardless of this return value — the error is for loud logging and
// operator escalation, not for deciding whether to block.
//
// N-1: any failure to persist the primary latch write ALSO sets
// g.persistDegraded (direct field write — this is only ever called from
// EvaluateEntry, which already holds g.mu for the whole call). This holds
// even in the branch where fallbackKillFile then succeeds: a failed latch
// write is itself evidence StateDir is not reliably writable, which the
// guard must treat as a standing fact about the process, not a one-off
// rescued by this call's fallback.
func (g *CoilLiveHaltGuard) tripLatch(equity, hwm, dd float64) error {
	if coilHaltFileExists(g.latchPath()) {
		return nil // already latched
	}
	b, err := json.MarshalIndent(coilHaltLatch{
		Reason:       "high-water drawdown halt",
		EngagedAt:    time.Now().UTC(),
		EquityUSD:    equity,
		HighWaterUSD: hwm,
		DrawdownPct:  dd,
	}, "", "  ")
	if err != nil {
		g.persistDegraded = true
		return g.fallbackKillFile(fmt.Errorf("failed to marshal halt latch: %w", err))
	}
	if g.testPersistFailure != nil {
		g.persistDegraded = true
		return g.fallbackKillFile(fmt.Errorf("failed to write halt latch (test-injected failure): %w", g.testPersistFailure))
	}
	if err := atomicWriteFile(g.cfg.StateDir, g.latchPath(), b, 0o644); err != nil {
		g.persistDegraded = true
		return g.fallbackKillFile(fmt.Errorf("failed to write halt latch: %w", err))
	}
	return nil
}

// fallbackKillFile makes a best-effort attempt to persist the kill file when
// the primary latch write failed, so the block survives a restart even
// without a latch on disk. Its own failure is still reported to the caller:
// EvaluateEntry blocks the current call regardless, but if BOTH writes
// failed there is no on-disk record at all, and a later beat could re-arm
// silently unless the underlying fault (e.g. an unwritable StateDir) is
// fixed by an operator first.
//
// N-1: a failed kill-file write ALSO sets g.persistDegraded. In practice
// this is usually redundant with tripLatch's own mark (fallbackKillFile is
// only ever reached after the primary latch write already failed and set
// it), but it is set here too so this function is independently correct if
// it is ever called with the flag not already set.
func (g *CoilLiveHaltGuard) fallbackKillFile(latchErr error) error {
	b, _ := json.MarshalIndent(struct {
		Reason    string    `json:"reason"`
		EngagedAt time.Time `json:"engaged_at"`
	}{
		Reason:    "latch write failed; kill-file fallback engaged",
		EngagedAt: time.Now().UTC(),
	}, "", "  ")
	if g.testPersistFailure != nil {
		g.persistDegraded = true
		return fmt.Errorf("latch write failed (%v) AND kill-file fallback failed (test-injected failure: %v) — halt state not persisted to disk", latchErr, g.testPersistFailure)
	}
	if err := atomicWriteFile(g.cfg.StateDir, g.killPath(), b, 0o644); err != nil {
		g.persistDegraded = true
		return fmt.Errorf("latch write failed (%v) AND kill-file fallback failed (%v) — halt state not persisted to disk", latchErr, err)
	}
	return fmt.Errorf("latch write failed, kill-file fallback engaged instead: %w", latchErr)
}

// EvaluateEntry returns nil to allow a new entry, or an error to block it.
func (g *CoilLiveHaltGuard) EvaluateEntry(ctx context.Context) error {
	if !g.cfg.Enabled {
		return nil
	}

	g.mu.Lock()
	defer g.mu.Unlock()

	// N-1: checked FIRST, before any other condition. Once any persist has
	// failed (writeHighWater, tripLatch, or fallbackKillFile — see
	// persistDegraded's doc comment on the struct), the guard can no longer
	// prove it is able to durably record a future halt, so it must stop
	// allowing entries at all rather than keep gating off values it cannot
	// guarantee it could act on. This is sticky for the life of the process
	// by design: recovery is an operator action (fix StateDir, restart).
	if g.persistDegraded {
		return g.block("cannot persist halt state — failing closed (a prior write to StateDir failed; fix StateDir, RECONCILE THE HIGH-WATER MARK against the account's true peak, then restart the process to clear this)")
	}

	if g.cfg.BaselineUSD <= 0 {
		return g.block("baseline not configured (COIL_LIVE_BASELINE_USD<=0)")
	}
	if g.cfg.DrawdownPct <= 0 || g.cfg.DrawdownPct >= 1 {
		return g.block(fmt.Sprintf("invalid drawdown pct %.4f (want 0<pct<1)", g.cfg.DrawdownPct))
	}
	if g.reader == nil {
		return g.block("account reader not configured (fail closed)")
	}
	if err := coilStateDirStatable(g.cfg.StateDir); err != nil {
		return g.block(fmt.Sprintf("state directory unavailable (fail closed): %v", err))
	}
	if coilHaltFileExists(g.killPath()) {
		return g.block("manual kill switch engaged")
	}
	if coilHaltFileExists(g.latchPath()) {
		return g.block("drawdown halt latched — delete " + coilHaltLatchFileName + " to re-arm")
	}

	acct, err := g.reader.GetAccount(ctx)
	if err != nil {
		return g.block(fmt.Sprintf("account unavailable (fail closed): %v", err))
	}
	if acct == nil || acct.PortfolioValue <= 0 {
		return g.block("account portfolio value unavailable (fail closed)")
	}

	equity := acct.PortfolioValue
	hwm, hwmErr := g.effectiveHighWater(equity, g.hwmMem) // under g.mu already: direct field read is safe
	if hwmErr != nil {
		return g.block(fmt.Sprintf("high-water state unreadable or corrupt (fail closed): %v", hwmErr))
	}
	if equity >= hwm {
		g.hwmMem = equity        // ratchet the in-memory backstop FIRST — see effectiveHighWater
		g.writeHighWater(equity) // best-effort persist; a failure no longer loses the peak this process observed
		return nil
	}

	drawdown := (hwm - equity) / hwm
	if drawdown >= g.cfg.DrawdownPct {
		if latchErr := g.tripLatch(equity, hwm, drawdown); latchErr != nil {
			g.logger.WithError(latchErr).Error(
				"coil live halt: failed to durably persist the drawdown halt — still blocking this entry, but the halt " +
					"may not survive a restart without operator intervention; investigate StateDir immediately")
		}
		return g.block(fmt.Sprintf(
			"drawdown %.2f%% >= %.2f%% limit (equity $%.2f vs high-water $%.2f) — new entries halted; open positions still managed",
			drawdown*100, g.cfg.DrawdownPct*100, equity, hwm))
	}
	return nil
}

// CoilHaltStatus is the read-only observability snapshot.
type CoilHaltStatus struct {
	Enabled      bool     `json:"enabled"`
	Armed        bool     `json:"armed"`
	BlockReasons []string `json:"block_reasons"`
	EquityUSD    float64  `json:"equity_usd"`
	HighWaterUSD float64  `json:"high_water_usd"`
	DrawdownPct  float64  `json:"drawdown_pct"`
	LimitPct     float64  `json:"limit_pct"`
	BaselineUSD  float64  `json:"baseline_usd"`
}

// Status never places orders, so a read failure is reported as a reason
// rather than an error. Its validity checks mirror EvaluateEntry's exactly
// so this report can never claim Armed:true in a configuration where
// EvaluateEntry would actually block everything (e.g. a misconfigured
// DrawdownPct like 15 instead of 0.15) — including a persist-degraded guard
// (N-1): if EvaluateEntry would block on that alone, Status() must say so
// too, rather than leave the operator staring at a rail that refuses
// everything with no visible reason.
//
// N-2: g.hwmMem and g.persistDegraded are read via snapshotMu() (under
// g.mu) rather than directly, because Status() runs outside the lock
// EvaluateEntry holds while mutating both. Reading them directly here would
// race with EvaluateEntry per the Go memory model. This cannot gate an
// entry either way — Status() never blocks anything — but an unsynchronized
// read could misreport the drawdown or the degraded state to the operator
// watching this rail, which is its whole purpose.
func (g *CoilLiveHaltGuard) Status(ctx context.Context) CoilHaltStatus {
	s := CoilHaltStatus{
		Enabled:     g.cfg.Enabled,
		LimitPct:    g.cfg.DrawdownPct,
		BaselineUSD: g.cfg.BaselineUSD,
	}
	if !g.cfg.Enabled {
		return s
	}
	hwmMemSnapshot, degraded := g.snapshotMu()
	var reasons []string
	if degraded {
		reasons = append(reasons, "cannot persist halt state — degraded (a prior write to StateDir failed; fix StateDir, RECONCILE THE HIGH-WATER MARK against the account's true peak, then restart the process)")
	}
	if g.cfg.BaselineUSD <= 0 {
		reasons = append(reasons, "baseline not configured")
	}
	if g.cfg.DrawdownPct <= 0 || g.cfg.DrawdownPct >= 1 {
		reasons = append(reasons, fmt.Sprintf("invalid drawdown pct %.4f (want 0<pct<1)", g.cfg.DrawdownPct))
	}
	if err := coilStateDirStatable(g.cfg.StateDir); err != nil {
		reasons = append(reasons, fmt.Sprintf("state directory unavailable: %v", err))
	}
	if coilHaltFileExists(g.killPath()) {
		reasons = append(reasons, "manual kill engaged")
	}
	if coilHaltFileExists(g.latchPath()) {
		reasons = append(reasons, "drawdown halt latched")
	}
	if g.reader == nil {
		reasons = append(reasons, "account reader not configured")
	} else if acct, err := g.reader.GetAccount(ctx); err == nil && acct != nil && acct.PortfolioValue > 0 {
		s.EquityUSD = acct.PortfolioValue
		if hwm, hwmErr := g.effectiveHighWater(acct.PortfolioValue, hwmMemSnapshot); hwmErr != nil {
			reasons = append(reasons, "high-water state unreadable")
		} else {
			s.HighWaterUSD = hwm
			if s.HighWaterUSD > 0 {
				s.DrawdownPct = (s.HighWaterUSD - s.EquityUSD) / s.HighWaterUSD
			}
			if s.DrawdownPct >= g.cfg.DrawdownPct {
				reasons = append(reasons, "drawdown limit reached")
			}
		}
	} else {
		reasons = append(reasons, "account unavailable")
	}
	s.BlockReasons = reasons
	s.Armed = len(reasons) == 0
	return s
}
