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
// kill/latch file, or an unreadable/corrupt/zero-valued high-water state
// file all block the entry. Consulted only from TradeGuard.CheckBuy, so
// exits are never blocked.
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
type CoilLiveHaltGuard struct {
	cfg    CoilLiveHaltConfig
	reader HaltAccountReader
	logger *logrus.Logger

	mu sync.Mutex
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
// ratcheting), so there is no drawdown to protect against on this entry. A
// lost ratchet only matters on a LATER call — effectiveHighWater's baseline
// floor bounds, but does not eliminate, how far the mark can fall as a
// result. See the effectiveHighWater doc comment.
func (g *CoilLiveHaltGuard) writeHighWater(v float64) {
	b, err := json.MarshalIndent(highWaterState{HighWaterUSD: v, UpdatedAt: time.Now().UTC()}, "", "  ")
	if err != nil {
		g.logger.WithError(err).Error("coil live halt: failed to marshal high-water mark")
		return
	}
	if err := atomicWriteFile(g.cfg.StateDir, g.statePath(), b, 0o644); err != nil {
		g.logger.WithError(err).Error("coil live halt: failed to persist high-water mark")
	}
}

// effectiveHighWater is max(baseline, persisted, equity).
//
// Honest limitation: the baseline floor BOUNDS how far a lost/reset
// high-water mark can fall — it does NOT make losing the state file safe in
// general. It is only a no-op when equity is already at or below the
// baseline. If the true peak was above the baseline (the normal case in any
// drawdown that started from a real peak), losing the file resets the mark
// down to CURRENT EQUITY, not to the true peak. Example: true peak $14,000,
// baseline $10,000, equity now $12,000 — delete the state file and the mark
// becomes $12,000, so the halt fires at $10,200 instead of the correct
// $11,900 it would have fired at against the true peak. The floor prevents
// the mark from falling BELOW the baseline; it does not preserve the peak
// above it. Operators must NOT delete coilHaltStateFileName. Only the latch
// file (coilHaltLatchFileName) is meant to be deleted, and only deliberately,
// to re-arm after a reviewed halt.
//
// A corrupt or unreadable state file is a DIFFERENT case and is not floored
// here at all: readPersistedHighWater reports it as an error and
// EvaluateEntry fails closed (blocks) rather than silently treating it as an
// absent file.
func (g *CoilLiveHaltGuard) effectiveHighWater(equity float64) (float64, error) {
	persisted, _, err := g.readPersistedHighWater()
	if err != nil {
		return 0, err
	}
	return math.Max(g.cfg.BaselineUSD, math.Max(persisted, equity)), nil
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
		return g.fallbackKillFile(fmt.Errorf("failed to marshal halt latch: %w", err))
	}
	if err := atomicWriteFile(g.cfg.StateDir, g.latchPath(), b, 0o644); err != nil {
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
func (g *CoilLiveHaltGuard) fallbackKillFile(latchErr error) error {
	b, _ := json.MarshalIndent(struct {
		Reason    string    `json:"reason"`
		EngagedAt time.Time `json:"engaged_at"`
	}{
		Reason:    "latch write failed; kill-file fallback engaged",
		EngagedAt: time.Now().UTC(),
	}, "", "  ")
	if err := atomicWriteFile(g.cfg.StateDir, g.killPath(), b, 0o644); err != nil {
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
	hwm, hwmErr := g.effectiveHighWater(equity)
	if hwmErr != nil {
		return g.block(fmt.Sprintf("high-water state unreadable or corrupt (fail closed): %v", hwmErr))
	}
	if equity >= hwm {
		g.writeHighWater(equity) // ratchet up
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
// DrawdownPct like 15 instead of 0.15).
func (g *CoilLiveHaltGuard) Status(ctx context.Context) CoilHaltStatus {
	s := CoilHaltStatus{
		Enabled:     g.cfg.Enabled,
		LimitPct:    g.cfg.DrawdownPct,
		BaselineUSD: g.cfg.BaselineUSD,
	}
	if !g.cfg.Enabled {
		return s
	}
	var reasons []string
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
		if hwm, hwmErr := g.effectiveHighWater(acct.PortfolioValue); hwmErr != nil {
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
