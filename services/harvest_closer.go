package services

import (
	"context"
	"errors"
	"fmt"
	"time"

	"prophet-trader/models"
)

// closerStore is the storage subset used by HarvestCloser. Decoupled from
// the larger harvestStateStore so tests don't need to fake every method.
type closerStore interface {
	GetHarvestCondorByID(condorID string) (*models.DBHarvestCondor, error)
	UpdateHarvestCondor(condorID string, updates map[string]interface{}) error
}

// CloseCondorRequest mirrors the controller's request shape so the
// controller can pass it through unchanged after binding.
//
// FinalizeImmediately and AllowReplaceClosing are monitor-internal fields
// (json:"-" so external HTTP callers cannot set them):
//
//   - The HTTP controller hardcodes FinalizeImmediately=true and
//     AllowReplaceClosing=false after JSON binding. This preserves the
//     pre-monitor behavior: status flips straight to CLOSED with closed_at
//     set on order placement, and CLOSING rows are rejected (HTTP 409).
//   - The HarvestExitMonitor (Task 3+) sets FinalizeImmediately=false so
//     the CLOSING -> CLOSED transition is owned by its fill-confirmation
//     poll, and sets AllowReplaceClosing=true on tier-escalation re-places
//     so the closer accepts a row whose status is already CLOSING.
type CloseCondorRequest struct {
	CondorID            string  `json:"-"`
	OrderType           string  `json:"order_type" binding:"required"`
	LimitPrice          float64 `json:"limit_price"`
	CloseReason         string  `json:"close_reason"`
	CostPerContract     float64 `json:"cost_per_contract"`
	FinalizeImmediately bool    `json:"-"` // controller=true, monitor=false
	AllowReplaceClosing bool    `json:"-"` // controller=false, monitor escalation=true
}

// CloseCondorResult is the data the controller needs to render its response
// and the monitor needs to update its in-memory tier state.
type CloseCondorResult struct {
	CondorID     string
	CloseOrderID string
	RealizedPnL  float64
	Status       string
}

// ErrCondorNotOpen is returned when CloseCondor is called against a condor
// whose DB status is not OPEN (and AllowReplaceClosing is not set to
// permit a CLOSING re-place). Used by callers (controller / monitor) to
// distinguish "already-closing" from real failures.
var ErrCondorNotOpen = errors.New("condor not OPEN")

// HarvestCloser places close orders for iron condors and updates the DB
// row. The exact status it writes depends on the request's
// FinalizeImmediately flag (see CloseCondorRequest). This dual-mode design
// lets the HTTP /close endpoint preserve its zero-regression behavior
// while the HarvestExitMonitor can keep rows in CLOSING across an
// escalation sequence and flip them to CLOSED only on actual fill.
type HarvestCloser struct {
	store   closerStore
	placeFn PlaceMultiLegOrderFn
	timeout time.Duration
	nowFn   func() time.Time
}

func NewHarvestCloser(store closerStore, placeFn PlaceMultiLegOrderFn) *HarvestCloser {
	return &HarvestCloser{store: store, placeFn: placeFn, timeout: 15 * time.Second, nowFn: time.Now}
}

func (hc *HarvestCloser) CloseCondor(ctx context.Context, req CloseCondorRequest) (*CloseCondorResult, error) {
	condor, err := hc.store.GetHarvestCondorByID(req.CondorID)
	if err != nil {
		return nil, fmt.Errorf("fetch condor: %w", err)
	}
	if !(condor.Status == "OPEN" || (req.AllowReplaceClosing && condor.Status == "CLOSING")) {
		return nil, fmt.Errorf("%w: status=%s", ErrCondorNotOpen, condor.Status)
	}

	limitPrice := req.LimitPrice
	if req.OrderType == "market" {
		limitPrice = 0
	}

	order := MultiLegOrder{
		Underlying:  condor.Underlying,
		Contracts:   condor.Contracts,
		LimitPrice:  limitPrice,
		TimeInForce: "day",
		Strategy:    "harvest",
		Legs: []MultiLegOrderLeg{
			{Symbol: condor.ShortPutSymbol, Side: "buy", PositionIntent: "buy_to_close"},
			{Symbol: condor.LongPutSymbol, Side: "sell", PositionIntent: "sell_to_close"},
			{Symbol: condor.ShortCallSymbol, Side: "buy", PositionIntent: "buy_to_close"},
			{Symbol: condor.LongCallSymbol, Side: "sell", PositionIntent: "sell_to_close"},
		},
	}

	cctx, cancel := context.WithTimeout(ctx, hc.timeout)
	defer cancel()
	closeOrderID, err := hc.placeFn(cctx, order)
	if err != nil {
		return nil, fmt.Errorf("place close order: %w", err)
	}

	// Realized P&L is computed from the operator-supplied cost-to-close.
	// For the monitor, this is the live mid; for the manual endpoint, it's
	// whatever the caller passed. The number is corrected later if the
	// fill price differs materially (out of scope for this task).
	realizedPnL := (condor.CreditPerContract - req.CostPerContract) * float64(condor.Contracts) * 100.0

	updates := map[string]interface{}{
		"close_order_id":          closeOrderID,
		"close_reason":            req.CloseReason,
		"close_cost_per_contract": req.CostPerContract,
		"realized_pnl":            realizedPnL,
	}
	resultStatus := "CLOSING"
	if req.FinalizeImmediately {
		now := hc.nowFn()
		updates["status"] = "CLOSED"
		updates["closed_at"] = &now
		resultStatus = "CLOSED"
	} else {
		updates["status"] = "CLOSING"
	}
	if err := hc.store.UpdateHarvestCondor(req.CondorID, updates); err != nil {
		return nil, fmt.Errorf("close order placed (%s) but DB update failed: %w", closeOrderID, err)
	}

	return &CloseCondorResult{
		CondorID:     req.CondorID,
		CloseOrderID: closeOrderID,
		RealizedPnL:  realizedPnL,
		Status:       resultStatus,
	}, nil
}
