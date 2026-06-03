package services

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"prophet-trader/database"
	"prophet-trader/interfaces"
	"prophet-trader/models"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/sirupsen/logrus"
)

// ManagedPosition represents a position with automated risk management
type ManagedPosition struct {
	ID       string `json:"id"`
	Symbol   string `json:"symbol"`
	Side     string `json:"side"`     // "buy" or "sell"
	Strategy string `json:"strategy"` // "SWING_TRADE", "LONG_TERM", "DAY_TRADE"
	// AgentStrategy is the owning agent's strategyId (e.g. "trend", "v2-options").
	// Distinct from Strategy, which is the trading-style label.
	// Populated from OPENPROPHET_STRATEGY at the MCP boundary.
	AgentStrategy string `json:"agent_strategy,omitempty"`

	// Entry details
	Quantity          float64 `json:"quantity"`
	EntryPrice        float64 `json:"entry_price"`
	EntryOrderID      string  `json:"entry_order_id"`
	EntryOrderType    string  `json:"entry_order_type"` // "market", "limit"
	AllocationDollars float64 `json:"allocation_dollars"`

	// Risk management
	StopLossPrice   float64 `json:"stop_loss_price"`
	StopLossPercent float64 `json:"stop_loss_percent"`
	StopLossOrderID string  `json:"stop_loss_order_id,omitempty"`
	TrailingStop    bool    `json:"trailing_stop"`
	TrailingPercent float64 `json:"trailing_percent,omitempty"`

	// Profit targets
	TakeProfitPrice   float64 `json:"take_profit_price"`
	TakeProfitPercent float64 `json:"take_profit_percent"`
	TakeProfitOrderID string  `json:"take_profit_order_id,omitempty"`

	// Partial exit strategy
	PartialExit       *PartialExitConfig `json:"partial_exit,omitempty"`
	PartialExitOrders []string           `json:"partial_exit_orders,omitempty"`

	// Status tracking
	Status         string  `json:"status"` // "PENDING", "ACTIVE", "PARTIAL", "CLOSED", "STOPPED_OUT", "FAILED"
	CurrentPrice   float64 `json:"current_price"`
	UnrealizedPL   float64 `json:"unrealized_pl"`
	UnrealizedPLPC float64 `json:"unrealized_pl_percent"`
	RemainingQty   float64 `json:"remaining_qty"`

	// Metadata
	CreatedAt time.Time  `json:"created_at"`
	UpdatedAt time.Time  `json:"updated_at"`
	ClosedAt  *time.Time `json:"closed_at,omitempty"`
	Notes     string     `json:"notes,omitempty"`
	Tags      []string   `json:"tags,omitempty"`
}

// PartialExitConfig defines partial profit taking strategy
type PartialExitConfig struct {
	Enabled       bool    `json:"enabled"`
	Percent       float64 `json:"percent"`        // % of position to exit
	TargetPercent float64 `json:"target_percent"` // % gain to trigger partial exit
	TargetPrice   float64 `json:"target_price"`   // Calculated target price
}

// PlaceManagedPositionRequest represents request to open a managed position
type PlaceManagedPositionRequest struct {
	Symbol            string      `json:"symbol" binding:"required"`
	Side              string      `json:"side" binding:"required"`  // "buy" or "sell"
	Strategy          string      `json:"strategy"`                 // "SWING_TRADE", "LONG_TERM", "DAY_TRADE"
	AgentStrategy     string      `json:"agent_strategy,omitempty"` // agent strategyId from OPENPROPHET_STRATEGY (e.g. "trend", "v2-options")
	AgentSource       AgentSource `json:"agent_source,omitempty"`   // "main"; defaults to "main"
	AllocationDollars float64     `json:"allocation_dollars" binding:"required,gt=0"`

	// Entry configuration
	EntryStrategy string   `json:"entry_strategy"`        // "market", "limit"
	EntryPrice    *float64 `json:"entry_price,omitempty"` // Required for limit orders

	// Risk management (one of these required)
	StopLossPrice   *float64 `json:"stop_loss_price,omitempty"`
	StopLossPercent *float64 `json:"stop_loss_percent,omitempty"`
	TrailingStop    bool     `json:"trailing_stop"`
	TrailingPercent float64  `json:"trailing_percent,omitempty"`

	// Profit targets (one of these required)
	TakeProfitPrice   *float64 `json:"take_profit_price,omitempty"`
	TakeProfitPercent *float64 `json:"take_profit_percent,omitempty"`

	// Partial exit (optional)
	PartialExit *PartialExitConfig `json:"partial_exit,omitempty"`

	// Metadata
	Notes          string   `json:"notes,omitempty"`
	Tags           []string `json:"tags,omitempty"`
}

// PositionManager handles automated position management
type PositionManager struct {
	tradingService interfaces.TradingService
	dataService    interfaces.DataService
	storageService *database.LocalStorage
	guard          *TradeGuard

	positions map[string]*ManagedPosition // position_id -> position
	mu        sync.RWMutex
	logger    *logrus.Logger

	// reconcileMissCount tracks, per position_id, how many consecutive
	// reconciliation passes the symbol has been absent from broker truth.
	// A position is closed only once this reaches reconcileCloseThreshold,
	// which absorbs the propagation lag between a market fill and GetPositions
	// reflecting it. Guarded by mu.
	reconcileMissCount map[string]int

	// segmentWriter, when set, writes the daily mark-to-market DBSegmentPnL row
	// once per trading day after close from inside MonitorPositions. nil-safe:
	// if never installed, no daily marks are written.
	segmentWriter       *SegmentPnLWriter
	lastSegmentWriteDay string

	// orphanAlerted tracks symbols already reported as orphans (broker holds the
	// shares but this agent's ledger marked the position terminal), so the ~60s
	// reconcile pass logs/reports each one once. Guarded by mu.
	orphanAlerted map[string]bool
	// orphanReporter persists the current orphan set to disk. nil-safe: if never
	// installed, detection still logs but writes no file.
	orphanReporter *OrphanReporter

	// pendingTimeout bounds how long a managed entry may sit PENDING before it
	// is force-terminalized (cancel + flatten any stray fill). Without it a
	// broker order stuck "new"/"accepted" with no fill hangs forever — the
	// reconciler deliberately skips PENDING and there is otherwise no timeout.
	// Default 300s (env MANAGED_PENDING_TIMEOUT_SEC).
	pendingTimeout time.Duration

	// cancelSettlePoll and cancelSettleMax bound waitForBracketReleased. After
	// cancelling a position's protective bracket to free the shares it reserved,
	// the close path polls the cancelled orders up to cancelSettleMax times,
	// sleeping cancelSettlePoll between polls, until the broker reports them
	// terminal. Alpaca processes cancels asynchronously (pending_cancel →
	// canceled) and does not release the reserved shares until the order is
	// actually canceled, so liquidating before this settles races the cancel.
	// Defaults ~200ms × 15 ≈ 3s. Tests set cancelSettlePoll to 0.
	cancelSettlePoll time.Duration
	cancelSettleMax  int

	ctx    context.Context
	cancel context.CancelFunc
}

// NewPositionManager creates a new position manager
func NewPositionManager(
	tradingService interfaces.TradingService,
	dataService interfaces.DataService,
	storageService *database.LocalStorage,
) *PositionManager {
	logger := logrus.New()
	logger.SetFormatter(&logrus.TextFormatter{
		FullTimestamp: true,
	})

	ctx, cancel := context.WithCancel(context.Background())

	pm := &PositionManager{
		tradingService:     tradingService,
		dataService:        dataService,
		storageService:     storageService,
		positions:          make(map[string]*ManagedPosition),
		reconcileMissCount: make(map[string]int),
		orphanAlerted:      make(map[string]bool),
		pendingTimeout:     pendingEntryTimeout(),
		cancelSettlePoll:   200 * time.Millisecond,
		cancelSettleMax:    15,
		logger:             logger,
		ctx:                ctx,
		cancel:             cancel,
	}

	// Load existing positions from database
	if err := pm.loadPositionsFromDB(); err != nil {
		logger.WithError(err).Error("Failed to load positions from database")
	}

	return pm
}

// SetSegmentWriter installs the EOD daily-mark writer (wired at startup once
// the SegmentPnLService exists). Optional: if never set, MonitorPositions
// simply does not write daily marks.
func (pm *PositionManager) SetSegmentWriter(w *SegmentPnLWriter) {
	pm.segmentWriter = w
}

// SetOrphanReporter installs the report-only orphan reporter (wired at startup).
// Optional: if never set, detectOrphans still logs but writes no report file.
func (pm *PositionManager) SetOrphanReporter(r *OrphanReporter) {
	pm.orphanReporter = r
}

// pendingEntryTimeout resolves the PENDING-entry timeout from the environment,
// defaulting to 300s. Market/marketable managed entries fill in seconds, so
// this only ever trips on a genuinely stuck order.
func pendingEntryTimeout() time.Duration {
	const def = 300 * time.Second
	if v := os.Getenv("MANAGED_PENDING_TIMEOUT_SEC"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return time.Duration(n) * time.Second
		}
	}
	return def
}

// PlaceManagedPosition opens a new managed position with automated risk management
func (pm *PositionManager) PlaceManagedPosition(ctx context.Context, req *PlaceManagedPositionRequest) (*ManagedPosition, error) {
	pm.logger.WithFields(logrus.Fields{
		"symbol":     req.Symbol,
		"side":       req.Side,
		"allocation": req.AllocationDollars,
	}).Info("Placing managed position")

	// Resolve agent source: explicit override wins; else derive from the agent
	// strategy tag (agent_source is not sent by the MCP in production).
	agent := req.AgentSource
	if agent == "" {
		agent = AgentForStrategy(req.AgentStrategy)
	}

	// Trade guard check
	if pm.guard != nil {
		if err := pm.guard.CheckBuy(ctx, agent, req.Symbol, req.AllocationDollars); err != nil {
			pm.logger.WithError(err).Warn("Managed position blocked by trade guard")
			return nil, err
		}
	}

	// Validate request
	if err := pm.validateRequest(req); err != nil {
		return nil, fmt.Errorf("invalid request: %w", err)
	}

	// Get current price for calculations
	currentPrice, err := pm.getCurrentPrice(ctx, req.Symbol)
	if err != nil {
		return nil, fmt.Errorf("failed to get current price: %w", err)
	}

	// Calculate position parameters
	entryPrice := currentPrice
	if req.EntryPrice != nil {
		entryPrice = *req.EntryPrice
	}

	quantity := pm.calculateQuantity(req.AllocationDollars, entryPrice)

	// Calculate stop loss
	stopLossPrice := pm.calculateStopLoss(entryPrice, req.StopLossPrice, req.StopLossPercent, req.Side)
	stopLossPercent := math.Abs((stopLossPrice - entryPrice) / entryPrice * 100)

	// Calculate take profit
	takeProfitPrice := pm.calculateTakeProfit(entryPrice, req.TakeProfitPrice, req.TakeProfitPercent, req.Side)
	takeProfitPercent := math.Abs((takeProfitPrice - entryPrice) / entryPrice * 100)

	// Calculate partial exit if configured
	if req.PartialExit != nil && req.PartialExit.Enabled {
		req.PartialExit.TargetPrice = pm.calculatePartialExitPrice(entryPrice, req.PartialExit.TargetPercent, req.Side)
	}

	// Create managed position
	tags := appendTagIfMissing(req.Tags, AgentTag(agent))
	position := &ManagedPosition{
		ID:                pm.generatePositionID(),
		Symbol:            req.Symbol,
		Side:              req.Side,
		Strategy:          req.Strategy,
		AgentStrategy:     req.AgentStrategy,
		Quantity:          quantity,
		EntryPrice:        entryPrice,
		EntryOrderType:    req.EntryStrategy,
		AllocationDollars: req.AllocationDollars,
		StopLossPrice:     stopLossPrice,
		StopLossPercent:   stopLossPercent,
		TrailingStop:      req.TrailingStop,
		TrailingPercent:   req.TrailingPercent,
		TakeProfitPrice:   takeProfitPrice,
		TakeProfitPercent: takeProfitPercent,
		PartialExit:       req.PartialExit,
		Status:            "PENDING",
		CurrentPrice:      currentPrice,
		RemainingQty:      quantity,
		CreatedAt:         time.Now(),
		UpdatedAt:         time.Now(),
		Notes:             req.Notes,
		Tags:              tags,
	}

	// Place entry order
	if err := pm.placeEntryOrder(ctx, position); err != nil {
		return nil, fmt.Errorf("failed to place entry order: %w", err)
	}

	// Store position
	pm.mu.Lock()
	pm.positions[position.ID] = position
	pm.mu.Unlock()

	// Save to database
	if err := pm.savePositionToDB(position); err != nil {
		pm.logger.WithError(err).Error("Failed to save position to database")
	}

	pm.logger.WithFields(logrus.Fields{
		"position_id":       position.ID,
		"entry_order_id":    position.EntryOrderID,
		"quantity":          quantity,
		"entry_price":       entryPrice,
		"stop_loss":         stopLossPrice,
		"take_profit":       takeProfitPrice,
		"risk_reward_ratio": takeProfitPercent / stopLossPercent,
	}).Info("Managed position created")

	return position, nil
}

// placeEntryOrder places the initial entry order
func (pm *PositionManager) placeEntryOrder(ctx context.Context, position *ManagedPosition) error {
	orderType := "market"
	if position.EntryOrderType == "limit" {
		orderType = "limit"
	}

	order := &interfaces.Order{
		Symbol:      position.Symbol,
		Qty:         position.Quantity,
		Side:        position.Side,
		Type:        orderType,
		TimeInForce: "gtc",
		Status:      "pending",
		SubmittedAt: time.Now(),
		// Propagate the owning agent's strategy so the broker's
		// client_order_id is encoded as "{agent_strategy}:{uuid}" and the
		// resulting DBOrder row is attributable. Empty for legacy callers.
		Strategy: position.AgentStrategy,
	}

	if orderType == "limit" {
		order.LimitPrice = &position.EntryPrice
	}

	result, err := pm.tradingService.PlaceOrder(ctx, order)
	if err != nil {
		return err
	}

	// Persist the resulting DBOrder so strategy attribution
	// (GetSymbolStrategyAttribution) can map this symbol back to the owning
	// agent. Without this, the /positions?strategy=X filter drops the broker
	// position and the preflight skip in agent/preflight.js sees zero
	// positions to manage. Mirrors order_controller.go Buy/Sell.
	order.ID = result.OrderID
	order.Status = result.Status
	if pm.storageService != nil {
		if saveErr := pm.storageService.SaveOrder(order); saveErr != nil {
			pm.logger.WithError(saveErr).WithFields(logrus.Fields{
				"symbol":   order.Symbol,
				"order_id": result.OrderID,
			}).Warn("Failed to save managed-position entry order to database")
		}
	}

	position.EntryOrderID = result.OrderID
	position.Status = "PENDING"

	return nil
}

// MonitorPositions monitors all active positions and manages risk
func (pm *PositionManager) MonitorPositions(ctx context.Context) {
	ticker := time.NewTicker(10 * time.Second) // Check every 10 seconds
	defer ticker.Stop()

	pm.logger.Debug("Position monitoring started")

	// Reconcile managed state against broker truth every reconcileEveryTicks
	// (~60s), plus once immediately. The startup pass is what catches a
	// restart-induced phantom (a non-closed row reloaded as ACTIVE while the
	// broker is already flat) within two passes instead of letting it linger
	// indefinitely — the failure mode that left III stuck on Spark for days.
	const reconcileEveryTicks = 6
	if _, err := pm.reconcileWithBroker(ctx); err != nil {
		pm.logger.WithError(err).Debug("startup broker reconcile skipped (broker read failed)")
	}
	tick := 0

	for {
		select {
		case <-ctx.Done():
			pm.logger.Info("Position monitoring stopped")
			return
		case <-ticker.C:
			pm.checkPositions(ctx)
			tick++
			if tick%reconcileEveryTicks == 0 {
				if _, err := pm.reconcileWithBroker(ctx); err != nil {
					pm.logger.WithError(err).Debug("periodic broker reconcile skipped (broker read failed)")
				}
			}
			if pm.segmentWriter != nil {
				now := time.Now()
				if shouldWriteSegmentMarks(now, pm.lastSegmentWriteDay) {
					if err := pm.segmentWriter.WriteDailyMarks(ctx, now); err != nil {
						pm.logger.WithError(err).Warn("segment-pnl: daily mark write failed")
					} else {
						pm.lastSegmentWriteDay = etDayKey(now)
					}
				}
			}
		}
	}
}

// reconcileCloseThreshold is the number of consecutive reconciliation passes a
// managed position must be absent from broker truth before it is closed. Two
// passes (spaced by the monitor's reconcile cadence) absorb the brief window
// between a market entry filling and that fill propagating to GetPositions, so
// a freshly opened position is never mistaken for a phantom.
const reconcileCloseThreshold = 2

// reconcileWithBroker closes managed positions that the broker no longer holds.
//
// The managed-position store can drift out of sync with the broker: a bracket
// leg fills but the GetOrder check misses it, a co-located agent on the shared
// account closes the symbol, a manual/broker close happens, or a restart
// reloads a position whose broker side had already been flattened (this is what
// stranded III on Spark — managed row stuck ACTIVE for 2+ days while the broker
// had been flat since the agent's own hard-stop sell). None of those paths
// transition the managed row to CLOSED, so it lingers as a phantom the agent
// keeps "managing".
//
// This pass is the backstop. It is deliberately conservative:
//   - A failed broker read closes nothing — we act only on a confirmed-empty
//     broker, never on an error or unknown.
//   - PENDING positions are skipped: an unfilled entry legitimately has no
//     broker position yet (handled by checkEntryOrder + the 24h stale filter).
//   - Closure requires the symbol absent on reconcileCloseThreshold consecutive
//     passes, so propagation lag on a just-filled buy can't cause a false close.
//   - It NEVER places an order. The broker is already flat; an exit order would
//     reject or, worse, open a short. The row is marked CLOSED in place.
//
// Returns the number of positions reconciled-closed this pass.
func (pm *PositionManager) reconcileWithBroker(ctx context.Context) (int, error) {
	brokerPositions, err := pm.tradingService.GetPositions(ctx)
	if err != nil {
		return 0, fmt.Errorf("reconcile: broker positions read failed: %w", err)
	}

	held := make(map[string]bool, len(brokerPositions))
	for _, bp := range brokerPositions {
		if bp != nil && bp.Qty != 0 {
			held[bp.Symbol] = true
		}
	}

	pm.mu.Lock()
	closed := 0
	for id, pos := range pm.positions {
		// Only entry-filled positions can be phantoms. PENDING/terminal states
		// are not candidates; clear any stale miss count and skip.
		if pos.Status != "ACTIVE" && pos.Status != "PARTIAL" {
			delete(pm.reconcileMissCount, id)
			continue
		}
		if held[pos.Symbol] {
			delete(pm.reconcileMissCount, id)
			continue
		}

		pm.reconcileMissCount[id]++
		if pm.reconcileMissCount[id] < reconcileCloseThreshold {
			continue
		}

		now := time.Now()
		pos.Status = "CLOSED"
		pos.ClosedAt = &now
		pos.UpdatedAt = now
		pos.Notes = strings.TrimSpace(pos.Notes + " reconciled_closed:broker_flat")
		delete(pm.reconcileMissCount, id)

		if saveErr := pm.savePositionToDB(pos); saveErr != nil {
			pm.logger.WithError(saveErr).WithFields(logrus.Fields{
				"position_id":              pos.ID,
				"symbol":                   pos.Symbol,
				"operator_review_required": true,
			}).Error("Failed to persist reconciled-closed position — may resurrect on reload")
		}

		pm.logger.WithFields(logrus.Fields{
			"position_id": pos.ID,
			"symbol":      pos.Symbol,
			"qty":         pos.RemainingQty,
		}).Warn("Managed position closed by broker reconciliation — broker holds none (no exit order placed)")
		closed++
	}
	pm.mu.Unlock()

	// Report-only orphan detection reuses the broker positions read above.
	pm.detectOrphans(brokerPositions)

	return closed, nil
}

// checkPositions checks all positions and manages their risk orders
func (pm *PositionManager) checkPositions(ctx context.Context) {
	pm.mu.RLock()
	positions := make([]*ManagedPosition, 0, len(pm.positions))
	for _, pos := range pm.positions {
		positions = append(positions, pos)
	}
	pm.mu.RUnlock()

	for _, position := range positions {
		if position.Status == "CLOSED" || position.Status == "STOPPED_OUT" {
			continue
		}

		// Check if entry order filled
		if position.Status == "PENDING" {
			pm.checkEntryOrder(ctx, position)
			continue
		}

		// Update current price and P&L
		if err := pm.updatePositionPrice(ctx, position); err != nil {
			pm.logger.WithError(err).WithField("symbol", position.Symbol).Error("Failed to update position price")
			continue
		}


		// Check if we need to place/update risk orders
		if position.Status == "ACTIVE" {
			pm.manageRiskOrders(ctx, position)
		}

		// Check trailing stop
		if position.TrailingStop {
			pm.updateTrailingStop(ctx, position)
		}
	}
}

// checkEntryOrder advances a PENDING position based on the broker truth of its
// entry order. It MUST handle every terminal/partial outcome, not just "filled":
// the original single-branch version left a partially_filled or rejected entry
// stuck PENDING forever, which froze the price, never placed a protective
// bracket, and hid the real (unprotected) shares from reconcileWithBroker — the
// III-on-Spark hang of 2026-05-27 (2 of 98 filled, row PENDING for 4+ minutes).
func (pm *PositionManager) checkEntryOrder(ctx context.Context, position *ManagedPosition) {
	order, err := pm.tradingService.GetOrder(ctx, position.EntryOrderID)
	if err != nil {
		pm.logger.WithError(err).Error("Failed to get entry order")
		return
	}

	switch order.Status {
	case "filled":
		// Activate on the full ordered quantity (FilledQty == Quantity here).
		pm.activateFilledEntry(ctx, position, order, position.Quantity)

	case "partially_filled":
		// Accept the shares actually filled and CANCEL the unfilled remainder so
		// it cannot fill later at a worse price and re-desync the managed row
		// from broker truth. Only after the remainder is bounded do we bracket
		// the real quantity. If FilledQty is not yet positive under this status,
		// there is nothing to act on — wait for the next tick.
		if order.FilledQty <= 0 {
			return
		}
		if cancelErr := pm.tradingService.CancelOrder(ctx, position.EntryOrderID); cancelErr != nil {
			// Could not bound the remainder — it may still fill and grow the
			// position. Do NOT activate against a quantity that can still change;
			// stay PENDING and retry next tick. The shares already filled remain
			// unprotected until then, so this is logged for operator awareness.
			pm.logger.WithError(cancelErr).WithFields(logrus.Fields{
				"position_id":              position.ID,
				"symbol":                   position.Symbol,
				"filled_qty":               order.FilledQty,
				"operator_review_required": true,
			}).Warn("Partial fill: could not cancel entry remainder — leaving PENDING, will retry")
			return
		}
		// Re-read terminal truth: shares may have filled in the window between
		// the status read above and the cancel landing. Bracket to the FINAL
		// filled qty (and its avg price), never the stale pre-cancel value, or
		// the extra shares are held unprotected — a smaller copy of the bug.
		fillOrder := order
		filledQty := order.FilledQty
		if term, termErr := pm.tradingService.GetOrder(ctx, position.EntryOrderID); termErr == nil && term != nil && term.FilledQty >= filledQty {
			fillOrder = term
			filledQty = term.FilledQty
		}
		pm.logger.WithFields(logrus.Fields{
			"position_id": position.ID,
			"symbol":      position.Symbol,
			"ordered_qty": position.Quantity,
			"filled_qty":  filledQty,
		}).Info("Entry partially filled — accepted partial, cancelled remainder")
		pm.activateFilledEntry(ctx, position, fillOrder, filledQty)

	case "canceled", "rejected", "expired":
		// Broker-terminal with no more fills coming. Previously these left the
		// row stuck PENDING indefinitely.
		if order.FilledQty > 0 {
			// Some shares filled before the terminal state — accept + bracket
			// them rather than abandon a real, unprotected position.
			pm.logger.WithFields(logrus.Fields{
				"position_id": position.ID,
				"symbol":      position.Symbol,
				"status":      order.Status,
				"filled_qty":  order.FilledQty,
			}).Warn("Entry order terminal with a partial fill — bracketing the filled shares")
			pm.activateFilledEntry(ctx, position, order, order.FilledQty)
			return
		}
		pm.markEntryFailed(position, "entry_"+order.Status)

	default:
		// "new", "accepted", "pending_new", etc.: the entry is still working.
		// A market/marketable entry that has not progressed past pendingTimeout
		// is treated as stuck → bound it and terminalize so it can never hang
		// forever (the reconciler deliberately skips PENDING).
		if pm.pendingTimeout > 0 && time.Since(position.CreatedAt) > pm.pendingTimeout {
			pm.timeoutPendingEntry(ctx, position)
		}
	}
}

// timeoutPendingEntry force-terminalizes an entry that has sat PENDING past
// pendingTimeout. It cancels the working order so nothing more can fill, then
// reads terminal broker truth: any stray fill is flattened (FAILED + market
// exit of exactly the filled qty — never the ordered qty), otherwise the
// position is marked FAILED with no shares acquired. A cancel error leaves the
// row PENDING to retry next tick rather than abandoning a possibly-live order.
func (pm *PositionManager) timeoutPendingEntry(ctx context.Context, position *ManagedPosition) {
	if position.EntryOrderID != "" {
		if err := pm.tradingService.CancelOrder(ctx, position.EntryOrderID); err != nil {
			pm.logger.WithError(err).WithFields(logrus.Fields{
				"position_id":              position.ID,
				"symbol":                   position.Symbol,
				"operator_review_required": true,
			}).Warn("Pending-timeout: could not cancel stuck entry — leaving PENDING, will retry")
			return
		}
	}

	if order, err := pm.tradingService.GetOrder(ctx, position.EntryOrderID); err == nil && order != nil && order.FilledQty > 0 {
		// A sliver filled before the cancel bounded the order. Flatten exactly
		// what is held — the setup is stale after the timeout, so we do not keep it.
		position.Quantity = order.FilledQty
		position.RemainingQty = order.FilledQty
		if order.FilledAvgPrice != nil {
			position.EntryPrice = *order.FilledAvgPrice
		}
		pm.logger.WithFields(logrus.Fields{
			"position_id": position.ID,
			"symbol":      position.Symbol,
			"stray_qty":   order.FilledQty,
		}).Warn("Pending-timeout: stray fill detected — flattening held shares")
		pm.flattenUnprotected(ctx, position, "pending_timeout_stray_fill")
		return
	}

	pm.markEntryFailed(position, "pending_timeout")
}

// activateFilledEntry transitions a PENDING position to ACTIVE on the quantity
// actually filled, sets the broker fill price, sizes the position (and its
// bracket) to the real fill, and places the protective bracket. Saving happens
// AFTER placeRiskOrders because that call may mutate Status (e.g. to FAILED on
// auto-flatten); a silent save failure here is what produced Spark's
// PENDING-in-DB / ACTIVE-in-memory drift on 2026-05-18, so persistence errors
// are surfaced loudly.
func (pm *PositionManager) activateFilledEntry(ctx context.Context, position *ManagedPosition, order *interfaces.Order, filledQty float64) {
	position.Status = "ACTIVE"
	if order.FilledAvgPrice != nil {
		position.EntryPrice = *order.FilledAvgPrice
	}
	position.Quantity = filledQty
	position.RemainingQty = filledQty
	position.UpdatedAt = time.Now()

	pm.logger.WithFields(logrus.Fields{
		"position_id": position.ID,
		"symbol":      position.Symbol,
		"fill_price":  position.EntryPrice,
		"filled_qty":  filledQty,
	}).Info("Entry order filled - position now active")

	pm.placeRiskOrders(ctx, position)

	if err := pm.savePositionToDB(position); err != nil {
		pm.logger.WithError(err).WithFields(logrus.Fields{
			"position_id":              position.ID,
			"symbol":                   position.Symbol,
			"status":                   position.Status,
			"operator_review_required": true,
		}).Error("Failed to persist position state after entry fill — broker/DB out of sync")
	}
}

// markEntryFailed marks a position FAILED when its entry order reached a broker
// terminal state with nothing filled, so it cannot hang PENDING forever. No
// flatten is needed (no shares were acquired).
func (pm *PositionManager) markEntryFailed(position *ManagedPosition, reason string) {
	position.Status = "FAILED"
	position.UpdatedAt = time.Now()
	position.Notes = strings.TrimSpace(position.Notes + " entry_failed:" + reason)

	pm.logger.WithFields(logrus.Fields{
		"position_id": position.ID,
		"symbol":      position.Symbol,
		"reason":      reason,
	}).Warn("Entry order failed at broker — position marked FAILED (no shares acquired)")

	if err := pm.savePositionToDB(position); err != nil {
		pm.logger.WithError(err).WithFields(logrus.Fields{
			"position_id":              position.ID,
			"symbol":                   position.Symbol,
			"operator_review_required": true,
		}).Error("Failed to persist FAILED entry state")
	}
}

// placeRiskOrders places stop loss and take profit orders.
//
// Stop-loss failure is a CAPITAL-PROTECTION emergency: the entry already
// filled, the position is exposed, and the agent's stop is the only thing
// between us and an open-ended loss. We retry once (in case the first attempt
// hit a transient broker error), then auto-flatten via market sell if the
// retry also fails. Without this guard, a sub-penny rejection (or any other
// stop-placement error) leaves an unmanaged position with no risk control —
// exactly what happened to Spark's LAND on 2026-05-18.
//
// Take-profit and partial-exit failures are non-fatal: the position retains
// stop protection and can be managed/exited by the agent. We log loudly but
// don't force-close — those are profit-side orders, not survival orders.
func (pm *PositionManager) placeRiskOrders(ctx context.Context, position *ManagedPosition) {
	if err := pm.placeStopLossOrder(ctx, position); err != nil {
		pm.logger.WithError(err).WithFields(logrus.Fields{
			"position_id": position.ID,
			"symbol":      position.Symbol,
			"stop_price":  position.StopLossPrice,
		}).Warn("Stop loss placement failed on first attempt — retrying once")

		// Second attempt. placeStopLossOrder rounds defensively each call,
		// so a sub-penny issue self-heals; this retry covers transient
		// broker errors that wouldn't.
		if err := pm.placeStopLossOrder(ctx, position); err != nil {
			pm.logger.WithError(err).WithFields(logrus.Fields{
				"position_id":              position.ID,
				"symbol":                   position.Symbol,
				"stop_price":               position.StopLossPrice,
				"operator_review_required": true,
			}).Error("Stop loss placement failed twice — auto-flattening unprotected position")
			pm.flattenUnprotected(ctx, position, "stop_placement_failed")
			return
		}
	}

	if err := pm.placeTakeProfitOrder(ctx, position); err != nil {
		pm.logger.WithError(err).WithFields(logrus.Fields{
			"position_id": position.ID,
			"symbol":      position.Symbol,
		}).Warn("Failed to place take profit order — position remains protected by stop")
	}

	if position.PartialExit != nil && position.PartialExit.Enabled {
		if err := pm.placePartialExitOrder(ctx, position); err != nil {
			pm.logger.WithError(err).WithFields(logrus.Fields{
				"position_id": position.ID,
				"symbol":      position.Symbol,
			}).Warn("Failed to place partial exit order")
		}
	}
}

// flattenUnprotected closes a position whose risk-management bracket could
// not be established. Marks the position FAILED, places a tagged market sell
// for the remaining quantity, and persists the new state. Used when stop-loss
// placement fails (either at initial bracket setup or during a trailing-stop
// replacement after the old stop has been canceled).
func (pm *PositionManager) flattenUnprotected(ctx context.Context, position *ManagedPosition, reason string) {
	exitSide := "sell"
	if position.Side == "sell" {
		exitSide = "buy"
	}

	// Mark FAILED before placing the flatten order so any concurrent read
	// (Beat Context, get_managed_positions) sees the unsafe state.
	position.Status = "FAILED"
	position.UpdatedAt = time.Now()
	position.Notes = strings.TrimSpace(position.Notes + " bracket_failed_flatten:" + reason)
	if saveErr := pm.savePositionToDB(position); saveErr != nil {
		pm.logger.WithError(saveErr).WithField("position_id", position.ID).Error("Failed to persist FAILED status before flatten")
	}

	flattenOrder := &interfaces.Order{
		Symbol:      position.Symbol,
		Qty:         position.RemainingQty,
		Side:        exitSide,
		Type:        "market",
		TimeInForce: "day",
		Status:      "pending",
		SubmittedAt: time.Now(),
		// Tag with the owning agent's strategy so the resulting DBOrder is
		// attributable (matches placeEntryOrder).
		Strategy: position.AgentStrategy,
	}

	result, err := pm.tradingService.PlaceOrder(ctx, flattenOrder)
	if err != nil {
		pm.logger.WithError(err).WithFields(logrus.Fields{
			"position_id":              position.ID,
			"symbol":                   position.Symbol,
			"operator_review_required": true,
			"reason":                   reason,
		}).Error("Auto-flatten ALSO failed — position is unprotected, manual intervention required")
		return
	}

	flattenOrder.ID = result.OrderID
	flattenOrder.Status = result.Status
	if pm.storageService != nil {
		if saveErr := pm.storageService.SaveOrder(flattenOrder); saveErr != nil {
			pm.logger.WithError(saveErr).WithFields(logrus.Fields{
				"position_id": position.ID,
				"order_id":    result.OrderID,
			}).Warn("Failed to save flatten order to database")
		}
	}

	pm.logger.WithFields(logrus.Fields{
		"position_id": position.ID,
		"symbol":      position.Symbol,
		"order_id":    result.OrderID,
		"quantity":    position.RemainingQty,
		"reason":      reason,
	}).Info("Unprotected position auto-flattened")
}

// placeStopLossOrder places or updates stop loss order
func (pm *PositionManager) placeStopLossOrder(ctx context.Context, position *ManagedPosition) error {
	exitSide := "sell"
	if position.Side == "sell" {
		exitSide = "buy"
	}

	// Defensive: snap to tick before sending. The calculator already rounds
	// at construction time, but trailing-stop updates, manual overrides, and
	// DB-loaded positions from before this fix can carry sub-penny values.
	position.StopLossPrice = roundToTick(position.StopLossPrice)

	order := &interfaces.Order{
		Symbol:      position.Symbol,
		Qty:         position.RemainingQty,
		Side:        exitSide,
		Type:        "stop",
		TimeInForce: "gtc",
		StopPrice:   &position.StopLossPrice,
		Status:      "pending",
		SubmittedAt: time.Now(),
	}

	result, err := pm.tradingService.PlaceOrder(ctx, order)
	if err != nil {
		return err
	}

	position.StopLossOrderID = result.OrderID
	pm.logger.WithFields(logrus.Fields{
		"position_id": position.ID,
		"order_id":    result.OrderID,
		"stop_price":  position.StopLossPrice,
	}).Info("Stop loss order placed")

	return nil
}

// placeTakeProfitOrder places take profit limit order
func (pm *PositionManager) placeTakeProfitOrder(ctx context.Context, position *ManagedPosition) error {
	exitSide := "sell"
	if position.Side == "sell" {
		exitSide = "buy"
	}

	// Defensive: snap to tick before sending (see placeStopLossOrder).
	position.TakeProfitPrice = roundToTick(position.TakeProfitPrice)

	order := &interfaces.Order{
		Symbol:      position.Symbol,
		Qty:         position.RemainingQty,
		Side:        exitSide,
		Type:        "limit",
		TimeInForce: "gtc",
		LimitPrice:  &position.TakeProfitPrice,
		Status:      "pending",
		SubmittedAt: time.Now(),
	}

	result, err := pm.tradingService.PlaceOrder(ctx, order)
	if err != nil {
		return err
	}

	position.TakeProfitOrderID = result.OrderID
	pm.logger.WithFields(logrus.Fields{
		"position_id": position.ID,
		"order_id":    result.OrderID,
		"limit_price": position.TakeProfitPrice,
	}).Info("Take profit order placed")

	return nil
}

// placePartialExitOrder places partial exit order
func (pm *PositionManager) placePartialExitOrder(ctx context.Context, position *ManagedPosition) error {
	exitSide := "sell"
	if position.Side == "sell" {
		exitSide = "buy"
	}

	partialQty := position.Quantity * (position.PartialExit.Percent / 100.0)

	// Defensive: snap to tick before sending (see placeStopLossOrder).
	position.PartialExit.TargetPrice = roundToTick(position.PartialExit.TargetPrice)

	order := &interfaces.Order{
		Symbol:      position.Symbol,
		Qty:         partialQty,
		Side:        exitSide,
		Type:        "limit",
		TimeInForce: "gtc",
		LimitPrice:  &position.PartialExit.TargetPrice,
		Status:      "pending",
		SubmittedAt: time.Now(),
	}

	result, err := pm.tradingService.PlaceOrder(ctx, order)
	if err != nil {
		return err
	}

	position.PartialExitOrders = append(position.PartialExitOrders, result.OrderID)
	pm.logger.WithFields(logrus.Fields{
		"position_id": position.ID,
		"order_id":    result.OrderID,
		"quantity":    partialQty,
		"limit_price": position.PartialExit.TargetPrice,
	}).Info("Partial exit order placed")

	return nil
}

// manageRiskOrders checks and updates risk management orders
func (pm *PositionManager) manageRiskOrders(ctx context.Context, position *ManagedPosition) {
	// Check stop loss order status
	if position.StopLossOrderID != "" {
		order, err := pm.tradingService.GetOrder(ctx, position.StopLossOrderID)
		if err == nil && order.Status == "filled" {
			position.Status = "STOPPED_OUT"
			now := time.Now()
			position.ClosedAt = &now
			pm.logger.WithField("position_id", position.ID).Info("Position stopped out")
			pm.savePositionToDB(position)
			return
		}
	}

	// Check take profit order status
	if position.TakeProfitOrderID != "" {
		order, err := pm.tradingService.GetOrder(ctx, position.TakeProfitOrderID)
		if err == nil && order.Status == "filled" {
			position.Status = "CLOSED"
			now := time.Now()
			position.ClosedAt = &now
			pm.logger.WithField("position_id", position.ID).Info("Position closed at profit target")
			pm.savePositionToDB(position)
			return
		}
	}

	// Check partial exit orders
	for _, orderID := range position.PartialExitOrders {
		order, err := pm.tradingService.GetOrder(ctx, orderID)
		if err == nil && order.Status == "filled" {
			position.Status = "PARTIAL"
			position.RemainingQty -= order.FilledQty
			pm.logger.WithFields(logrus.Fields{
				"position_id":   position.ID,
				"filled_qty":    order.FilledQty,
				"remaining_qty": position.RemainingQty,
			}).Info("Partial exit filled")
			pm.savePositionToDB(position)
		}
	}
}

// updateTrailingStop updates trailing stop loss based on current price
func (pm *PositionManager) updateTrailingStop(ctx context.Context, position *ManagedPosition) {
	if position.Side == "buy" {
		// For long positions, raise stop as price rises
		newStopPrice := roundToTick(position.CurrentPrice * (1 - position.TrailingPercent/100.0))
		if newStopPrice > position.StopLossPrice {
			// Cancel old stop loss order
			if position.StopLossOrderID != "" {
				pm.tradingService.CancelOrder(ctx, position.StopLossOrderID)
			}

			// Update stop price and place new order. If the replacement
			// stop fails, the position is now unprotected (old stop already
			// canceled) — flatten via market sell rather than leave it open.
			position.StopLossPrice = newStopPrice
			if err := pm.placeStopLossOrder(ctx, position); err != nil {
				pm.logger.WithError(err).WithFields(logrus.Fields{
					"position_id": position.ID,
					"symbol":      position.Symbol,
				}).Error("Trailing-stop replacement failed — auto-flattening unprotected position")
				pm.flattenUnprotected(ctx, position, "trailing_stop_replacement_failed")
				return
			}

			pm.logger.WithFields(logrus.Fields{
				"position_id":    position.ID,
				"new_stop_price": newStopPrice,
			}).Info("Trailing stop updated")
		}
	} else {
		// For short positions, lower stop as price falls
		newStopPrice := roundToTick(position.CurrentPrice * (1 + position.TrailingPercent/100.0))
		if newStopPrice < position.StopLossPrice {
			if position.StopLossOrderID != "" {
				pm.tradingService.CancelOrder(ctx, position.StopLossOrderID)
			}

			position.StopLossPrice = newStopPrice
			if err := pm.placeStopLossOrder(ctx, position); err != nil {
				pm.logger.WithError(err).WithFields(logrus.Fields{
					"position_id": position.ID,
					"symbol":      position.Symbol,
				}).Error("Trailing-stop replacement failed — auto-flattening unprotected position")
				pm.flattenUnprotected(ctx, position, "trailing_stop_replacement_failed")
				return
			}

			pm.logger.WithFields(logrus.Fields{
				"position_id":    position.ID,
				"new_stop_price": newStopPrice,
			}).Info("Trailing stop updated")
		}
	}
}

// updatePositionPrice updates current price and unrealized P&L
func (pm *PositionManager) updatePositionPrice(ctx context.Context, position *ManagedPosition) error {
	currentPrice, err := pm.getCurrentPrice(ctx, position.Symbol)
	if err != nil {
		return err
	}

	position.CurrentPrice = currentPrice

	if position.Side == "buy" {
		position.UnrealizedPL = (currentPrice - position.EntryPrice) * position.RemainingQty
		position.UnrealizedPLPC = ((currentPrice - position.EntryPrice) / position.EntryPrice) * 100
	} else {
		position.UnrealizedPL = (position.EntryPrice - currentPrice) * position.RemainingQty
		position.UnrealizedPLPC = ((position.EntryPrice - currentPrice) / position.EntryPrice) * 100
	}

	position.UpdatedAt = time.Now()

	return nil
}

// GetManagedPosition retrieves a managed position by ID
func (pm *PositionManager) GetManagedPosition(positionID string) (*ManagedPosition, error) {
	pm.mu.RLock()
	defer pm.mu.RUnlock()

	position, exists := pm.positions[positionID]
	if !exists {
		return nil, fmt.Errorf("position not found: %s", positionID)
	}

	return position, nil
}

// ListManagedPositions returns all managed positions
// Filters out PENDING positions older than 24 hours (stale orders)
func (pm *PositionManager) ListManagedPositions(status string) []*ManagedPosition {
	pm.mu.RLock()
	defer pm.mu.RUnlock()

	positions := make([]*ManagedPosition, 0)
	now := time.Now()

	for _, pos := range pm.positions {
		// Filter out stale PENDING orders (>24 hours old)
		if pos.Status == "PENDING" {
			age := now.Sub(pos.CreatedAt)
			if age > 24*time.Hour {
				pm.logger.WithFields(logrus.Fields{
					"position_id": pos.ID,
					"symbol":      pos.Symbol,
					"age_hours":   age.Hours(),
				}).Debug("Skipping stale PENDING position")
				continue
			}
		}

		if status == "" || pos.Status == status {
			positions = append(positions, pos)
		}
	}

	return positions
}

// CloseManagedPosition manually closes a managed position.
//
// Fail-closed: a position is marked CLOSED only after the broker action that
// actually flattens it is confirmed *placed*. For an open position that means
// the market exit order; for a PENDING (unfilled) position it means the entry
// cancel. If that action errors, the position is left fully intact and an error
// is returned — we never write a CLOSED ledger row over a still-held broker
// position. That desync is what stranded Coil's UNH/ADI on 2026-05-26: a failed
// exit during a rate-limit storm left the broker holding shares (and, because
// the old code cancelled the stop first, unprotected) while the ledger said
// CLOSED.
func (pm *PositionManager) CloseManagedPosition(ctx context.Context, positionID string) error {
	pm.mu.RLock()
	position, exists := pm.positions[positionID]
	pm.mu.RUnlock()
	if !exists {
		return fmt.Errorf("position not found: %s", positionID)
	}

	switch position.Status {
	case "ACTIVE", "PARTIAL":
		// Liquidate via the broker's atomic close-position endpoint, and try it
		// FIRST, before touching the protective bracket, so a transient failure
		// (429/outage) leaves the position ACTIVE and still protected.
		//
		// The one exception is the resting protective bracket itself: its sell
		// orders reserve the full quantity (Alpaca held_for_orders), so a
		// full-quantity liquidation is rejected for "insufficient qty available"
		// while the bracket rests. When (and only when) we see that specific
		// rejection, cancel the bracket to free the shares, WAIT for the cancel
		// to actually settle at the broker, then liquidate again. The wait is
		// essential: Alpaca processes cancels asynchronously (pending_cancel →
		// canceled) and does not release the reserved shares until the order is
		// canceled, so an immediate retry races the cancel and hits the same
		// rejection — the 2026-06-03 race that left Coil's LIN and MO
		// ACTIVE-but-unprotected. If the retry still fails the stop is now gone,
		// so re-place it to restore protection before bailing (NEVER CLOSED).
		if position.RemainingQty > 0 {
			if err := pm.closeAndSavePosition(ctx, position); err != nil {
				if !isInsufficientQtyErr(err) {
					pm.logger.WithError(err).WithFields(logrus.Fields{
						"position_id":              position.ID,
						"symbol":                   position.Symbol,
						"operator_review_required": true,
					}).Error("Close failed: liquidation failed — position left open and protected (NOT marked CLOSED)")
					return fmt.Errorf("close %s: liquidation failed, position remains open: %w", position.Symbol, err)
				}

				// Shares are reserved by the resting protective bracket. Free
				// them, wait for the cancel to settle, then retry the liquidation.
				pm.logger.WithFields(logrus.Fields{
					"position_id": position.ID,
					"symbol":      position.Symbol,
				}).Warn("Liquidation rejected for insufficient available qty — cancelling protective bracket, waiting for the cancel to settle, retrying")
				pm.cancelBracketOrders(ctx, position)
				pm.waitForBracketReleased(ctx, position)

				if retryErr := pm.closeAndSavePosition(ctx, position); retryErr != nil {
					// Retry still failed and the bracket is now cancelled, so the
					// position is unprotected. Re-place the stop to restore
					// protection; leave ACTIVE and return the error (NEVER CLOSED).
					pm.logger.WithError(retryErr).WithFields(logrus.Fields{
						"position_id":              position.ID,
						"symbol":                   position.Symbol,
						"operator_review_required": true,
					}).Error("Close failed: liquidation retry failed after freeing reserved shares — re-placing stop to restore protection")
					if reErr := pm.placeStopLossOrder(ctx, position); reErr != nil {
						pm.logger.WithError(reErr).WithFields(logrus.Fields{
							"position_id":              position.ID,
							"symbol":                   position.Symbol,
							"operator_review_required": true,
						}).Error("Failed to re-place stop after a failed close — position is UNPROTECTED, manual intervention required")
					}
					return fmt.Errorf("close %s: liquidation rejected for reserved shares and retry failed, position remains open: %w", position.Symbol, retryErr)
				}
				// Retry succeeded; bracket already cancelled — fall through to CLOSED.
			} else {
				// Liquidation accepted on the first try — tear down the
				// now-redundant protective/partial orders.
				pm.cancelBracketOrders(ctx, position)
			}
		}

	case "PENDING":
		// Entry never filled — cancel the entry order. Fail-closed: if the
		// cancel errors, the entry can still fill and become an orphan, so do
		// NOT mark CLOSED.
		if position.EntryOrderID != "" {
			if err := pm.tradingService.CancelOrder(ctx, position.EntryOrderID); err != nil {
				pm.logger.WithError(err).WithFields(logrus.Fields{
					"position_id":              position.ID,
					"symbol":                   position.Symbol,
					"operator_review_required": true,
				}).Error("Close failed: could not cancel pending entry order — position left PENDING (NOT marked CLOSED)")
				return fmt.Errorf("close %s: pending entry cancel failed, position remains pending: %w", position.Symbol, err)
			}
			pm.logger.WithField("order_id", position.EntryOrderID).Info("Cancelled pending entry order")
		}

	default:
		// CLOSED / STOPPED_OUT / FAILED — already terminal. Idempotent no-op so
		// a double-close can't place a spurious order.
		pm.logger.WithFields(logrus.Fields{
			"position_id": position.ID,
			"status":      position.Status,
		}).Debug("CloseManagedPosition called on a terminal position — no-op")
		return nil
	}

	pm.mu.Lock()
	position.Status = "CLOSED"
	now := time.Now()
	position.ClosedAt = &now
	position.UpdatedAt = now
	pm.mu.Unlock()

	if err := pm.savePositionToDB(position); err != nil {
		pm.logger.WithError(err).WithFields(logrus.Fields{
			"position_id":              positionID,
			"operator_review_required": true,
		}).Error("Failed to persist CLOSED status after close — may resurrect on reload")
	}

	pm.logger.WithField("position_id", positionID).Info("Position manually closed")
	return nil
}

// cancelBracketOrders cancels a position's stop-loss, take-profit, and any
// partial-exit orders, best-effort. Called only after the exit order has been
// placed, so cancel errors are non-fatal — the orders may already be filled or
// cancelled, and the exit is already in flight.
func (pm *PositionManager) cancelBracketOrders(ctx context.Context, position *ManagedPosition) {
	if position.StopLossOrderID != "" {
		if err := pm.tradingService.CancelOrder(ctx, position.StopLossOrderID); err != nil {
			pm.logger.WithError(err).WithField("order_id", position.StopLossOrderID).Warn("Failed to cancel stop loss order (may already be filled/cancelled)")
		}
	}
	if position.TakeProfitOrderID != "" {
		if err := pm.tradingService.CancelOrder(ctx, position.TakeProfitOrderID); err != nil {
			pm.logger.WithError(err).WithField("order_id", position.TakeProfitOrderID).Warn("Failed to cancel take profit order (may already be filled/cancelled)")
		}
	}
	for _, orderID := range position.PartialExitOrders {
		if err := pm.tradingService.CancelOrder(ctx, orderID); err != nil {
			pm.logger.WithError(err).WithField("order_id", orderID).Warn("Failed to cancel partial exit order (may already be cancelled)")
		}
	}
}

// closeAndSavePosition liquidates the position's remaining quantity via the
// broker's atomic close-position endpoint and best-effort persists the
// resulting DBOrder for attribution. It returns the broker error verbatim so
// callers can classify it (see isInsufficientQtyErr) and does NOT mutate
// position status.
func (pm *PositionManager) closeAndSavePosition(ctx context.Context, position *ManagedPosition) error {
	result, err := pm.tradingService.ClosePosition(ctx, position.Symbol, position.RemainingQty)
	if err != nil {
		return err
	}
	if pm.storageService != nil {
		exitSide := "sell"
		if position.Side == "sell" {
			exitSide = "buy"
		}
		closeOrder := &interfaces.Order{
			ID:          result.OrderID,
			Symbol:      position.Symbol,
			Qty:         position.RemainingQty,
			Side:        exitSide,
			Type:        "market",
			Status:      result.Status,
			SubmittedAt: time.Now(),
			// Tag with the owning agent's strategy so the resulting DBOrder is
			// attributable (matches placeEntryOrder / flattenUnprotected).
			Strategy: position.AgentStrategy,
		}
		if saveErr := pm.storageService.SaveOrder(closeOrder); saveErr != nil {
			pm.logger.WithError(saveErr).WithField("order_id", result.OrderID).Warn("Failed to save close order to database")
		}
	}
	pm.logger.WithFields(logrus.Fields{
		"position_id": position.ID,
		"order_id":    result.OrderID,
		"quantity":    position.RemainingQty,
	}).Info("Liquidated position via broker close-position endpoint")
	return nil
}

// waitForBracketReleased blocks until every cancelled bracket leg reaches a
// terminal broker state — the point at which the broker releases the shares
// those resting sell orders reserved — or a bounded poll budget is exhausted.
// Alpaca processes cancels asynchronously (pending_cancel → canceled) and does
// not free the reserved shares until the order is actually canceled, so a
// liquidation fired immediately after cancelBracketOrders races the cancel and
// hits the same "insufficient qty" rejection (the 2026-06-03 Coil LIN/MO close
// failure). Best-effort: a poll error or an exhausted budget just falls through
// — the caller's retry surfaces any block that remains.
func (pm *PositionManager) waitForBracketReleased(ctx context.Context, position *ManagedPosition) {
	ids := make([]string, 0, 2+len(position.PartialExitOrders))
	if position.StopLossOrderID != "" {
		ids = append(ids, position.StopLossOrderID)
	}
	if position.TakeProfitOrderID != "" {
		ids = append(ids, position.TakeProfitOrderID)
	}
	ids = append(ids, position.PartialExitOrders...)
	if len(ids) == 0 {
		return
	}

	for i := 0; i < pm.cancelSettleMax; i++ {
		if pm.bracketReleased(ctx, ids) {
			return
		}
		if pm.cancelSettlePoll > 0 {
			time.Sleep(pm.cancelSettlePoll)
		}
	}
	pm.logger.WithFields(logrus.Fields{
		"position_id": position.ID,
		"symbol":      position.Symbol,
	}).Warn("Protective bracket cancel did not settle within the wait budget — retrying liquidation anyway")
}

// bracketReleased reports whether every given order is in a terminal broker
// state (its reserved shares released). A read error or a still-pending order
// (e.g. pending_cancel) means not-yet-released.
func (pm *PositionManager) bracketReleased(ctx context.Context, ids []string) bool {
	for _, id := range ids {
		ord, err := pm.tradingService.GetOrder(ctx, id)
		if err != nil || ord == nil || !isTerminalBrokerOrderStatus(ord.Status) {
			return false
		}
	}
	return true
}

// isTerminalBrokerOrderStatus reports whether an Alpaca order status is terminal
// — the order will not transition further and any shares it reserved have been
// released. Notably pending_cancel / pending_replace are NOT terminal: the
// shares stay reserved until the order actually reaches canceled.
func isTerminalBrokerOrderStatus(status string) bool {
	switch strings.ToLower(status) {
	case "canceled", "cancelled", "filled", "expired", "rejected", "replaced", "done_for_day":
		return true
	default:
		return false
	}
}

// isInsufficientQtyErr reports whether a broker PlaceOrder error indicates the
// order was rejected because the position's shares are already reserved by an
// open order (Alpaca: "insufficient qty available for order ... available: 0").
// That is the signal that a resting protective stop is blocking the exit — the
// only case in which cancelling the bracket and retrying is correct. It
// deliberately does NOT match transient failures (429, timeouts), for which the
// protective bracket must be left intact.
func isInsufficientQtyErr(err error) bool {
	if err == nil {
		return false
	}
	s := strings.ToLower(err.Error())
	return strings.Contains(s, "insufficient qty") || strings.Contains(s, "insufficient quantity")
}

// isTerminalStatus reports whether a managed-position status is terminal — the
// position is done from this agent's point of view. Any other status
// (ACTIVE/PARTIAL/PENDING or unknown) is treated as non-terminal/live, so a
// malformed record can never be mistaken for an orphan source.
func isTerminalStatus(status string) bool {
	return status == "CLOSED" || status == "STOPPED_OUT" || status == "FAILED"
}

// findOrphans returns the broker positions this agent considers orphans: the
// broker holds the symbol, this PM has at least one managed record for it, and
// EVERY record for that symbol is terminal (CLOSED/STOPPED_OUT/FAILED). Symbols
// with a non-terminal record (live) or with no record at all (another agent's
// position on the shared broker account) are excluded. Pure — no I/O, no locks.
func findOrphans(brokerPositions []*interfaces.Position, managed []*ManagedPosition) []OrphanAlert {
	hasNonTerminal := make(map[string]bool)
	terminal := make(map[string]*ManagedPosition) // symbol -> a terminal record
	for _, p := range managed {
		if p == nil {
			continue
		}
		if isTerminalStatus(p.Status) {
			if _, seen := terminal[p.Symbol]; !seen {
				terminal[p.Symbol] = p
			}
		} else {
			hasNonTerminal[p.Symbol] = true
		}
	}

	now := time.Now()
	var orphans []OrphanAlert
	for _, bp := range brokerPositions {
		if bp == nil || bp.Qty == 0 {
			continue
		}
		if hasNonTerminal[bp.Symbol] {
			continue // a live record exists — normal position
		}
		rec, ok := terminal[bp.Symbol]
		if !ok {
			continue // no record for this symbol — another agent's position
		}
		orphans = append(orphans, OrphanAlert{
			Symbol:       bp.Symbol,
			BrokerQty:    bp.Qty,
			PositionID:   rec.ID,
			LedgerStatus: rec.Status,
			ClosedAt:     rec.ClosedAt,
			DetectedAt:   now,
		})
	}
	return orphans
}

// detectOrphans is the report-only orphan check. It finds broker positions this
// agent's ledger has marked terminal while the broker still holds them, logs each
// newly-detected one for operator review, and refreshes the orphans report when
// the set changes. It places NO orders. Called from reconcileWithBroker, reusing
// the broker positions already read there.
func (pm *PositionManager) detectOrphans(brokerPositions []*interfaces.Position) {
	pm.mu.Lock()
	managed := make([]*ManagedPosition, 0, len(pm.positions))
	for _, p := range pm.positions {
		managed = append(managed, p)
	}
	pm.mu.Unlock()

	orphans := findOrphans(brokerPositions, managed)

	current := make(map[string]bool, len(orphans))
	for _, o := range orphans {
		current[o.Symbol] = true
	}

	pm.mu.Lock()
	var newly []OrphanAlert
	changed := false
	for _, o := range orphans {
		if !pm.orphanAlerted[o.Symbol] {
			pm.orphanAlerted[o.Symbol] = true
			newly = append(newly, o)
			changed = true
		}
	}
	for sym := range pm.orphanAlerted {
		if !current[sym] {
			delete(pm.orphanAlerted, sym)
			changed = true
		}
	}
	pm.mu.Unlock()

	for _, o := range newly {
		pm.logger.WithFields(logrus.Fields{
			"symbol":                   o.Symbol,
			"broker_qty":               o.BrokerQty,
			"position_id":              o.PositionID,
			"ledger_status":            o.LedgerStatus,
			"operator_review_required": true,
		}).Error("Orphan position detected — ledger marked terminal but broker still holds shares (no order placed)")
	}

	if changed && pm.orphanReporter != nil {
		if err := pm.orphanReporter.Report(orphans); err != nil {
			pm.logger.WithError(err).Warn("Failed to write orphans report")
		}
	}
}

// Helper functions

func (pm *PositionManager) validateRequest(req *PlaceManagedPositionRequest) error {
	// Managed positions are equity-only. Sizing assumes 1 unit = 1 share (no
	// ×100 options multiplier), entries go through the stock order path, and the
	// stock quote endpoint returns HTTP 400 "invalid symbol" for OCC symbols.
	// Reject options up front with a clear pointer instead of oversizing ~100x
	// or failing deep in the price fetch (observed: Prophet QQQ260717C00728000,
	// 2026-05-27). Prophet's options entries go through place_options_order.
	if IsOptionSymbol(req.Symbol) {
		return fmt.Errorf("managed positions are equity-only; %q is an option — use place_options_order for options entries", req.Symbol)
	}

	if req.Side != "buy" && req.Side != "sell" {
		return fmt.Errorf("side must be 'buy' or 'sell'")
	}

	if req.EntryStrategy == "limit" && req.EntryPrice == nil {
		return fmt.Errorf("entry_price required for limit orders")
	}

	if req.StopLossPrice == nil && req.StopLossPercent == nil {
		return fmt.Errorf("either stop_loss_price or stop_loss_percent required")
	}

	if req.TakeProfitPrice == nil && req.TakeProfitPercent == nil {
		return fmt.Errorf("either take_profit_price or take_profit_percent required")
	}

	return nil
}

func (pm *PositionManager) getCurrentPrice(ctx context.Context, symbol string) (float64, error) {
	quote, err := pm.dataService.GetLatestQuote(ctx, symbol)
	if err != nil {
		return 0, err
	}

	if quote.AskPrice > 0 {
		return quote.AskPrice, nil
	}

	return quote.BidPrice, nil
}

func (pm *PositionManager) calculateQuantity(allocation, price float64) float64 {
	return math.Floor(allocation / price)
}

func (pm *PositionManager) calculateStopLoss(entryPrice float64, stopPrice *float64, stopPercent *float64, side string) float64 {
	if stopPrice != nil {
		return roundToTick(*stopPrice)
	}

	if side == "buy" {
		return roundToTick(entryPrice * (1 - *stopPercent/100.0))
	}

	return roundToTick(entryPrice * (1 + *stopPercent/100.0))
}

func (pm *PositionManager) calculateTakeProfit(entryPrice float64, profitPrice *float64, profitPercent *float64, side string) float64 {
	if profitPrice != nil {
		return roundToTick(*profitPrice)
	}

	if side == "buy" {
		return roundToTick(entryPrice * (1 + *profitPercent/100.0))
	}

	return roundToTick(entryPrice * (1 - *profitPercent/100.0))
}

func (pm *PositionManager) calculatePartialExitPrice(entryPrice, targetPercent float64, side string) float64 {
	if side == "buy" {
		return roundToTick(entryPrice * (1 + targetPercent/100.0))
	}

	return roundToTick(entryPrice * (1 - targetPercent/100.0))
}

// roundToTick snaps a price to Alpaca's minimum increment so stop / limit
// orders don't get rejected with HTTP 422 code 42210000 ("sub-penny increment
// does not fulfill minimum pricing criteria"). Per Alpaca: stocks priced at or
// above $1.00 must trade in $0.01 increments; below $1.00 they may use up to
// $0.0001. We round (not floor) to keep the price within the intended buffer
// — a long-side stop snapped down would widen the loss; snapped up tightens
// it; the symmetric round-half-to-even policy is a wash on average.
func roundToTick(price float64) float64 {
	if price < 1.0 {
		return math.Round(price*10000) / 10000
	}
	return math.Round(price*100) / 100
}

func (pm *PositionManager) generatePositionID() string {
	return fmt.Sprintf("pos_%d", time.Now().UnixNano())
}

func appendTagIfMissing(tags []string, tag string) []string {
	for _, t := range tags {
		if t == tag {
			return tags
		}
	}
	return append(tags, tag)
}

// SetGuard attaches a trade guard to the position manager.
func (pm *PositionManager) SetGuard(guard *TradeGuard) {
	pm.guard = guard
}

// Stop stops the position manager
func (pm *PositionManager) Stop() {
	pm.cancel()
}

// loadPositionsFromDB loads all active positions from database on startup
func (pm *PositionManager) loadPositionsFromDB() error {
	// Load all non-closed positions
	dbPositions, err := pm.storageService.GetAllManagedPositions("")
	if err != nil {
		return err
	}

	loaded := 0
	for _, dbPos := range dbPositions {
		// Skip closed positions
		if dbPos.Status == "CLOSED" || dbPos.Status == "STOPPED_OUT" {
			continue
		}

		// Convert DB position to managed position
		position := pm.dbToManagedPosition(dbPos)

		// Store in memory
		pm.positions[position.ID] = position
		loaded++
	}

	pm.logger.WithField("count", loaded).Debug("Loaded managed positions from database")
	return nil
}

// savePositionToDB saves a managed position to database
func (pm *PositionManager) savePositionToDB(position *ManagedPosition) error {
	dbPosition := pm.managedPositionToDB(position)
	return pm.storageService.SaveManagedPosition(dbPosition)
}

// managedPositionToDB converts ManagedPosition to DBManagedPosition
func (pm *PositionManager) managedPositionToDB(pos *ManagedPosition) *models.DBManagedPosition {
	// Convert partial exit orders to JSON
	partialExitOrdersJSON, _ := json.Marshal(pos.PartialExitOrders)

	// Convert tags to JSON
	tagsJSON, _ := json.Marshal(pos.Tags)

	dbPos := &models.DBManagedPosition{
		PositionID:        pos.ID,
		Symbol:            pos.Symbol,
		Side:              pos.Side,
		Strategy:          pos.Strategy,
		AgentStrategy:     pos.AgentStrategy,
		Quantity:          pos.Quantity,
		EntryPrice:        pos.EntryPrice,
		EntryOrderID:      pos.EntryOrderID,
		EntryOrderType:    pos.EntryOrderType,
		AllocationDollars: pos.AllocationDollars,
		StopLossPrice:     pos.StopLossPrice,
		StopLossPercent:   pos.StopLossPercent,
		StopLossOrderID:   pos.StopLossOrderID,
		TrailingStop:      pos.TrailingStop,
		TrailingPercent:   pos.TrailingPercent,
		TakeProfitPrice:   pos.TakeProfitPrice,
		TakeProfitPercent: pos.TakeProfitPercent,
		TakeProfitOrderID: pos.TakeProfitOrderID,
		Status:            pos.Status,
		CurrentPrice:      pos.CurrentPrice,
		UnrealizedPL:      pos.UnrealizedPL,
		UnrealizedPLPC:    pos.UnrealizedPLPC,
		RemainingQty:      pos.RemainingQty,
		Notes:             pos.Notes,
		Tags:              string(tagsJSON),
		PartialExitOrders: string(partialExitOrdersJSON),
		ClosedAt:          pos.ClosedAt,
	}

	if pos.PartialExit != nil {
		dbPos.PartialExitEnabled = pos.PartialExit.Enabled
		dbPos.PartialExitPercent = pos.PartialExit.Percent
		dbPos.PartialExitTargetPercent = pos.PartialExit.TargetPercent
		dbPos.PartialExitTargetPrice = pos.PartialExit.TargetPrice
	}

	return dbPos
}

// todayMarketClose returns regular-session close in UTC for the date of `now`.
// Weekends return a zero time.
// dbToManagedPosition converts DBManagedPosition to ManagedPosition
func (pm *PositionManager) dbToManagedPosition(dbPos *models.DBManagedPosition) *ManagedPosition {
	// Parse partial exit orders from JSON
	var partialExitOrders []string
	if dbPos.PartialExitOrders != "" {
		json.Unmarshal([]byte(dbPos.PartialExitOrders), &partialExitOrders)
	}

	// Parse tags from JSON
	var tags []string
	if dbPos.Tags != "" {
		json.Unmarshal([]byte(dbPos.Tags), &tags)
	}

	pos := &ManagedPosition{
		ID:                dbPos.PositionID,
		Symbol:            dbPos.Symbol,
		Side:              dbPos.Side,
		Strategy:          dbPos.Strategy,
		AgentStrategy:     dbPos.AgentStrategy,
		Quantity:          dbPos.Quantity,
		EntryPrice:        dbPos.EntryPrice,
		EntryOrderID:      dbPos.EntryOrderID,
		EntryOrderType:    dbPos.EntryOrderType,
		AllocationDollars: dbPos.AllocationDollars,
		StopLossPrice:     dbPos.StopLossPrice,
		StopLossPercent:   dbPos.StopLossPercent,
		StopLossOrderID:   dbPos.StopLossOrderID,
		TrailingStop:      dbPos.TrailingStop,
		TrailingPercent:   dbPos.TrailingPercent,
		TakeProfitPrice:   dbPos.TakeProfitPrice,
		TakeProfitPercent: dbPos.TakeProfitPercent,
		TakeProfitOrderID: dbPos.TakeProfitOrderID,
		Status:            dbPos.Status,
		CurrentPrice:      dbPos.CurrentPrice,
		UnrealizedPL:      dbPos.UnrealizedPL,
		UnrealizedPLPC:    dbPos.UnrealizedPLPC,
		RemainingQty:      dbPos.RemainingQty,
		Notes:             dbPos.Notes,
		Tags:              tags,
		PartialExitOrders: partialExitOrders,
		CreatedAt:         dbPos.CreatedAt,
		UpdatedAt:         dbPos.UpdatedAt,
		ClosedAt:          dbPos.ClosedAt,
	}

	if dbPos.PartialExitEnabled {
		pos.PartialExit = &PartialExitConfig{
			Enabled:       dbPos.PartialExitEnabled,
			Percent:       dbPos.PartialExitPercent,
			TargetPercent: dbPos.PartialExitTargetPercent,
			TargetPrice:   dbPos.PartialExitTargetPrice,
		}
	}

	return pos
}
