package services

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
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
// FAILS CLOSED: missing baseline, unreadable account, or a present latch blocks
// the entry. Consulted only from TradeGuard.CheckBuy, so exits are never blocked.
//
// Re-arm is deliberate: delete the latch file. There is intentionally no
// programmatic re-arm.
type CoilLiveHaltGuard struct {
	cfg    CoilLiveHaltConfig
	reader HaltAccountReader
	logger *logrus.Logger
}

func NewCoilLiveHaltGuard(cfg CoilLiveHaltConfig, reader HaltAccountReader) *CoilLiveHaltGuard {
	logger := logrus.New()
	logger.SetFormatter(&logrus.TextFormatter{FullTimestamp: true})
	return &CoilLiveHaltGuard{cfg: cfg, reader: reader, logger: logger}
}

func (g *CoilLiveHaltGuard) killPath() string  { return filepath.Join(g.cfg.StateDir, coilHaltKillFileName) }
func (g *CoilLiveHaltGuard) latchPath() string { return filepath.Join(g.cfg.StateDir, coilHaltLatchFileName) }
func (g *CoilLiveHaltGuard) statePath() string { return filepath.Join(g.cfg.StateDir, coilHaltStateFileName) }

func coilHaltFileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
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

func (g *CoilLiveHaltGuard) readPersistedHighWater() float64 {
	b, err := os.ReadFile(g.statePath())
	if err != nil {
		return 0 // absent/unreadable -> baseline floors it; never fails open
	}
	var s highWaterState
	if json.Unmarshal(b, &s) != nil {
		return 0
	}
	return s.HighWaterUSD
}

func (g *CoilLiveHaltGuard) writeHighWater(v float64) {
	if err := os.MkdirAll(g.cfg.StateDir, 0o755); err != nil {
		g.logger.WithError(err).Error("coil live halt: cannot create state dir")
		return
	}
	b, _ := json.MarshalIndent(highWaterState{HighWaterUSD: v, UpdatedAt: time.Now().UTC()}, "", "  ")
	if err := os.WriteFile(g.statePath(), b, 0o644); err != nil {
		g.logger.WithError(err).Error("coil live halt: failed to persist high-water mark")
	}
}

// effectiveHighWater is max(baseline, persisted, equity). Flooring at the
// funded baseline is what makes a lost state file safe: without it, a file lost
// mid-drawdown would reset the mark down to current equity and the halt would
// never fire.
func (g *CoilLiveHaltGuard) effectiveHighWater(equity float64) float64 {
	return math.Max(g.cfg.BaselineUSD, math.Max(g.readPersistedHighWater(), equity))
}

type coilHaltLatch struct {
	Reason       string    `json:"reason"`
	EngagedAt    time.Time `json:"engaged_at"`
	EquityUSD    float64   `json:"equity_usd"`
	HighWaterUSD float64   `json:"high_water_usd"`
	DrawdownPct  float64   `json:"drawdown_pct"`
}

func (g *CoilLiveHaltGuard) tripLatch(equity, hwm, dd float64) {
	if coilHaltFileExists(g.latchPath()) {
		return
	}
	if err := os.MkdirAll(g.cfg.StateDir, 0o755); err != nil {
		g.logger.WithError(err).Error("coil live halt: cannot create state dir for latch")
		return
	}
	b, _ := json.MarshalIndent(coilHaltLatch{
		Reason:       "high-water drawdown halt",
		EngagedAt:    time.Now().UTC(),
		EquityUSD:    equity,
		HighWaterUSD: hwm,
		DrawdownPct:  dd,
	}, "", "  ")
	if err := os.WriteFile(g.latchPath(), b, 0o644); err != nil {
		g.logger.WithError(err).Error("coil live halt: failed to write halt latch")
	}
}

// EvaluateEntry returns nil to allow a new entry, or an error to block it.
func (g *CoilLiveHaltGuard) EvaluateEntry(ctx context.Context) error {
	if !g.cfg.Enabled {
		return nil
	}
	if g.cfg.BaselineUSD <= 0 {
		return g.block("baseline not configured (COIL_LIVE_BASELINE_USD<=0)")
	}
	if g.cfg.DrawdownPct <= 0 || g.cfg.DrawdownPct >= 1 {
		return g.block(fmt.Sprintf("invalid drawdown pct %.4f (want 0<pct<1)", g.cfg.DrawdownPct))
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
	hwm := g.effectiveHighWater(equity)
	if equity >= hwm {
		g.writeHighWater(equity) // ratchet up
		return nil
	}

	drawdown := (hwm - equity) / hwm
	if drawdown >= g.cfg.DrawdownPct {
		g.tripLatch(equity, hwm, drawdown)
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

// Status never places orders, so a read failure is reported as a reason rather
// than an error.
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
	if coilHaltFileExists(g.killPath()) {
		reasons = append(reasons, "manual kill engaged")
	}
	if coilHaltFileExists(g.latchPath()) {
		reasons = append(reasons, "drawdown halt latched")
	}
	if acct, err := g.reader.GetAccount(ctx); err == nil && acct != nil && acct.PortfolioValue > 0 {
		s.EquityUSD = acct.PortfolioValue
		s.HighWaterUSD = g.effectiveHighWater(acct.PortfolioValue)
		if s.HighWaterUSD > 0 {
			s.DrawdownPct = (s.HighWaterUSD - s.EquityUSD) / s.HighWaterUSD
		}
		if s.DrawdownPct >= g.cfg.DrawdownPct {
			reasons = append(reasons, "drawdown limit reached")
		}
	} else {
		reasons = append(reasons, "account unavailable")
	}
	s.BlockReasons = reasons
	s.Armed = len(reasons) == 0
	return s
}
