package services

import (
	"context"
	"fmt"
	"math"
	"time"

	"prophet-trader/interfaces"
	"prophet-trader/models"
)

// monitorStore is the storage subset the monitor needs to enumerate
// candidates. Decoupled from harvestStateStore so tests don't need to fake
// every method.
type monitorStore interface {
	ListOpenHarvestCondors() ([]*models.DBHarvestCondor, error)
}

// monitorPricer is implemented by HarvestPricer in production and a fake in
// tests.
type monitorPricer interface {
	CostToClosePerContract(ctx context.Context, c *models.DBHarvestCondor) (float64, error)
}

// monitorCloser is implemented by HarvestCloser in production and a fake in
// tests.
type monitorCloser interface {
	CloseCondor(ctx context.Context, req CloseCondorRequest) (*CloseCondorResult, error)
}

// orderTracker is the order-state subset the monitor needs to escalate.
// Implemented by *services.AlpacaTradingService in production.
type orderTracker interface {
	GetOrder(ctx context.Context, orderID string) (*interfaces.Order, error)
	CancelOrder(ctx context.Context, orderID string) error
}

// condorUpdater is implemented by *LocalStorage in production. The monitor
// uses it to flip CLOSING -> CLOSED once the broker confirms a fill.
type condorUpdater interface {
	UpdateHarvestCondor(condorID string, updates map[string]interface{}) error
}

// tierAttempt remembers the most recent close placement for a condor so the
// monitor knows when to escalate. Reset on each new attempt (same reason
// increments tier; different reason resets to 0). All in memory: if the bot
// restarts mid-escalation we lose this state and the next OPEN evaluation
// starts over at tier 0 — acceptable for v1 (see plan self-review §2).
type tierAttempt struct {
	reason   string
	tier     int       // 0 = initial, 1 = first escalation, 2 = market (per reason)
	placedAt time.Time
}

// HarvestExitMonitor evaluates the three Step-2 exit rules from
// TRADING_RULES_HARVEST.md against each open condor on every tick:
//
//   - time exit:     DTE <= 21                                 -> limit @ mid
//   - loss stop:     cost_to_close >= 2.0 * credit_per_contract -> limit @ mid + $0.20
//   - profit target: cost_to_close <= 0.50 * credit_per_contract -> limit @ mid
//
// Priority is time -> loss -> profit, matching the rules doc. Time wins over
// loss when both fire on the same condor because the time tier ladder
// (limit@mid -> limit@mid-$0.05 -> market) is the gentler one — taking a
// guaranteed-soon time exit at mid is better than chasing a loss stop with
// market orders if both fire on the same condor.
//
// Task 4 adds tier escalation: for CLOSING rows, the monitor polls the
// existing close order, and if the per-reason escalation window has elapsed
// without a fill it cancels and re-places at the next tier. State is held
// in m.attempts (in-memory, keyed by CondorID) — survives across ticks but
// not restarts. Task 5 will own the fill-confirmation CLOSING -> CLOSED
// transition.
type HarvestExitMonitor struct {
	store    monitorStore
	pricer   monitorPricer
	closer   monitorCloser
	tracker  orderTracker
	updater  condorUpdater
	attempts map[string]tierAttempt
}

func NewHarvestExitMonitor(store monitorStore, pricer monitorPricer, closer monitorCloser) *HarvestExitMonitor {
	return &HarvestExitMonitor{
		store:    store,
		pricer:   pricer,
		closer:   closer,
		attempts: map[string]tierAttempt{},
	}
}

// SetOrderTracker wires the order-state source used to check existing
// close orders for fills/escalation. Optional: if unset, CLOSING rows are
// skipped (the monitor only places fresh orders on OPEN rows).
func (m *HarvestExitMonitor) SetOrderTracker(t orderTracker) { m.tracker = t }

// SetUpdater wires the storage handle used to finalize CLOSING -> CLOSED on
// fill confirmation. Optional: if unset, the monitor still polls broker order
// status but leaves the DB row in CLOSING (a future tick — once SetUpdater is
// wired — will pick it up).
func (m *HarvestExitMonitor) SetUpdater(u condorUpdater) { m.updater = u }

// RecordTierAttempt is called immediately after a close order is placed so
// the monitor knows when the next escalation window opens. Used by
// evaluateOpen on the initial placement (tier=0 always — same reason on a
// fresh OPEN row means a previous attempt was wiped by a restart and we're
// starting over).
func (m *HarvestExitMonitor) RecordTierAttempt(condorID, reason string, placedAt time.Time) {
	if m.attempts == nil {
		m.attempts = map[string]tierAttempt{}
	}
	prev, exists := m.attempts[condorID]
	tier := 0
	if exists && prev.reason == reason {
		tier = prev.tier + 1
	}
	m.attempts[condorID] = tierAttempt{reason: reason, tier: tier, placedAt: placedAt}
}

// escalationWindow is the per-reason interval the monitor waits for a fill
// before cancel-and-replace. Loss stops escalate aggressively (2 min) since
// the loss is widening every tick we wait; time/profit exits are non-urgent
// so we give the limit a full 10 min to fill before stepping the price.
func escalationWindow(reason string) time.Duration {
	if reason == "loss_stop" {
		return 2 * time.Minute
	}
	return 10 * time.Minute // time_exit + profit_target
}

// escalatePrice returns the order type and limit price for a given
// (reason, tier) pair. Tier 0 is the initial placement; each subsequent
// tier widens the price toward market.
//
//   loss_stop:    tier 0 = limit @ mid+$0.20  | tier 1+ = market
//   time_exit:    tier 0 = limit @ mid         | tier 1 = limit @ mid-$0.05 | tier 2+ = market
//   profit_target: tier 0 = limit @ mid         | tier 1 = limit @ mid-$0.05 | tier 2+ = market
func escalatePrice(reason string, tier int, cost float64) (orderType string, limit float64) {
	switch reason {
	case "loss_stop":
		if tier == 0 {
			return "limit", cost + 0.20
		}
		return "market", 0
	case "time_exit", "profit_target":
		switch tier {
		case 0:
			return "limit", cost
		case 1:
			return "limit", cost - 0.05
		default:
			return "market", 0
		}
	}
	return "limit", cost
}

// EvaluateTick runs one pass over open condors, dispatching by status:
//
//   - OPEN: classify against the three exit rules; on trigger place an
//     initial (tier-0) close order and seed attempts state.
//   - CLOSING: check the existing close order's status; if past the
//     escalation window without a fill, cancel and re-place at the next
//     tier.
//
// Pricing, tracker, or close-call errors on a single condor are logged via
// fmt (Task 5 swaps to logrus) and do not block the loop — other condors
// still get evaluated.
func (m *HarvestExitMonitor) EvaluateTick(ctx context.Context, now time.Time) {
	condors, err := m.store.ListOpenHarvestCondors()
	if err != nil {
		fmt.Printf("[harvest-exit-monitor] list condors failed: %v\n", err)
		return
	}
	for _, c := range condors {
		switch c.Status {
		case "OPEN":
			m.evaluateOpen(ctx, c, now)
		case "CLOSING":
			m.evaluateClosing(ctx, c, now)
		}
	}
}

// evaluateOpen handles the initial close placement on an OPEN row. On
// trigger it places a tier-0 limit/market per escalatePrice and seeds
// attempts state.
func (m *HarvestExitMonitor) evaluateOpen(ctx context.Context, c *models.DBHarvestCondor, now time.Time) {
	dte := int(math.Round(c.Expiration.Sub(now).Hours() / 24))

	// Always fetch cost-to-close. Even time-exit needs it to set the
	// limit price at current mid. Pricer failure is non-fatal per condor
	// (next tick retries).
	cost, err := m.pricer.CostToClosePerContract(ctx, c)
	if err != nil {
		fmt.Printf("[harvest-exit-monitor] %s pricer failed: %v\n", c.CondorID, err)
		return
	}

	reason := m.classify(c, dte, cost)
	if reason == "" {
		return
	}

	orderType, limit := escalatePrice(reason, 0, cost)
	req := CloseCondorRequest{
		CondorID:            c.CondorID,
		OrderType:           orderType,
		LimitPrice:          limit,
		CostPerContract:     cost,
		CloseReason:         reason,
		FinalizeImmediately: false, // monitor owns CLOSING -> CLOSED via Task 5 fill poll
	}
	if _, err := m.closer.CloseCondor(ctx, req); err != nil {
		fmt.Printf("[harvest-exit-monitor] %s close failed: %v\n", c.CondorID, err)
		return
	}
	m.RecordTierAttempt(c.CondorID, reason, now)
}

// evaluateClosing handles tier escalation on a CLOSING row. If the
// existing close order is filled, it bails to Task 5 (TODO). If the
// escalation window has elapsed without a fill, it cancels the existing
// order and re-places at the next tier with AllowReplaceClosing=true.
func (m *HarvestExitMonitor) evaluateClosing(ctx context.Context, c *models.DBHarvestCondor, now time.Time) {
	if m.tracker == nil || c.CloseOrderID == "" {
		return // no way to check / no order to escalate
	}
	ord, err := m.tracker.GetOrder(ctx, c.CloseOrderID)
	if err != nil {
		fmt.Printf("[harvest-exit-monitor] %s status fetch failed: %v\n", c.CondorID, err)
		return
	}
	if ord.Status == "filled" {
		if m.updater != nil {
			closedAt := now
			if err := m.updater.UpdateHarvestCondor(c.CondorID, map[string]interface{}{
				"status":    "CLOSED",
				"closed_at": &closedAt,
			}); err != nil {
				fmt.Printf("[harvest-exit-monitor] %s finalize update failed: %v\n", c.CondorID, err)
				// Don't clear attempts state — next tick will retry the finalize.
				return
			}
		}
		delete(m.attempts, c.CondorID)
		return
	}
	attempt, ok := m.attempts[c.CondorID]
	if !ok {
		// Bot was restarted mid-escalation; no attempts state. Let the
		// existing close order run to broker EOD or be observed on a
		// future OPEN cycle (after broker auto-cancel at session end).
		return
	}
	if now.Sub(attempt.placedAt) < escalationWindow(attempt.reason) {
		return
	}
	if err := m.tracker.CancelOrder(ctx, c.CloseOrderID); err != nil {
		fmt.Printf("[harvest-exit-monitor] %s cancel failed: %v\n", c.CondorID, err)
		return
	}
	// Refresh placedAt so a pricer failure here doesn't wedge: next tick will
	// wait the full new escalation window before re-attempting cancel-and-replace.
	// We don't bump tier yet — the place hasn't happened. If the pricer call
	// below succeeds we'll overwrite this entry with the new {nextTier, now}.
	m.attempts[c.CondorID] = tierAttempt{reason: attempt.reason, tier: attempt.tier, placedAt: now}
	cost, err := m.pricer.CostToClosePerContract(ctx, c)
	if err != nil {
		fmt.Printf("[harvest-exit-monitor] %s pricer failed on escalation: %v\n", c.CondorID, err)
		return
	}
	nextTier := attempt.tier + 1
	orderType, limit := escalatePrice(attempt.reason, nextTier, cost)
	// Update attempts BEFORE placing so a duplicate tick during placement
	// doesn't re-escalate. RecordTierAttempt would compute tier from the
	// previous state (which we already read into `attempt`); bypass it
	// here and write the known nextTier directly for clarity.
	m.attempts[c.CondorID] = tierAttempt{reason: attempt.reason, tier: nextTier, placedAt: now}
	if _, err := m.closer.CloseCondor(ctx, CloseCondorRequest{
		CondorID:            c.CondorID,
		OrderType:           orderType,
		LimitPrice:          limit,
		CostPerContract:     cost,
		CloseReason:         attempt.reason, // preserve original reason across tiers
		FinalizeImmediately: false,          // monitor-mode; fill poll owns CLOSED
		AllowReplaceClosing: true,           // row is CLOSING, not OPEN — closer must accept
	}); err != nil {
		fmt.Printf("[harvest-exit-monitor] %s escalation place failed: %v\n", c.CondorID, err)
	}
}

// classify returns the close reason for the highest-priority trigger that
// fires on an OPEN row. An empty reason means no trigger is active.
// Priority matches the rules doc: time -> loss -> profit.
func (m *HarvestExitMonitor) classify(c *models.DBHarvestCondor, dte int, cost float64) string {
	if dte <= 21 {
		return "time_exit"
	}
	if cost >= 2.0*c.CreditPerContract {
		return "loss_stop"
	}
	if cost <= 0.50*c.CreditPerContract {
		return "profit_target"
	}
	return ""
}

// Start runs the monitor's tick loop. Ticks every `interval` while
// marketIsOpen() reports true, sleeps `idleInterval` otherwise. Returns
// when ctx is canceled. Designed to be invoked as `go monitor.Start(...)`
// from main.go after construction + Set* wiring.
func (m *HarvestExitMonitor) Start(ctx context.Context, interval, idleInterval time.Duration, marketIsOpen func() bool) {
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
