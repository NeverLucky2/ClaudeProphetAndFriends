package services

import (
	"context"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/sirupsen/logrus"

	"prophet-trader/interfaces"
)

const (
	prophetStrategyID  = "v2-options"      // LLM order tag (also AgentMain via AgentForStrategy default)
	prophetStopCOIDTag = "v2-options-stop" // distinct prefix so flatten orders never trip the cool-off
)

// --- narrow dependency interfaces (all fakeable in tests) ---

type optionsPositionLister interface {
	ListOptionsPositions(ctx context.Context) ([]*interfaces.OptionsPosition, error)
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

	// Stuck-exit escalation (independent of P&L): when the LLM repeatedly places
	// non-marketable sell limits that cancel unfilled, the monitor takes over and
	// crosses the spread with a marketable flatten. This catches the thesis-broken
	// WINNER that the loss-stop never fires on. Default OFF.
	StuckExitEnabled     bool
	StuckExitWindow      time.Duration // lookback for counting LLM canceled-unfilled sells
	StuckExitMinReprices int           // ≥ this many unfilled cancels in the window → stuck
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
	quoter optionsQuoter,
	flattener optionsFlattener,
	cfg ProphetOptionsStopConfig,
) *ProphetOptionsStopMonitor {
	logger := logrus.New()
	logger.SetFormatter(&logrus.TextFormatter{FullTimestamp: true})
	return &ProphetOptionsStopMonitor{
		positions: positions,
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

// isExecutedBuy reports whether o is a buy that actually acquired contracts:
// any positive filled qty, or a filled/partially_filled status (real broker
// fills always carry both; some fixtures set only the status). Working/unfilled
// buys do not count.
func isExecutedBuy(o *interfaces.Order) bool {
	if o.Side != "buy" {
		return false
	}
	return o.FilledQty > 0 || o.Status == "filled" || o.Status == "partially_filled"
}

// attributedToProphetSingleLeg reports whether symbol is positively attributable
// to Prophet's v2-options single-leg strategy: among executed buys for the exact
// OCC contract, at least one is tagged v2-options and none is tagged anything
// else. Fails closed when no executed buy is found (aged out / sells only) and
// when any other-tagged buy contaminates ownership (manual, v2-vertical,
// prophet-defensive, …). Prophet single-leg never buys-to-close, so a v2-options
// buy is always an open.
func attributedToProphetSingleLeg(symbol string, orders []*interfaces.Order) bool {
	sawV2Options := false
	for _, o := range orders {
		if o.Symbol != symbol || !isExecutedBuy(o) {
			continue
		}
		if interfaces.ParseStrategyFromClientOrderID(o.ClientOrderID) == prophetStrategyID {
			sawV2Options = true
		} else {
			return false
		}
	}
	return sawV2Options
}

// hasPairedShort reports whether the account holds a short option leg on the
// same (underlying, expiration, option-type) as longSymbol — i.e. longSymbol is
// the long leg of a vertical/spread. Only a positively-parsed, positively-
// matched short returns true; an unparseable symbol on either side contributes
// no pairing (Gate C must add a skip only on a positively found pair, never on
// uncertainty).
func hasPairedShort(longSymbol string, all []*interfaces.OptionsPosition) bool {
	lu, le, lt, ok := ParseOCC(longSymbol)
	if !ok {
		return false
	}
	for _, p := range all {
		if p.Side != "short" {
			continue
		}
		if su, se, st, ok := ParseOCC(p.Symbol); ok && su == lu && se == le && st == lt {
			return true
		}
	}
	return false
}

// scopeEligibleLongs returns the long single-leg positions the monitor may
// flatten: those positively attributed to Prophet's v2-options strategy
// (Gate A) that are not the long leg of a spread (Gate C). Shorts are never
// eligible. A long dropped while already past the stop threshold is logged once
// (skipped_unowned, naming the gate) so the monitor visibly declines a
// non-Prophet / spread leg and a systemic attribution failure stays observable.
func (m *ProphetOptionsStopMonitor) scopeEligibleLongs(all []*interfaces.OptionsPosition, orders []*interfaces.Order) []*interfaces.OptionsPosition {
	var out []*interfaces.OptionsPosition
	for _, p := range all {
		if p.Side != "long" {
			continue
		}
		gate := ""
		switch {
		case !attributedToProphetSingleLeg(p.Symbol, orders):
			gate = "A:attribution"
		case hasPairedShort(p.Symbol, all):
			gate = "C:paired-short"
		}
		if gate != "" {
			if frac, ok := lossFraction(p); ok && frac >= m.cfg.StopPct {
				m.logger.WithFields(logrus.Fields{
					"symbol": p.Symbol, "gate": gate, "loss_fraction": frac,
				}).Warn("prophet_options_stop_skipped_unowned")
			}
			continue
		}
		out = append(out, p)
	}
	return out
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
	orders, err := m.flattener.ListOrders(ctx, "all")
	if err != nil {
		m.logger.WithError(err).Warn("prophet_options_stop: list orders failed; skipping tick")
		return
	}
	all, err := m.positions.ListOptionsPositions(ctx)
	if err != nil {
		m.logger.WithError(err).Warn("prophet_options_stop: scoping failed; skipping tick")
		return
	}
	positions := m.scopeEligibleLongs(all, orders)
	for _, p := range positions {
		frac, ok := lossFraction(p)
		if !ok {
			m.logger.WithField("symbol", p.Symbol).Warn("prophet_options_stop_no_basis")
			continue
		}
		if frac >= m.cfg.StopPct {
			// Catastrophic-loss flatten (cool-off-guarded so the LLM can act first).
			m.logger.WithFields(logrus.Fields{
				"symbol": p.Symbol, "loss_fraction": frac, "stop_pct": m.cfg.StopPct,
			}).Warn("prophet_options_stop_triggered")
			if llmActedRecently(p.Symbol, orders, now, m.cfg.Cooloff) {
				m.logger.WithField("symbol", p.Symbol).Warn("prophet_options_stop_cooloff_suppressed")
				continue
			}
			m.flatten(ctx, p, orders, now)
			continue
		}
		// Not a catastrophic loss. Take over only if the LLM is stuck
		// cancel-replacing an exit it can't fill — the thesis-broken WINNER the
		// loss-stop never sees. Unlike the loss path there is NO cool-off: the
		// whole point is that the LLM IS acting and failing.
		if m.cfg.StuckExitEnabled &&
			llmExitStuck(p.Symbol, orders, now, m.cfg.StuckExitWindow, m.cfg.StuckExitMinReprices) {
			m.logger.WithFields(logrus.Fields{
				"symbol": p.Symbol, "window": m.cfg.StuckExitWindow.String(),
				"min_reprices": m.cfg.StuckExitMinReprices,
			}).Warn("prophet_options_stuck_exit_triggered")
			m.flattenStuckExit(ctx, p, orders, now)
			continue
		}
		delete(m.attempts, p.Symbol) // nothing to do; reset rung
	}
}

// llmExitStuck reports whether the LLM (v2-options) is stuck cancel-replacing a
// sell it cannot fill on this symbol: at least minReprices of its sell orders in
// the window terminated unfilled. Any recent LLM sell that took a fill means it
// is making progress → not stuck. The monitor's own flatten orders are tagged
// "v2-options-stop" (ParseStrategy != "v2-options"), so they never count here.
func llmExitStuck(symbol string, orders []*interfaces.Order, now time.Time, window time.Duration, minReprices int) bool {
	if minReprices <= 0 {
		return false // misconfigured / disabled: never fire on a zero threshold
	}
	unfilled := 0
	for _, o := range orders {
		if o.Symbol != symbol || o.Side != "sell" {
			continue
		}
		if interfaces.ParseStrategyFromClientOrderID(o.ClientOrderID) != prophetStrategyID {
			continue
		}
		if now.Sub(o.SubmittedAt) > window {
			continue
		}
		if o.FilledQty > 0 {
			return false // making progress on the exit → not stuck
		}
		switch o.Status {
		case "canceled", "expired", "done_for_day":
			unfilled++
		}
	}
	return unfilled >= minReprices
}

// workingLLMSell returns the LLM's (v2-options) currently-working sell order for
// the symbol, if any. Such an order holds the position's qty and would make a
// fresh monitor flatten fail with insufficient-qty on the shared account, so it
// must be canceled before the monitor takes over.
func workingLLMSell(symbol string, orders []*interfaces.Order) *interfaces.Order {
	for _, o := range orders {
		if o.Symbol != symbol || o.Side != "sell" {
			continue
		}
		if interfaces.ParseStrategyFromClientOrderID(o.ClientOrderID) != prophetStrategyID {
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

// flattenStuckExit takes over a stuck LLM exit. If the monitor already owns a
// working flatten, the standard escalation path handles it. Otherwise it cancels
// any working LLM sell first (cancel-confirm-before-replace — the order holds the
// qty and would otherwise collide on the shared account), then crosses the spread
// with a marketable flatten via the same rung-0 path the loss-stop uses.
func (m *ProphetOptionsStopMonitor) flattenStuckExit(ctx context.Context, p *interfaces.OptionsPosition, orders []*interfaces.Order, now time.Time) {
	if workingFlattenOrder(p.Symbol, orders) != nil {
		m.flatten(ctx, p, orders, now)
		return
	}
	if llm := workingLLMSell(p.Symbol, orders); llm != nil {
		if err := m.flattener.CancelOrder(ctx, llm.ID); err != nil {
			m.logger.WithError(err).WithField("symbol", p.Symbol).Error("prophet_stuck_exit: cancel llm order failed")
			return
		}
		confirmed, err := m.flattener.GetOrder(ctx, llm.ID)
		if err != nil || confirmed == nil || (confirmed.Status != "canceled" && confirmed.Status != "filled") {
			m.logger.WithField("symbol", p.Symbol).Warn("prophet_stuck_exit: llm cancel not confirmed; retry next tick")
			return
		}
		if confirmed.Status == "filled" {
			return // the LLM's order filled after all; nothing left to flatten
		}
	}
	m.flatten(ctx, p, orders, now)
}
