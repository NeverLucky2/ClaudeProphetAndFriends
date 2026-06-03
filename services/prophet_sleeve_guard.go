package services

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"prophet-trader/interfaces"

	"github.com/sirupsen/logrus"
)

const (
	sleeveKillFileName   = "KILL_PROPHET_SLEEVE"
	sleeveLatchFileName  = "sleeve_disarm.json"
	sleevePDTEquityFloor = 25000.0
	sleevePDTDayTradeMax = 3
)

// SleeveAccountReader is the narrow broker-read surface the sleeve guard needs.
// interfaces.TradingService satisfies it.
type SleeveAccountReader interface {
	GetAccount(ctx context.Context) (*interfaces.Account, error)
	ListOptionsPositions(ctx context.Context) ([]*interfaces.OptionsPosition, error)
	GetPositions(ctx context.Context) ([]*interfaces.Position, error)
}

// ProphetSleeveConfig holds the live fun-sleeve safety-gate parameters.
type ProphetSleeveConfig struct {
	Enabled         bool
	BaselineUSD     float64
	MaxPositionFrac float64
	MaxPositions    int
	LossBudgetFrac  float64
	Deadline        string // YYYY-MM-DD; empty/invalid => fail closed when enabled
	DisarmDir       string
}

// ProphetSleeveGuard enforces the dedicated-account fun-sleeve caps and disarms.
// FAILS CLOSED: any uncertainty (missing config, unreadable account, present latch)
// blocks the open. Invoked ONLY on opening options buys, so closes/exits are never blocked.
type ProphetSleeveGuard struct {
	cfg    ProphetSleeveConfig
	reader SleeveAccountReader
	logger *logrus.Logger
}

// NewProphetSleeveGuard constructs the guard.
func NewProphetSleeveGuard(cfg ProphetSleeveConfig, reader SleeveAccountReader) *ProphetSleeveGuard {
	logger := logrus.New()
	logger.SetFormatter(&logrus.TextFormatter{FullTimestamp: true})
	return &ProphetSleeveGuard{cfg: cfg, reader: reader, logger: logger}
}

func (g *ProphetSleeveGuard) killPath() string {
	return filepath.Join(g.cfg.DisarmDir, sleeveKillFileName)
}
func (g *ProphetSleeveGuard) latchPath() string {
	return filepath.Join(g.cfg.DisarmDir, sleeveLatchFileName)
}

func sleeveFileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func (g *ProphetSleeveGuard) block(reason string) error {
	g.logger.WithFields(logrus.Fields{"prophet_sleeve_block": true, "reason": reason}).
		Warn("Prophet sleeve gate blocked an open")
	return fmt.Errorf("prophet sleeve: %s", reason)
}

// checkDeadline is a PURE predicate (no logging): it returns a descriptive error
// when the deadline is empty, unparseable, or on/after the day AFTER the deadline
// date (the deadline is inclusive end-of-day), else nil. Callers decide whether to
// log. This lets the read-only Status() consult it without emitting a "blocked an
// open" warning.
func (g *ProphetSleeveGuard) checkDeadline(now time.Time) error {
	if g.cfg.Deadline == "" {
		return fmt.Errorf("no off-ramp deadline configured (PROPHET_SLEEVE_DEADLINE)")
	}
	d, err := time.Parse("2006-01-02", g.cfg.Deadline)
	if err != nil {
		return fmt.Errorf("invalid deadline %q (want YYYY-MM-DD)", g.cfg.Deadline)
	}
	if !now.Before(d.AddDate(0, 0, 1)) {
		return fmt.Errorf("past off-ramp deadline %s", g.cfg.Deadline)
	}
	return nil
}

// EvaluateOpen returns an error (blocking the open) or nil (allow). No-op when disabled.
// newPremium is the dollar premium outlay of the proposed open (= max loss on a long option).
func (g *ProphetSleeveGuard) EvaluateOpen(ctx context.Context, newPremium float64, now time.Time) error {
	if !g.cfg.Enabled {
		return nil
	}
	if g.cfg.BaselineUSD <= 0 {
		return g.block("baseline not configured (PROPHET_SLEEVE_BASELINE_USD<=0)")
	}
	if err := g.checkDeadline(now); err != nil {
		return g.block(err.Error())
	}
	if sleeveFileExists(g.killPath()) {
		return g.block("manual kill switch engaged")
	}
	if sleeveFileExists(g.latchPath()) {
		return g.block("loss-budget disarm latched")
	}
	m, err := g.computeMetrics(ctx)
	if err != nil {
		return g.block(fmt.Sprintf("account/positions unavailable (fail closed): %v", err))
	}
	if m.dayTradeCount >= sleevePDTDayTradeMax && m.equity < sleevePDTEquityFloor {
		return g.block(fmt.Sprintf("PDT backstop: day_trade_count=%d, equity=$%.2f < $%.0f",
			m.dayTradeCount, m.equity, sleevePDTEquityFloor))
	}
	if m.realizedLoss >= g.cfg.LossBudgetFrac*g.cfg.BaselineUSD {
		g.tripLossLatch(m.realizedLoss)
		return g.block(fmt.Sprintf("loss budget reached: realized loss $%.2f >= $%.2f",
			m.realizedLoss, g.cfg.LossBudgetFrac*g.cfg.BaselineUSD))
	}
	if newPremium > g.cfg.MaxPositionFrac*g.cfg.BaselineUSD {
		return g.block(fmt.Sprintf("per-position cap: $%.2f > $%.2f (%.0f%% of baseline)",
			newPremium, g.cfg.MaxPositionFrac*g.cfg.BaselineUSD, g.cfg.MaxPositionFrac*100))
	}
	if m.openCount >= g.cfg.MaxPositions {
		return g.block(fmt.Sprintf("concurrency cap: %d open >= %d max", m.openCount, g.cfg.MaxPositions))
	}
	available := g.cfg.BaselineUSD - m.realizedLoss
	if m.deployed+newPremium > available {
		return g.block(fmt.Sprintf("exposure cap: deployed $%.2f + new $%.2f > available $%.2f",
			m.deployed, newPremium, available))
	}
	return nil
}

// sleeveMetrics is the broker-derived snapshot used by the caps + loss budget.
type sleeveMetrics struct {
	equity        float64
	deployed      float64 // Σ CostBasis of open option positions (premium at risk)
	unrealized    float64 // Σ UnrealizedPL across open positions (options + equity)
	realizedLoss  float64 // max(0, B - equity + unrealized); see spec §6.1
	openCount     int
	dayTradeCount int
}

func (g *ProphetSleeveGuard) computeMetrics(ctx context.Context) (sleeveMetrics, error) {
	var m sleeveMetrics
	acct, err := g.reader.GetAccount(ctx)
	if err != nil {
		return m, fmt.Errorf("get account: %w", err)
	}
	if acct == nil {
		return m, fmt.Errorf("nil account")
	}
	optPos, err := g.reader.ListOptionsPositions(ctx)
	if err != nil {
		return m, fmt.Errorf("list options positions: %w", err)
	}
	eqPos, err := g.reader.GetPositions(ctx)
	if err != nil {
		return m, fmt.Errorf("get positions: %w", err)
	}
	m.equity = acct.PortfolioValue
	m.dayTradeCount = acct.DayTradeCount
	for _, p := range optPos {
		m.deployed += p.CostBasis
		m.unrealized += p.UnrealizedPL
		m.openCount++
	}
	for _, p := range eqPos {
		m.unrealized += p.UnrealizedPL
	}
	if realizedPnl := m.equity - g.cfg.BaselineUSD - m.unrealized; realizedPnl < 0 {
		m.realizedLoss = -realizedPnl
	}
	return m, nil
}

// sleeveLatch is the JSON payload written to the kill/disarm files.
type sleeveLatch struct {
	Reason       string    `json:"reason"`
	EngagedAt    time.Time `json:"engaged_at"`
	RealizedLoss float64   `json:"realized_loss,omitempty"`
	Baseline     float64   `json:"baseline"`
}

// tripLossLatch writes the loss-budget disarm file once (idempotent). The file's
// presence is what permanently blocks future opens (read in EvaluateOpen), so the
// disarm survives restart and re-arms only by deliberate file deletion.
func (g *ProphetSleeveGuard) tripLossLatch(realizedLoss float64) {
	if sleeveFileExists(g.latchPath()) {
		return
	}
	if err := os.MkdirAll(g.cfg.DisarmDir, 0o755); err != nil {
		g.logger.WithError(err).Error("prophet sleeve: cannot create disarm dir for loss latch")
		return
	}
	b, _ := json.MarshalIndent(sleeveLatch{
		Reason:       "loss budget reached",
		EngagedAt:    time.Now().UTC(),
		RealizedLoss: realizedLoss,
		Baseline:     g.cfg.BaselineUSD,
	}, "", "  ")
	if err := os.WriteFile(g.latchPath(), b, 0o644); err != nil {
		g.logger.WithError(err).Error("prophet sleeve: failed to write loss-budget latch")
	}
}

// SleeveStatus is the read-only teaching/observability snapshot.
type SleeveStatus struct {
	Enabled        bool     `json:"enabled"`
	Armed          bool     `json:"armed"`
	DisarmReasons  []string `json:"disarm_reasons"`
	BaselineUSD    float64  `json:"baseline_usd"`
	AvailableUSD   float64  `json:"available_usd"`
	DeployedUSD    float64  `json:"deployed_usd"`
	RealizedLoss   float64  `json:"realized_loss_usd"`
	LossBudgetUSD  float64  `json:"loss_budget_usd"`
	OpenCount      int      `json:"open_count"`
	MaxPositions   int      `json:"max_positions"`
	Deadline       string   `json:"deadline"`
	DaysToDeadline int      `json:"days_to_deadline"`
}

// Status returns a read-only snapshot. Best-effort: a metrics-read failure is
// reported as a disarm reason rather than an error (this never places orders).
func (g *ProphetSleeveGuard) Status(ctx context.Context, now time.Time) SleeveStatus {
	s := SleeveStatus{
		Enabled:       g.cfg.Enabled,
		BaselineUSD:   g.cfg.BaselineUSD,
		LossBudgetUSD: g.cfg.LossBudgetFrac * g.cfg.BaselineUSD,
		MaxPositions:  g.cfg.MaxPositions,
		Deadline:      g.cfg.Deadline,
	}
	if !g.cfg.Enabled {
		return s
	}
	var reasons []string
	if g.cfg.BaselineUSD <= 0 {
		reasons = append(reasons, "baseline not configured")
	}
	if g.checkDeadline(now) != nil {
		reasons = append(reasons, "deadline")
	}
	if d, err := time.Parse("2006-01-02", g.cfg.Deadline); err == nil {
		s.DaysToDeadline = int(d.AddDate(0, 0, 1).Sub(now).Hours() / 24)
	}
	if sleeveFileExists(g.killPath()) {
		reasons = append(reasons, "manual kill engaged")
	}
	if sleeveFileExists(g.latchPath()) {
		reasons = append(reasons, "loss-budget latched")
	}
	if m, err := g.computeMetrics(ctx); err == nil {
		s.DeployedUSD = m.deployed
		s.RealizedLoss = m.realizedLoss
		s.OpenCount = m.openCount
		s.AvailableUSD = g.cfg.BaselineUSD - m.realizedLoss
		if m.realizedLoss >= g.cfg.LossBudgetFrac*g.cfg.BaselineUSD {
			reasons = append(reasons, "loss budget reached")
		}
	} else {
		reasons = append(reasons, "metrics unavailable")
	}
	s.DisarmReasons = reasons
	s.Armed = len(reasons) == 0
	return s
}

// EngageManualKill writes the kill-flag file (idempotent). Called by the
// POST /sleeve/kill handler and equivalent to the operator touching the file.
// There is intentionally NO programmatic re-arm — re-arming is file deletion only.
func (g *ProphetSleeveGuard) EngageManualKill(reason string) error {
	if reason == "" {
		reason = "manual kill"
	}
	if err := os.MkdirAll(g.cfg.DisarmDir, 0o755); err != nil {
		return fmt.Errorf("create disarm dir: %w", err)
	}
	b, _ := json.MarshalIndent(sleeveLatch{
		Reason:    reason,
		EngagedAt: time.Now().UTC(),
		Baseline:  g.cfg.BaselineUSD,
	}, "", "  ")
	return os.WriteFile(g.killPath(), b, 0o644)
}
