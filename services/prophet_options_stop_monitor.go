package services

import (
	"context"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/sirupsen/logrus"

	"prophet-trader/interfaces"
	"prophet-trader/models"
)

const (
	prophetStrategyID  = "v2-options"      // LLM order tag (also AgentMain via AgentForStrategy default)
	prophetStopCOIDTag = "v2-options-stop" // distinct prefix so flatten orders never trip the cool-off
)

// --- narrow dependency interfaces (all fakeable in tests) ---

type optionsPositionLister interface {
	ListOptionsPositions(ctx context.Context) ([]*interfaces.OptionsPosition, error)
}

type condorLegLister interface {
	ListOpenHarvestCondors() ([]*models.DBHarvestCondor, error)
}

type optionsQuoter interface {
	GetOptionSnapshot(ctx context.Context, optionSymbol string) (*interfaces.OptionContract, error)
}

type optionsFlattener interface {
	PlaceOptionsOrder(ctx context.Context, order *interfaces.OptionsOrder) (*interfaces.OrderResult, error)
	ListOrders(ctx context.Context, status string) ([]*interfaces.Order, error)
	GetOrder(ctx context.Context, orderID string) (*interfaces.Order, error)
	CancelOrder(ctx context.Context, orderID string) error
}

type rawOwnershipChecker interface {
	HasRawSymbol(agent AgentSource, symbol string) bool
}

type beatObserver interface {
	LastProphetBeat() (time.Time, bool)
}

// ProphetOptionsStopConfig holds the tuning knobs (env-wired in main.go).
type ProphetOptionsStopConfig struct {
	StopPct         float64       // 0.50 → flatten at -50% of premium (since entry)
	Cooloff         time.Duration // suppress flatten if LLM acted on the symbol within this window
	Escalation      time.Duration // wait before escalating rung 0 → rung 1
	SanityFloorFrac float64       // terminal limit floor as a fraction of the fresh mid
}

// stopAttempt tracks the current escalation rung for a symbol within this
// process lifetime. In-memory: resets on restart (rung restarts at 0), which is
// acceptable because the durable double-send guard is the broker working-order
// query, not this map.
type stopAttempt struct {
	rung int
}

// ProphetOptionsStopMonitor flattens the Prophet (v2-options) agent's long
// single-leg options positions past a deep catastrophic loss floor. See
// docs/superpowers/specs/2026-05-21-prophet-options-auto-stop-monitor-design.md.
type ProphetOptionsStopMonitor struct {
	positions optionsPositionLister
	condors   condorLegLister
	quoter    optionsQuoter
	flattener optionsFlattener
	rawOwner  rawOwnershipChecker // optional
	beats     beatObserver        // optional
	logger    *logrus.Logger
	cfg       ProphetOptionsStopConfig
	bootTime  time.Time
	attempts  map[string]stopAttempt
}

func NewProphetOptionsStopMonitor(
	positions optionsPositionLister,
	condors condorLegLister,
	quoter optionsQuoter,
	flattener optionsFlattener,
	cfg ProphetOptionsStopConfig,
) *ProphetOptionsStopMonitor {
	logger := logrus.New()
	logger.SetFormatter(&logrus.TextFormatter{FullTimestamp: true})
	return &ProphetOptionsStopMonitor{
		positions: positions,
		condors:   condors,
		quoter:    quoter,
		flattener: flattener,
		logger:    logger,
		cfg:       cfg,
		bootTime:  time.Now().UTC(),
		attempts:  map[string]stopAttempt{},
	}
}

// SetRawOwnershipChecker wires the read-only guard ownership check used only to
// flag flatten actions taken without a positive ownership record. Optional.
func (m *ProphetOptionsStopMonitor) SetRawOwnershipChecker(c rawOwnershipChecker) { m.rawOwner = c }

// SetBeatObserver wires the beats-observed startup-grace signal. Optional.
func (m *ProphetOptionsStopMonitor) SetBeatObserver(b beatObserver) { m.beats = b }

// SetBootTime overrides the boot time (tests).
func (m *ProphetOptionsStopMonitor) SetBootTime(t time.Time) { m.bootTime = t }

// lossFraction returns the since-entry loss as a positive fraction (0.60 = down
// 60%) and whether it could be computed. Uses UnrealizedPL/CostBasis, NOT the
// position's intraday UnrealizedPLPC field.
func lossFraction(p *interfaces.OptionsPosition) (float64, bool) {
	if p.CostBasis <= 0 {
		return 0, false
	}
	return -p.UnrealizedPL / p.CostBasis, true
}

// prophetPositions returns the long single-leg options positions that belong to
// Prophet — i.e. broker long us_option positions minus every leg of any
// non-CLOSED Harvest condor.
func (m *ProphetOptionsStopMonitor) prophetPositions(ctx context.Context) ([]*interfaces.OptionsPosition, error) {
	all, err := m.positions.ListOptionsPositions(ctx)
	if err != nil {
		return nil, err
	}
	condors, err := m.condors.ListOpenHarvestCondors()
	if err != nil {
		return nil, err // fail the whole tick: cannot scope safely without the exclusion set
	}
	exclude := map[string]struct{}{}
	for _, c := range condors {
		if c.Status == "CLOSED" {
			continue
		}
		for _, leg := range []string{c.ShortPutSymbol, c.LongPutSymbol, c.ShortCallSymbol, c.LongCallSymbol} {
			if leg != "" {
				exclude[leg] = struct{}{}
			}
		}
	}
	var out []*interfaces.OptionsPosition
	for _, p := range all {
		if p.Side != "long" {
			continue
		}
		if _, isLeg := exclude[p.Symbol]; isLeg {
			continue
		}
		out = append(out, p)
	}
	return out, nil
}

// workingFlattenOrder returns the monitor's own still-working sell-to-close
// order for a symbol, if any, from a pre-fetched order list. "Working" = not in
// a terminal state. This is the durable double-send guard: it survives a restart
// because it reads broker state, not in-memory state.
func workingFlattenOrder(symbol string, orders []*interfaces.Order) *interfaces.Order {
	for _, o := range orders {
		if o.Symbol != symbol || o.Side != "sell" {
			continue
		}
		if !strings.HasPrefix(o.ClientOrderID, prophetStopCOIDTag+":") {
			continue
		}
		switch o.Status {
		case "filled", "canceled", "expired", "rejected", "done_for_day", "replaced":
			continue
		}
		return o
	}
	return nil
}

// llmActedRecently reports whether an LLM (v2-options-tagged) order touched the
// symbol within the cool-off window. The monitor's own flatten orders are tagged
// "v2-options-stop" → ParseStrategyFromClientOrderID returns "v2-options-stop",
// not "v2-options", so they never count here. (Wired into EvaluateTick in Task 5.)
func llmActedRecently(symbol string, orders []*interfaces.Order, now time.Time, window time.Duration) bool {
	for _, o := range orders {
		if o.Symbol != symbol {
			continue
		}
		if interfaces.ParseStrategyFromClientOrderID(o.ClientOrderID) != prophetStrategyID {
			continue
		}
		if now.Sub(o.SubmittedAt) <= window {
			return true
		}
	}
	return false
}

// roundCents rounds a price to the nearest cent (2 decimal places). Options
// exchanges quote and accept prices in whole cents, so all limit prices are
// rounded before submission.
func roundCents(v float64) float64 {
	return math.Round(v*100) / 100
}

// flattenLimit returns the limit price for a rung given a fresh quote. Rung 0 is
// a marketable limit at the bid; rung 1+ is the sanity floor (sweeps all
// liquidity at/above the floor, rests at it, never sells below it).
// mid is (bid+ask)/2; both bid and mid are rounded to cents before use.
func (m *ProphetOptionsStopMonitor) flattenLimit(rung int, bid, mid float64) float64 {
	floor := roundCents(m.cfg.SanityFloorFrac * mid)
	if rung == 0 && bid > 0 {
		return roundCents(bid)
	}
	return floor
}

// placeFlatten places a sell-to-close at the given rung/qty with a uniquely
// tagged client_order_id, and records the rung in-memory.
// bid is the current bid; mid is (bid+ask)/2 used for the sanity floor.
func (m *ProphetOptionsStopMonitor) placeFlatten(ctx context.Context, symbol string, qty float64, rung int, bid, mid float64, now time.Time) {
	limit := m.flattenLimit(rung, bid, mid)
	coid := fmt.Sprintf("%s:%s:%d", prophetStopCOIDTag, symbol, now.UnixNano())
	order := &interfaces.OptionsOrder{
		Symbol:         symbol,
		Qty:            qty,
		Side:           "sell",
		PositionIntent: "sell_to_close",
		Type:           "limit",
		TimeInForce:    "day",
		LimitPrice:     &limit,
		ClientOrderID:  coid, // distinct prefix; honored by PlaceOptionsOrder (Task 1)
	}
	if m.rawOwner != nil && !m.rawOwner.HasRawSymbol(AgentMain, symbol) {
		m.logger.WithField("symbol", symbol).Warn("prophet_options_stop_unattributed")
	}
	if _, err := m.flattener.PlaceOptionsOrder(ctx, order); err != nil {
		m.logger.WithError(err).WithField("symbol", symbol).Error("prophet_options_stop: place failed")
		return
	}
	m.attempts[symbol] = stopAttempt{rung: rung}
	m.logger.WithFields(logrus.Fields{
		"symbol": symbol, "rung": rung, "qty": qty, "limit": limit,
	}).Warn("prophet_options_stop_flattened")
}

// flatten handles one triggered position: idempotency, escalation, placement.
func (m *ProphetOptionsStopMonitor) flatten(ctx context.Context, p *interfaces.OptionsPosition, orders []*interfaces.Order, now time.Time) {
	snap, err := m.quoter.GetOptionSnapshot(ctx, p.Symbol)
	if err != nil || snap == nil || (snap.Bid <= 0 && snap.Ask <= 0) {
		m.logger.WithField("symbol", p.Symbol).Warn("prophet_options_stop: no quote; skipping")
		return
	}

	working := workingFlattenOrder(p.Symbol, orders)
	if working != nil {
		if now.Sub(working.SubmittedAt) < m.cfg.Escalation {
			return // still inside the escalation window
		}
		// Escalate: cancel-confirm-before-replace.
		if err := m.flattener.CancelOrder(ctx, working.ID); err != nil {
			m.logger.WithError(err).WithField("symbol", p.Symbol).Error("prophet_options_stop: cancel failed")
			return
		}
		confirmed, err := m.flattener.GetOrder(ctx, working.ID)
		if err != nil || confirmed == nil || (confirmed.Status != "canceled" && confirmed.Status != "filled") {
			m.logger.WithField("symbol", p.Symbol).Warn("prophet_options_stop: cancel not yet confirmed; will retry next tick")
			return
		}
		if confirmed.Status == "filled" {
			return // nothing left to escalate
		}
		// Options trade in whole contracts; round to guard against a
		// floating-point fill-qty artifact leaving a fractional residual that
		// the broker would truncate (stranding a contract).
		remaining := math.Round(absQty(p.Qty) - confirmed.FilledQty)
		if remaining <= 0 {
			return
		}
		nextRung := m.attempts[p.Symbol].rung + 1
		m.logger.WithFields(logrus.Fields{"symbol": p.Symbol, "rung": nextRung}).Warn("prophet_options_stop_escalated")
		m.placeFlatten(ctx, p.Symbol, remaining, nextRung, snap.Bid, snap.Premium, now)
		return
	}

	// No working order → fresh placement at rung 0 for the full position qty.
	m.placeFlatten(ctx, p.Symbol, absQty(p.Qty), 0, snap.Bid, snap.Premium, now)
}

func absQty(q float64) float64 {
	if q < 0 {
		return -q
	}
	return q
}

// graceSatisfied reports whether the beats-observed startup grace has elapsed:
// Prophet has taken a beat since the monitor booted. When no beat observer is
// wired, grace is off (returns true) so the monitor is never permanently
// dormant — the wall-clock fallback (if ever needed) lives in main.go wiring.
func (m *ProphetOptionsStopMonitor) graceSatisfied() bool {
	if m.beats == nil {
		return true
	}
	last, ok := m.beats.LastProphetBeat()
	return ok && last.After(m.bootTime)
}

// Start runs the monitor's tick loop: every `interval` while marketIsOpen()
// reports true, else sleeps `idleInterval`. Returns when ctx is canceled.
// Launch as `go monitor.Start(...)` from main.go.
func (m *ProphetOptionsStopMonitor) Start(ctx context.Context, interval, idleInterval time.Duration, marketIsOpen func() bool) {
	timer := time.NewTimer(interval)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			if marketIsOpen() {
				m.EvaluateTick(ctx, time.Now().UTC())
				timer.Reset(interval)
			} else {
				timer.Reset(idleInterval)
			}
		}
	}
}

func (m *ProphetOptionsStopMonitor) EvaluateTick(ctx context.Context, now time.Time) {
	// Beats-observed startup grace is a monitor-global condition (has Prophet
	// beaten since boot?), so gate the whole tick here rather than per position —
	// one log, no redundant re-checks, and no broker fetches while dormant.
	if !m.graceSatisfied() {
		m.logger.Warn("prophet_options_stop_grace_suppressed")
		return
	}
	positions, err := m.prophetPositions(ctx)
	if err != nil {
		m.logger.WithError(err).Warn("prophet_options_stop: scoping failed; skipping tick")
		return
	}
	orders, err := m.flattener.ListOrders(ctx, "all")
	if err != nil {
		m.logger.WithError(err).Warn("prophet_options_stop: list orders failed; skipping tick")
		return
	}
	for _, p := range positions {
		frac, ok := lossFraction(p)
		if !ok {
			m.logger.WithField("symbol", p.Symbol).Warn("prophet_options_stop_no_basis")
			continue
		}
		if frac < m.cfg.StopPct {
			delete(m.attempts, p.Symbol) // recovered above floor; reset rung
			continue
		}
		m.logger.WithFields(logrus.Fields{
			"symbol": p.Symbol, "loss_fraction": frac, "stop_pct": m.cfg.StopPct,
		}).Warn("prophet_options_stop_triggered")
		if llmActedRecently(p.Symbol, orders, now, m.cfg.Cooloff) {
			m.logger.WithField("symbol", p.Symbol).Warn("prophet_options_stop_cooloff_suppressed")
			continue
		}
		m.flatten(ctx, p, orders, now)
	}
}
