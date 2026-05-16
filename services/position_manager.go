package services

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"prophet-trader/database"
	"prophet-trader/interfaces"
	"prophet-trader/models"
	"sync"
	"time"

	"github.com/sirupsen/logrus"
)

// ManagedPosition represents a position with automated risk management
type ManagedPosition struct {
	ID                string                 `json:"id"`
	Symbol            string                 `json:"symbol"`
	Side              string                 `json:"side"` // "buy" or "sell"
	Strategy          string                 `json:"strategy"` // "SWING_TRADE", "LONG_TERM", "DAY_TRADE"
	// AgentStrategy is the owning agent's strategyId (e.g. "penny-momentum",
	// "trend"). Distinct from Strategy, which is the trading-style label.
	// Populated from OPENPROPHET_STRATEGY at the MCP boundary.
	AgentStrategy     string                 `json:"agent_strategy,omitempty"`

	// Entry details
	Quantity          float64                `json:"quantity"`
	EntryPrice        float64                `json:"entry_price"`
	EntryOrderID      string                 `json:"entry_order_id"`
	EntryOrderType    string                 `json:"entry_order_type"` // "market", "limit"
	AllocationDollars float64                `json:"allocation_dollars"`

	// Risk management
	StopLossPrice     float64                `json:"stop_loss_price"`
	StopLossPercent   float64                `json:"stop_loss_percent"`
	StopLossOrderID   string                 `json:"stop_loss_order_id,omitempty"`
	TrailingStop      bool                   `json:"trailing_stop"`
	TrailingPercent   float64                `json:"trailing_percent,omitempty"`

	// Profit targets
	TakeProfitPrice   float64                `json:"take_profit_price"`
	TakeProfitPercent float64                `json:"take_profit_percent"`
	TakeProfitOrderID string                 `json:"take_profit_order_id,omitempty"`

	// Partial exit strategy
	PartialExit       *PartialExitConfig     `json:"partial_exit,omitempty"`
	PartialExitOrders []string               `json:"partial_exit_orders,omitempty"`

	// Status tracking
	Status            string                 `json:"status"` // "PENDING", "ACTIVE", "PARTIAL", "CLOSED", "STOPPED_OUT", "FAILED"
	CurrentPrice      float64                `json:"current_price"`
	UnrealizedPL      float64                `json:"unrealized_pl"`
	UnrealizedPLPC    float64                `json:"unrealized_pl_percent"`
	RemainingQty      float64                `json:"remaining_qty"`

	// Metadata
	CreatedAt         time.Time              `json:"created_at"`
	UpdatedAt         time.Time              `json:"updated_at"`
	ClosedAt          *time.Time             `json:"closed_at,omitempty"`
	Notes             string                 `json:"notes,omitempty"`
	Tags              []string               `json:"tags,omitempty"`
	// DominantSignal classifies penny entries by signal type. Drives
	// the social-signal 20-minute time exit in checkPositions. Empty
	// for non-penny managed positions.
	DominantSignal    string                 `json:"dominant_signal,omitempty"`
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
	Side              string      `json:"side" binding:"required"` // "buy" or "sell"
	Strategy          string      `json:"strategy"`                // "SWING_TRADE", "LONG_TERM", "DAY_TRADE"
	AgentStrategy     string      `json:"agent_strategy,omitempty"` // agent strategyId from OPENPROPHET_STRATEGY (e.g. "penny-momentum")
	AgentSource       AgentSource `json:"agent_source,omitempty"`  // "main" or "penny"; defaults to "main"
	AllocationDollars float64     `json:"allocation_dollars" binding:"required,gt=0"`

	// Entry configuration
	EntryStrategy     string              `json:"entry_strategy"` // "market", "limit"
	EntryPrice        *float64            `json:"entry_price,omitempty"` // Required for limit orders

	// Risk management (one of these required)
	StopLossPrice     *float64            `json:"stop_loss_price,omitempty"`
	StopLossPercent   *float64            `json:"stop_loss_percent,omitempty"`
	TrailingStop      bool                `json:"trailing_stop"`
	TrailingPercent   float64             `json:"trailing_percent,omitempty"`

	// Profit targets (one of these required)
	TakeProfitPrice   *float64            `json:"take_profit_price,omitempty"`
	TakeProfitPercent *float64            `json:"take_profit_percent,omitempty"`

	// Partial exit (optional)
	PartialExit       *PartialExitConfig  `json:"partial_exit,omitempty"`

	// Metadata
	Notes             string              `json:"notes,omitempty"`
	Tags              []string            `json:"tags,omitempty"`
	DominantSignal    string              `json:"dominant_signal,omitempty"`
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
		tradingService: tradingService,
		dataService:    dataService,
		storageService: storageService,
		positions:      make(map[string]*ManagedPosition),
		logger:         logger,
		ctx:            ctx,
		cancel:         cancel,
	}

	// Load existing positions from database
	if err := pm.loadPositionsFromDB(); err != nil {
		logger.WithError(err).Error("Failed to load positions from database")
	}

	return pm
}

// PlaceManagedPosition opens a new managed position with automated risk management
func (pm *PositionManager) PlaceManagedPosition(ctx context.Context, req *PlaceManagedPositionRequest) (*ManagedPosition, error) {
	pm.logger.WithFields(logrus.Fields{
		"symbol":     req.Symbol,
		"side":       req.Side,
		"allocation": req.AllocationDollars,
	}).Info("Placing managed position")

	// Resolve agent source
	agent := req.AgentSource
	if agent == "" {
		agent = AgentMain
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
		DominantSignal:    req.DominantSignal,
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
		Strategy:    position.AgentStrategy,
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

	for {
		select {
		case <-ctx.Done():
			pm.logger.Info("Position monitoring stopped")
			return
		case <-ticker.C:
			pm.checkPositions(ctx)
		}
	}
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

		// Social-signal time exit (penny only). Fires before bracket
		// management so the cancel-and-sell flow takes precedence over
		// any pending stop/target placement on the same tick.
		now := time.Now().UTC()
		marketClose := pm.todayMarketClose(now)
		if shouldFireSocialTimeExit(position, now, marketClose) {
			if err := pm.executeSocialTimeExit(ctx, position); err != nil {
				pm.logger.WithError(err).WithField("position_id", position.ID).Warn("social time exit failed")
			}
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

// checkEntryOrder checks if entry order has filled
func (pm *PositionManager) checkEntryOrder(ctx context.Context, position *ManagedPosition) {
	order, err := pm.tradingService.GetOrder(ctx, position.EntryOrderID)
	if err != nil {
		pm.logger.WithError(err).Error("Failed to get entry order")
		return
	}

	if order.Status == "filled" {
		position.Status = "ACTIVE"
		position.EntryPrice = *order.FilledAvgPrice
		position.UpdatedAt = time.Now()

		pm.logger.WithFields(logrus.Fields{
			"position_id": position.ID,
			"symbol":      position.Symbol,
			"fill_price":  position.EntryPrice,
		}).Info("Entry order filled - position now active")

		// Place risk management orders
		pm.placeRiskOrders(ctx, position)

		// Save to database
		pm.savePositionToDB(position)
	}
}

// placeRiskOrders places stop loss and take profit orders
func (pm *PositionManager) placeRiskOrders(ctx context.Context, position *ManagedPosition) {
	// Place stop loss order
	if err := pm.placeStopLossOrder(ctx, position); err != nil {
		pm.logger.WithError(err).Error("Failed to place stop loss order")
	}

	// Place take profit order
	if err := pm.placeTakeProfitOrder(ctx, position); err != nil {
		pm.logger.WithError(err).Error("Failed to place take profit order")
	}

	// Place partial exit order if configured
	if position.PartialExit != nil && position.PartialExit.Enabled {
		if err := pm.placePartialExitOrder(ctx, position); err != nil {
			pm.logger.WithError(err).Error("Failed to place partial exit order")
		}
	}
}

// placeStopLossOrder places or updates stop loss order
func (pm *PositionManager) placeStopLossOrder(ctx context.Context, position *ManagedPosition) error {
	exitSide := "sell"
	if position.Side == "sell" {
		exitSide = "buy"
	}

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
		newStopPrice := position.CurrentPrice * (1 - position.TrailingPercent/100.0)
		if newStopPrice > position.StopLossPrice {
			// Cancel old stop loss order
			if position.StopLossOrderID != "" {
				pm.tradingService.CancelOrder(ctx, position.StopLossOrderID)
			}

			// Update stop price and place new order
			position.StopLossPrice = newStopPrice
			pm.placeStopLossOrder(ctx, position)

			pm.logger.WithFields(logrus.Fields{
				"position_id":    position.ID,
				"new_stop_price": newStopPrice,
			}).Info("Trailing stop updated")
		}
	} else {
		// For short positions, lower stop as price falls
		newStopPrice := position.CurrentPrice * (1 + position.TrailingPercent/100.0)
		if newStopPrice < position.StopLossPrice {
			if position.StopLossOrderID != "" {
				pm.tradingService.CancelOrder(ctx, position.StopLossOrderID)
			}

			position.StopLossPrice = newStopPrice
			pm.placeStopLossOrder(ctx, position)

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

// HeldPennyTickers returns a set of currently-open penny-strategy positions
// keyed by ticker. Used by SECEdgarService to detect dilution events landing
// on positions the agent holds. Returns an empty (non-nil) map if no penny
// positions are open.
//
// "Active" matches the existing isActivePosition predicate (ACTIVE, PARTIAL,
// PENDING). Penny ownership is determined via the AgentTag(AgentPenny) tag,
// matching the convention used by TradeGuard.
func (pm *PositionManager) HeldPennyTickers() map[string]bool {
	pm.mu.RLock()
	defer pm.mu.RUnlock()
	held := make(map[string]bool)
	for _, p := range pm.positions {
		if !isActivePosition(p) {
			continue
		}
		if positionBelongsTo(p, AgentPenny) {
			held[p.Symbol] = true
		}
	}
	return held
}

// CloseManagedPosition manually closes a managed position
func (pm *PositionManager) CloseManagedPosition(ctx context.Context, positionID string) error {
	pm.mu.RLock()
	position, exists := pm.positions[positionID]
	pm.mu.RUnlock()

	if !exists {
		return fmt.Errorf("position not found: %s", positionID)
	}

	// Cancel all open orders (ignore errors - orders may already be cancelled or market closed)

	// Cancel entry order if still pending
	if position.EntryOrderID != "" {
		if err := pm.tradingService.CancelOrder(ctx, position.EntryOrderID); err != nil {
			pm.logger.WithError(err).Warn("Failed to cancel entry order (may already be filled/cancelled)")
		} else {
			pm.logger.WithField("order_id", position.EntryOrderID).Info("Cancelled entry order")
		}
	}

	if position.StopLossOrderID != "" {
		if err := pm.tradingService.CancelOrder(ctx, position.StopLossOrderID); err != nil {
			pm.logger.WithError(err).Warn("Failed to cancel stop loss order (may already be cancelled)")
		} else {
			pm.logger.WithField("order_id", position.StopLossOrderID).Info("Cancelled stop loss order")
		}
	}
	if position.TakeProfitOrderID != "" {
		if err := pm.tradingService.CancelOrder(ctx, position.TakeProfitOrderID); err != nil {
			pm.logger.WithError(err).Warn("Failed to cancel take profit order (may already be cancelled)")
		} else {
			pm.logger.WithField("order_id", position.TakeProfitOrderID).Info("Cancelled take profit order")
		}
	}
	for _, orderID := range position.PartialExitOrders {
		if err := pm.tradingService.CancelOrder(ctx, orderID); err != nil {
			pm.logger.WithError(err).Warn("Failed to cancel partial exit order (may already be cancelled)")
		} else {
			pm.logger.WithField("order_id", orderID).Info("Cancelled partial exit order")
		}
	}

	// Place market order to close remaining position (ONLY if position is ACTIVE/PARTIAL - i.e., entry was filled)
	if position.Status == "ACTIVE" || position.Status == "PARTIAL" {
		if position.RemainingQty > 0 {
			exitSide := "sell"
			if position.Side == "sell" {
				exitSide = "buy"
			}

			order := &interfaces.Order{
				Symbol:      position.Symbol,
				Qty:         position.RemainingQty,
				Side:        exitSide,
				Type:        "market",
				TimeInForce: "day",
				Status:      "pending",
				SubmittedAt: time.Now(),
			}

			_, err := pm.tradingService.PlaceOrder(ctx, order)
			if err != nil {
				// Log error but still close the position in our system
				pm.logger.WithError(err).Error("Failed to place exit order (market may be closed)")
				pm.logger.Info("Closing position in database despite order error")
			} else {
				pm.logger.WithField("quantity", position.RemainingQty).Info("Placed market exit order")
			}
		}
	} else if position.Status == "PENDING" {
		// For pending positions, just log that we cancelled the entry order
		pm.logger.WithField("position_id", position.ID).Info("Closed pending position (entry order was never filled)")
	}

	position.Status = "CLOSED"
	now := time.Now()
	position.ClosedAt = &now

	// Save to database
	pm.savePositionToDB(position)

	pm.logger.WithField("position_id", positionID).Info("Position manually closed")

	return nil
}

// Helper functions

func (pm *PositionManager) validateRequest(req *PlaceManagedPositionRequest) error {
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
		return *stopPrice
	}

	if side == "buy" {
		return entryPrice * (1 - *stopPercent/100.0)
	}

	return entryPrice * (1 + *stopPercent/100.0)
}

func (pm *PositionManager) calculateTakeProfit(entryPrice float64, profitPrice *float64, profitPercent *float64, side string) float64 {
	if profitPrice != nil {
		return *profitPrice
	}

	if side == "buy" {
		return entryPrice * (1 + *profitPercent/100.0)
	}

	return entryPrice * (1 - *profitPercent/100.0)
}

func (pm *PositionManager) calculatePartialExitPrice(entryPrice, targetPercent float64, side string) float64 {
	if side == "buy" {
		return entryPrice * (1 + targetPercent/100.0)
	}

	return entryPrice * (1 - targetPercent/100.0)
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
		DominantSignal:    pos.DominantSignal,
	}

	if pos.PartialExit != nil {
		dbPos.PartialExitEnabled = pos.PartialExit.Enabled
		dbPos.PartialExitPercent = pos.PartialExit.Percent
		dbPos.PartialExitTargetPercent = pos.PartialExit.TargetPercent
		dbPos.PartialExitTargetPrice = pos.PartialExit.TargetPrice
	}

	return dbPos
}

// shouldFireSocialTimeExit returns true when pos is a social-signal penny
// position that has either (a) been open >= 20 min OR (b) entered the
// last-15-min-of-session window — whichever comes first. Mirrors the rule
// in TRADING_RULES_PENNY.md lines 261-263.
//
// Returns false for positions whose Status is not ACTIVE or PARTIAL — the
// bracket monitor has already taken care of STOPPED_OUT/CLOSED/FAILED, and
// PENDING positions don't have a bracket to cancel yet.
func shouldFireSocialTimeExit(pos *ManagedPosition, now, marketClose time.Time) bool {
	if pos == nil || pos.DominantSignal != "social" {
		return false
	}
	if pos.Status != "ACTIVE" && pos.Status != "PARTIAL" {
		return false
	}
	if now.Sub(pos.CreatedAt) >= 20*time.Minute {
		return true
	}
	if !marketClose.IsZero() && marketClose.Sub(now) <= 15*time.Minute {
		return true
	}
	return false
}

// todayMarketClose returns regular-session close in UTC for the date of `now`.
// Weekends return a zero time — the "15 min before close" branch then never
// fires on a weekend, which is correct: penny social positions should be flat
// by Friday close per the rules.
func (pm *PositionManager) todayMarketClose(now time.Time) time.Time {
	et, err := time.LoadLocation("America/New_York")
	if err != nil {
		return time.Time{}
	}
	local := now.In(et)
	wd := local.Weekday()
	if wd == time.Saturday || wd == time.Sunday {
		return time.Time{}
	}
	close := time.Date(local.Year(), local.Month(), local.Day(), 16, 0, 0, 0, et)
	return close.UTC()
}

// executeSocialTimeExit implements the cancel-bracket then market-sell flow
// from TRADING_RULES_PENNY.md:261-282.
//
//  1. Cancel both stop-loss and take-profit orders if present. Failures here
//     are non-fatal (the order may have already filled — the bracket monitor
//     will detect it).
//  2. Re-fetch position state to see if a bracket leg fired during cancellation;
//     if so, skip the market order.
//  3. Place a market sell for RemainingQty, tagged with the owning agent's
//     strategy so /api/v1/positions?strategy=X attribution stays correct.
func (pm *PositionManager) executeSocialTimeExit(ctx context.Context, pos *ManagedPosition) error {
	pm.logger.WithFields(logrus.Fields{
		"position_id": pos.ID,
		"symbol":      pos.Symbol,
		"age":         time.Since(pos.CreatedAt).String(),
	}).Info("social-signal time exit firing")

	// Cancel bracket legs; track whether either leg actually filled at the
	// broker (cancel returns an error, but the order's terminal status will
	// be "filled" not "canceled"). If a leg filled, the bracket closed the
	// position for us — skip the market sell to avoid duplicating.
	bracketFilled := false
	for _, orderID := range []string{pos.StopLossOrderID, pos.TakeProfitOrderID} {
		if orderID == "" {
			continue
		}
		if err := pm.tradingService.CancelOrder(ctx, orderID); err != nil {
			pm.logger.WithError(err).WithField("order_id", orderID).Debug("cancel returned error (checking final order status)")
		}
		// Always re-read the order's status — cancel result alone doesn't
		// distinguish "canceled cleanly" from "filled while we were cancelling".
		ord, err := pm.tradingService.GetOrder(ctx, orderID)
		if err != nil {
			pm.logger.WithError(err).WithField("order_id", orderID).Warn("could not fetch order status after cancel")
			continue
		}
		if ord.Status == "filled" || ord.Status == "partially_filled" {
			pm.logger.WithFields(logrus.Fields{
				"order_id": orderID,
				"status":   ord.Status,
			}).Info("bracket leg filled during cancel; bracket closed the position")
			bracketFilled = true
		}
	}

	if bracketFilled {
		// The bracket monitor's next tick will reconcile the position to CLOSED
		// when it sees the fill — we don't need to do anything else here.
		return nil
	}

	pm.mu.RLock()
	live, ok := pm.positions[pos.ID]
	pm.mu.RUnlock()
	if !ok || live == nil || live.Status == "CLOSED" || live.RemainingQty == 0 {
		return nil
	}

	exitSide := "sell"
	if live.Side == "sell" {
		exitSide = "buy"
	}
	// Attribution: prefer the owning agent's strategy tag; fall back to
	// "penny-momentum" if the position pre-dates the AgentStrategy column
	// so /api/v1/positions?strategy=X and segment-PnL still see this order.
	strategyTag := pos.AgentStrategy
	if strategyTag == "" {
		strategyTag = "penny-momentum"
	}
	_, err := pm.tradingService.PlaceOrder(ctx, &interfaces.Order{
		Symbol:      pos.Symbol,
		Qty:         live.RemainingQty,
		Side:        exitSide,
		Type:        "market",
		TimeInForce: "day",
		Strategy:    strategyTag,
	})
	if err != nil {
		return fmt.Errorf("place social-exit market order: %w", err)
	}

	pm.mu.Lock()
	live.Status = "CLOSED"
	closedAt := time.Now()
	live.ClosedAt = &closedAt
	pm.mu.Unlock()
	return nil
}

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
		DominantSignal:    dbPos.DominantSignal,
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
