package services

import (
	"context"
	"fmt"
	"io"
	"math"
	"time"

	"prophet-trader/interfaces"
	"prophet-trader/models"

	"github.com/sirupsen/logrus"
)

// Consumer-defined dependency interfaces (mirror the hedge executor's split).
type verticalChainFetcher interface {
	GetOptionSnapshot(ctx context.Context, optionSymbol string) (*interfaces.OptionContract, error)
}
type verticalBarFetcher interface {
	GetLatestBar(ctx context.Context, symbol string) (*interfaces.Bar, error)
}
type verticalMlegTrader interface {
	PlaceMultiLegOrder(ctx context.Context, order MultiLegOrder) (string, error)
	GetOrder(ctx context.Context, orderID string) (*interfaces.Order, error)
}
type verticalGuard interface {
	CheckOptionsOpen(agent AgentSource, underlying, symbol string, quote *interfaces.OptionsQuote, now time.Time) error
}

// PlaceVerticalRequest is the fully-specified vertical Phase 3's tools submit.
// Strikes/symbols come from the (Phase 3) proposal record; Place re-prices the
// exact legs at execution time and enforces the guards — never re-derives.
type PlaceVerticalRequest struct {
	Underlying  string
	Expiration  time.Time
	Direction   VerticalDirection
	LongSymbol  string
	LongStrike  float64
	ShortSymbol string
	ShortStrike float64
}

// VerticalTickResult is the per-tick outcome cached by the scheduler.
type VerticalTickResult struct {
	Date      string   `json:"date"`
	OpenCount int      `json:"open_count"`
	Closed    []string `json:"closed,omitempty"`
	Skips     []string `json:"skips,omitempty"`
	Errors    []string `json:"errors,omitempty"`
}

type ProphetVerticalExecutor struct {
	ledger *ProphetVerticalLedger
	chain  verticalChainFetcher
	bars   verticalBarFetcher
	trader verticalMlegTrader
	guard  verticalGuard
	logger *logrus.Logger
}

func NewProphetVerticalExecutor(ledger *ProphetVerticalLedger, chain verticalChainFetcher, bars verticalBarFetcher, trader verticalMlegTrader, guard verticalGuard, logger *logrus.Logger) *ProphetVerticalExecutor {
	if logger == nil {
		logger = logrus.New()
		logger.SetOutput(io.Discard)
	}
	return &ProphetVerticalExecutor{ledger: ledger, chain: chain, bars: bars, trader: trader, guard: guard, logger: logger}
}

// legQuote adapts an option snapshot to the guard's OptionsQuote input.
func legQuote(c *interfaces.OptionContract, now time.Time) *interfaces.OptionsQuote {
	return &interfaces.OptionsQuote{Symbol: c.Symbol, BidPrice: c.Bid, AskPrice: c.Ask, Timestamp: now}
}

// Place submits the opening debit combo for an LLM-confirmed vertical.
// Fail-closed: any missing quote, guard rejection, or cap breach returns an
// error with NO order placed and NO row persisted.
func (e *ProphetVerticalExecutor) Place(ctx context.Context, req PlaceVerticalRequest, now time.Time) (string, error) {
	long, err := e.chain.GetOptionSnapshot(ctx, req.LongSymbol)
	if err != nil || long == nil {
		return "", fmt.Errorf("place vertical: long leg snapshot unavailable: %w", err)
	}
	short, err := e.chain.GetOptionSnapshot(ctx, req.ShortSymbol)
	if err != nil || short == nil {
		return "", fmt.Errorf("place vertical: short leg snapshot unavailable: %w", err)
	}

	longMid := (long.Bid + long.Ask) / 2
	shortMid := (short.Bid + short.Ask) / 2
	width := math.Abs(req.LongStrike - req.ShortStrike)
	// Positive = net DEBIT we pay (Alpaca mleg convention), capped at intrinsic width.
	debit := verticalDebitLimit(longMid, shortMid, long.Ask-long.Bid, short.Ask-short.Bid, width, verticalLimitBufferFrac)
	if debit <= 0 {
		return "", fmt.Errorf("place vertical: non-positive net debit %.2f — not a debit spread at current quotes", debit)
	}
	if debit*100*float64(verticalContracts) > verticalDebitCapUSD {
		return "", fmt.Errorf("place vertical: debit cap — $%.0f exceeds $%.0f per-vertical max loss cap", debit*100, verticalDebitCapUSD)
	}

	if e.guard != nil {
		for _, leg := range []*interfaces.OptionContract{long, short} {
			if err := e.guard.CheckOptionsOpen(AgentMain, req.Underlying, leg.Symbol, legQuote(leg, now), now); err != nil {
				return "", fmt.Errorf("place vertical: guard blocked %s: %w", leg.Symbol, err)
			}
		}
	}

	orderID, err := e.trader.PlaceMultiLegOrder(ctx, MultiLegOrder{
		Underlying: req.Underlying, Contracts: verticalContracts, TimeInForce: "day",
		Strategy: verticalStrategyTag, LimitPrice: debit,
		Legs: []MultiLegOrderLeg{
			{Symbol: req.LongSymbol, Side: "buy", PositionIntent: "buy_to_open"},
			{Symbol: req.ShortSymbol, Side: "sell", PositionIntent: "sell_to_open"},
		},
	})
	if err != nil {
		return "", fmt.Errorf("place vertical: %w", err)
	}

	_, maxGain, breakeven := verticalEconomics(req.Direction, req.LongStrike, req.ShortStrike, debit)
	sp := &models.DBProphetVerticalSpread{
		VerticalID: fmt.Sprintf("vert-%d", now.UnixNano()),
		Underlying: req.Underlying, Direction: string(req.Direction), Expiration: req.Expiration,
		LongSymbol: req.LongSymbol, LongStrike: req.LongStrike,
		ShortSymbol: req.ShortSymbol, ShortStrike: req.ShortStrike,
		Contracts: verticalContracts, NetDebitPerContract: debit,
		TotalDebit: debit * 100 * float64(verticalContracts),
		MaxGain:    maxGain * float64(verticalContracts), Breakeven: breakeven,
		EntryOrderID: orderID, Status: "pending_fill",
	}
	if err := e.ledger.Save(sp); err != nil {
		return "", fmt.Errorf("place vertical: order %s submitted but row save failed: %w", orderID, err)
	}
	return sp.VerticalID, nil
}

// RunManageTick is the scheduler-driven heartbeat: reconcile in-flight orders
// first, then manage open verticals (Task 6 adds manageOpen). res accumulates
// the per-tick outcome for LastResult/status.
func (e *ProphetVerticalExecutor) RunManageTick(ctx context.Context, now time.Time, res *VerticalTickResult) {
	res.Date = now.In(nyLoc).Format("2006-01-02")
	open, err := e.ledger.ListOpen()
	if err != nil {
		res.Errors = append(res.Errors, fmt.Sprintf("list open: %v", err))
		return
	}
	for _, sp := range open {
		switch sp.Status {
		case "pending_fill":
			e.reconcilePending(ctx, sp, now, res)
		case "closing":
			e.reconcileClosing(ctx, sp, now, res)
		}
	}
	e.manageOpen(ctx, open, now, res)
	if fresh, err := e.ledger.ListOpen(); err == nil {
		res.OpenCount = len(fresh)
	}
}

// reconcilePending transitions a pending_fill vertical by broker order state.
// mleg combos are ATOMIC: "filled" means N complete spreads — never a half-
// spread — so the ledger can never hold a single-leg position.
func (e *ProphetVerticalExecutor) reconcilePending(ctx context.Context, sp *models.DBProphetVerticalSpread, now time.Time, res *VerticalTickResult) {
	if sp.EntryOrderID == "" {
		res.Errors = append(res.Errors, fmt.Sprintf("reconcile %s: empty EntryOrderID", sp.VerticalID))
		return
	}
	ord, err := e.trader.GetOrder(ctx, sp.EntryOrderID)
	if err != nil {
		res.Errors = append(res.Errors, fmt.Sprintf("reconcile %s: GetOrder: %v", sp.VerticalID, err))
		return
	}
	switch ord.Status {
	case "filled", "partially_filled":
		if ord.FilledAvgPrice == nil || ord.FilledQty < 1 {
			res.Errors = append(res.Errors, fmt.Sprintf("reconcile %s: %s with nil/0 fill — leaving pending", sp.VerticalID, ord.Status))
			return
		}
		fillDebit := *ord.FilledAvgPrice
		sp.Status = "open"
		sp.Contracts = int(ord.FilledQty)
		sp.NetDebitPerContract = fillDebit
		sp.TotalDebit = fillDebit * 100 * float64(sp.Contracts)
		_, maxGain, breakeven := verticalEconomics(VerticalDirection(sp.Direction), sp.LongStrike, sp.ShortStrike, fillDebit)
		sp.MaxGain = maxGain * float64(sp.Contracts)
		sp.Breakeven = breakeven
		sp.OpenedAt = now
		e.captureEntrySnapshot(ctx, sp, now)
		if err := e.ledger.Save(sp); err != nil {
			res.Errors = append(res.Errors, fmt.Sprintf("reconcile %s: save open: %v", sp.VerticalID, err))
		}
	case "canceled", "expired", "rejected":
		sp.Status = "failed"
		sp.CloseReason = "reconciled"
		t := now
		sp.ClosedAt = &t
		if err := e.ledger.Save(sp); err != nil {
			res.Errors = append(res.Errors, fmt.Sprintf("reconcile %s: save failed: %v", sp.VerticalID, err))
		}
	default:
		// new/accepted/pending_new — still working; leave pending_fill.
	}
}

// captureEntrySnapshot best-effort fills the attribution baseline at fill
// detection. Missing data leaves zero fields (degraded attribution, never a
// blocked transition).
func (e *ProphetVerticalExecutor) captureEntrySnapshot(ctx context.Context, sp *models.DBProphetVerticalSpread, now time.Time) {
	if bar, err := e.bars.GetLatestBar(ctx, sp.Underlying); err == nil && bar != nil {
		sp.EntrySpot = bar.Close
	}
	if long, err := e.chain.GetOptionSnapshot(ctx, sp.LongSymbol); err == nil && long != nil {
		sp.EntryLongVol = long.ImpliedVolatility
	}
	if short, err := e.chain.GetOptionSnapshot(ctx, sp.ShortSymbol); err == nil && short != nil {
		sp.EntryShortVol = short.ImpliedVolatility
	}
	sp.EntryTimeToExpiry = sp.Expiration.Sub(now).Hours() / 24 / 365
}

// closeVertical places the reverse atomic combo AT MARKET (LimitPrice 0 —
// mirrors hedge closeSpread; per Alpaca's sign convention a positive limit on
// a credit-receiving close would mean "willing to pay") and flips the row to
// "closing". Fail-closed: ONLY reconcileClosing marks the row closed, after
// the broker confirms the fill.
func (e *ProphetVerticalExecutor) closeVertical(ctx context.Context, sp *models.DBProphetVerticalSpread, reason string, res *VerticalTickResult) {
	id, err := e.trader.PlaceMultiLegOrder(ctx, MultiLegOrder{
		Underlying: sp.Underlying, Contracts: sp.Contracts, TimeInForce: "day",
		Strategy: verticalStrategyTag,
		Legs: []MultiLegOrderLeg{
			{Symbol: sp.LongSymbol, Side: "sell", PositionIntent: "sell_to_close"},
			{Symbol: sp.ShortSymbol, Side: "buy", PositionIntent: "buy_to_close"},
		},
	})
	if err != nil {
		res.Errors = append(res.Errors, fmt.Sprintf("close %s (%s): %v", sp.VerticalID, reason, err))
		return
	}
	sp.Status = "closing"
	sp.CloseReason = reason
	sp.CloseOrderID = id
	if err := e.ledger.Save(sp); err != nil {
		res.Errors = append(res.Errors, fmt.Sprintf("close %s: save: %v", sp.VerticalID, err))
		return
	}
	res.Closed = append(res.Closed, sp.VerticalID)
}

// reconcileClosing finalizes a vertical whose close combo filled: realized P&L
// = close proceeds − TotalDebit, plus the direction/theta/IV attribution from
// the stored entry snapshot vs the exit snapshot captured now. A canceled/
// rejected close REVERTS to "open" so manageOpen retries next tick — never
// strand a position in limbo (the fail-closed carry-forward).
func (e *ProphetVerticalExecutor) reconcileClosing(ctx context.Context, sp *models.DBProphetVerticalSpread, now time.Time, res *VerticalTickResult) {
	if sp.CloseOrderID == "" {
		res.Errors = append(res.Errors, fmt.Sprintf("reconcile-close %s: empty CloseOrderID", sp.VerticalID))
		return
	}
	ord, err := e.trader.GetOrder(ctx, sp.CloseOrderID)
	if err != nil {
		res.Errors = append(res.Errors, fmt.Sprintf("reconcile-close %s: GetOrder: %v", sp.VerticalID, err))
		return
	}
	switch ord.Status {
	case "filled", "partially_filled":
		if ord.FilledAvgPrice == nil {
			res.Errors = append(res.Errors, fmt.Sprintf("reconcile-close %s: %s with nil fill — leaving closing", sp.VerticalID, ord.Status))
			return
		}
		proceeds := *ord.FilledAvgPrice * 100 * float64(sp.Contracts)
		sp.RealizedPnL = proceeds - sp.TotalDebit
		sp.Status = "closed"
		t := now
		sp.ClosedAt = &t
		e.attributeClose(ctx, sp, now)
		if err := e.ledger.Save(sp); err != nil {
			res.Errors = append(res.Errors, fmt.Sprintf("reconcile-close %s: save closed: %v", sp.VerticalID, err))
		}
	case "canceled", "expired", "rejected":
		sp.Status = "open"
		sp.CloseOrderID = ""
		if err := e.ledger.Save(sp); err != nil {
			res.Errors = append(res.Errors, fmt.Sprintf("reconcile-close %s: save revert: %v", sp.VerticalID, err))
		}
	default:
		// still working — leave closing
	}
}

// attributeClose computes the teaching decomposition at close-fill detection.
// Best-effort: degraded inputs produce degraded components; Residual always
// reconciles the model to the realized fill P&L.
func (e *ProphetVerticalExecutor) attributeClose(ctx context.Context, sp *models.DBProphetVerticalSpread, now time.Time) {
	exit := VerticalSnapshot{TimeToExpiry: sp.Expiration.Sub(now).Hours() / 24 / 365}
	if bar, err := e.bars.GetLatestBar(ctx, sp.Underlying); err == nil && bar != nil {
		exit.Spot = bar.Close
	}
	if long, err := e.chain.GetOptionSnapshot(ctx, sp.LongSymbol); err == nil && long != nil {
		exit.LongVol = long.ImpliedVolatility
	}
	if short, err := e.chain.GetOptionSnapshot(ctx, sp.ShortSymbol); err == nil && short != nil {
		exit.ShortVol = short.ImpliedVolatility
	}
	entry := VerticalSnapshot{
		Spot: sp.EntrySpot, LongVol: sp.EntryLongVol, ShortVol: sp.EntryShortVol,
		TimeToExpiry: sp.EntryTimeToExpiry,
	}
	a := attributeVerticalPnl(VerticalDirection(sp.Direction), sp.LongStrike, sp.ShortStrike, entry, exit, sp.RealizedPnL, sp.Contracts)
	sp.AttribDirection, sp.AttribTheta, sp.AttribIV, sp.AttribResidual = a.Direction, a.Theta, a.IV, a.Residual
}

// manageOpen is a placeholder for Task 6.
func (e *ProphetVerticalExecutor) manageOpen(ctx context.Context, open []*models.DBProphetVerticalSpread, now time.Time, res *VerticalTickResult) {
}

