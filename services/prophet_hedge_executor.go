package services

import (
	"context"
	"fmt"
	"io"
	"time"

	"prophet-trader/interfaces"
	"prophet-trader/models"

	"github.com/sirupsen/logrus"
)

// usMarketHolidays2026 — NYSE full-day closures (verify quarterly; source: nyse.com).
var usMarketHolidays2026 = map[string]bool{
	"2026-01-01": true, "2026-01-19": true, "2026-02-16": true, "2026-04-03": true,
	"2026-05-25": true, "2026-06-19": true, "2026-07-03": true, "2026-09-07": true,
	"2026-11-26": true, "2026-12-25": true,
}

type hedgeRegimeFetcher interface{ GetStatus() RegimeGateStatus }
type hedgeChainFetcher interface {
	GetOptionChain(ctx context.Context, underlying string, exp time.Time) (map[string]*interfaces.OptionContract, error)
	GetOptionSnapshot(ctx context.Context, optionSymbol string) (*interfaces.OptionContract, error)
}
type hedgeMlegTrader interface {
	PlaceMultiLegOrder(ctx context.Context, order MultiLegOrder) (string, error)
	GetOrder(ctx context.Context, orderID string) (*interfaces.Order, error)
}
type hedgeAccountFetcher interface {
	GetAccount(ctx context.Context) (*interfaces.Account, error)
	GetLatestBar(ctx context.Context, symbol string) (*interfaces.Bar, error)
}
type hedgeGuard interface {
	CheckOptionsOpen(agent AgentSource, underlying, symbol string, quote *interfaces.OptionsQuote, now time.Time) error
}

// HedgeResult is the per-beat outcome (cached by the scheduler / status endpoint).
type HedgeResult struct {
	Date      string   `json:"date"`
	Armed     bool     `json:"armed"`
	ArmReason string   `json:"arm_reason,omitempty"`
	OpenCount int      `json:"open_count"`
	Opened    []string `json:"opened,omitempty"`
	Closed    []string `json:"closed,omitempty"`
	Skips     []string `json:"skips,omitempty"`
	Errors    []string `json:"errors,omitempty"`
	Skipped   string   `json:"skipped,omitempty"`
}

type ProphetHedgeExecutor struct {
	ledger *ProphetHedgeLedger
	regime hedgeRegimeFetcher
	chain  hedgeChainFetcher
	trader hedgeMlegTrader
	acct   hedgeAccountFetcher
	guard  hedgeGuard
	logger *logrus.Logger
}

func NewProphetHedgeExecutor(ledger *ProphetHedgeLedger, regime hedgeRegimeFetcher, chain hedgeChainFetcher, trader hedgeMlegTrader, acct hedgeAccountFetcher, guard hedgeGuard, logger *logrus.Logger) *ProphetHedgeExecutor {
	if logger == nil {
		logger = logrus.New()
		logger.SetOutput(io.Discard)
	}
	return &ProphetHedgeExecutor{ledger, regime, chain, trader, acct, guard, logger}
}

func (e *ProphetHedgeExecutor) preloopCheck(now time.Time, session *models.DBProphetHedgeSession) string {
	local := now.In(nyLoc)
	if usMarketHolidays2026[local.Format("2006-01-02")] {
		return fmt.Sprintf("market holiday %s — skipping", local.Format("2006-01-02"))
	}
	mins := local.Hour()*60 + local.Minute()
	if mins < hedgeWindowStartMin || mins > hedgeWindowEndMin {
		return fmt.Sprintf("out-of-window: %02d:%02d ET (runs 17:00-17:10)", local.Hour(), local.Minute())
	}
	if session != nil && session.LastHeartbeatDate == local.Format("2006-01-02") {
		return fmt.Sprintf("duplicate heartbeat for %s — skipping", session.LastHeartbeatDate)
	}
	return ""
}

func (e *ProphetHedgeExecutor) RunHeartbeat(ctx context.Context, now time.Time) (*HedgeResult, error) {
	res := &HedgeResult{Date: now.In(nyLoc).Format("2006-01-02")}
	session, err := e.ledger.Session()
	if err != nil {
		res.Errors = append(res.Errors, fmt.Sprintf("load session: %v", err))
		return res, nil
	}
	if reason := e.preloopCheck(now, session); reason != "" {
		res.Skipped = reason
		return res, nil
	}
	if session == nil {
		session = &models.DBProphetHedgeSession{SessionID: "singleton"}
	}

	armed, armReason := deriveArm(e.regime.GetStatus())
	res.Armed, res.ArmReason = armed, armReason

	open, err := e.ledger.ListOpen()
	if err != nil {
		res.Errors = append(res.Errors, fmt.Sprintf("list open: %v", err))
		return res, nil
	}
	e.reconcile(ctx, open, now, res)
	e.manageOpen(ctx, open, now, armed, res)
	if armed && len(res.Errors) == 0 {
		e.openNew(ctx, open, now, res)
	}

	session.LastHeartbeatDate = res.Date
	if err := e.ledger.SaveSession(session); err != nil {
		res.Errors = append(res.Errors, fmt.Sprintf("save session: %v", err))
	}
	if fresh, err := e.ledger.ListOpen(); err == nil {
		res.OpenCount = len(fresh)
	}
	return res, nil
}

// reconcile transitions live spreads by broker order state. mleg combos are
// ATOMIC — "filled"/"partially_filled" means N COMPLETE spreads filled
// (FilledQty = complete combos), never a half-spread (D-DP15). The ledger can
// never hold a single-leg position: a non-filled entry becomes "failed".
func (e *ProphetHedgeExecutor) reconcile(ctx context.Context, open []*models.DBProphetHedgeSpread, now time.Time, res *HedgeResult) {
	for _, sp := range open {
		switch sp.Status {
		case "pending_fill":
			e.reconcilePending(ctx, sp, now, res)
		case "closing":
			e.reconcileClosing(ctx, sp, now, res)
		}
	}
}

func (e *ProphetHedgeExecutor) reconcilePending(ctx context.Context, sp *models.DBProphetHedgeSpread, now time.Time, res *HedgeResult) {
	if sp.EntryOrderID == "" {
		res.Errors = append(res.Errors, fmt.Sprintf("reconcile %s: empty EntryOrderID", sp.SpreadID))
		return
	}
	ord, err := e.trader.GetOrder(ctx, sp.EntryOrderID)
	if err != nil {
		res.Errors = append(res.Errors, fmt.Sprintf("reconcile %s: GetOrder: %v", sp.SpreadID, err))
		return
	}
	switch ord.Status {
	case "filled", "partially_filled":
		if ord.FilledAvgPrice == nil || ord.FilledQty < 1 {
			res.Errors = append(res.Errors, fmt.Sprintf("reconcile %s: %s with nil/0 fill — leaving pending", sp.SpreadID, ord.Status))
			return
		}
		sp.Status = "open"
		sp.Contracts = int(ord.FilledQty)
		sp.NetDebitPerContract = *ord.FilledAvgPrice
		sp.TotalDebit = *ord.FilledAvgPrice * 100 * float64(sp.Contracts)
		sp.MaxPayoff = ((sp.LongPutStrike - sp.ShortPutStrike) - *ord.FilledAvgPrice) * 100 * float64(sp.Contracts)
		sp.OpenedAt = now
		if err := e.ledger.Save(sp); err != nil {
			res.Errors = append(res.Errors, fmt.Sprintf("reconcile %s: save open: %v", sp.SpreadID, err))
		}
	case "canceled", "expired", "rejected":
		sp.Status = "failed"
		sp.CloseReason = "reconciled"
		t := now
		sp.ClosedAt = &t
		if err := e.ledger.Save(sp); err != nil {
			res.Errors = append(res.Errors, fmt.Sprintf("reconcile %s: save failed: %v", sp.SpreadID, err))
		}
	default:
		// new/accepted/pending_new — still working; leave pending_fill.
	}
}
func (e *ProphetHedgeExecutor) spreadValue(ctx context.Context, sp *models.DBProphetHedgeSpread) (float64, bool) {
	long, err := e.chain.GetOptionSnapshot(ctx, sp.LongPutSymbol)
	if err != nil || long == nil {
		return 0, false
	}
	short, err := e.chain.GetOptionSnapshot(ctx, sp.ShortPutSymbol)
	if err != nil || short == nil {
		return 0, false
	}
	longMid := (long.Bid + long.Ask) / 2
	shortMid := (short.Bid + short.Ask) / 2
	return (longMid - shortMid) * 100 * float64(sp.Contracts), true
}

func (e *ProphetHedgeExecutor) manageOpen(ctx context.Context, open []*models.DBProphetHedgeSpread, now time.Time, armed bool, res *HedgeResult) {
	for _, sp := range open {
		if sp.Status != "open" {
			continue // pending_fill/closing handled by reconcile
		}
		var spot float64
		if bar, err := e.acct.GetLatestBar(ctx, sp.Underlying); err == nil && bar != nil {
			spot = bar.Close
		}
		value, valued := e.spreadValue(ctx, sp)
		switch {
		case valued && shouldHarvest(sp, value):
			e.closeSpread(ctx, sp, "harvest", now, res)
		case spot > 0 && shouldCloseITMShort(sp, now, spot):
			e.closeSpread(ctx, sp, "itm_short", now, res)
		case shouldRoll(sp, now, armed):
			e.closeSpread(ctx, sp, "roll", now, res)
		case shouldExpire(sp, now, armed):
			e.closeSpread(ctx, sp, "expire", now, res)
		}
	}
}

// closeSpread places the reverse combo at market (LimitPrice 0) and flips the
// row to "closing"; reconcileClosing finalizes it to "closed" next beat.
func (e *ProphetHedgeExecutor) closeSpread(ctx context.Context, sp *models.DBProphetHedgeSpread, reason string, now time.Time, res *HedgeResult) {
	order := MultiLegOrder{
		Underlying:  sp.Underlying,
		Contracts:   sp.Contracts,
		TimeInForce: "day",
		Strategy:    hedgeStrategyTag,
		Legs: []MultiLegOrderLeg{
			{Symbol: sp.LongPutSymbol, Side: "sell", PositionIntent: "sell_to_close"},
			{Symbol: sp.ShortPutSymbol, Side: "buy", PositionIntent: "buy_to_close"},
		},
	}
	id, err := e.trader.PlaceMultiLegOrder(ctx, order)
	if err != nil {
		res.Errors = append(res.Errors, fmt.Sprintf("close %s (%s): %v", sp.SpreadID, reason, err))
		return
	}
	sp.Status = "closing"
	sp.CloseReason = reason
	sp.CloseOrderID = id
	if err := e.ledger.Save(sp); err != nil {
		res.Errors = append(res.Errors, fmt.Sprintf("close %s: save: %v", sp.SpreadID, err))
		return
	}
	res.Closed = append(res.Closed, sp.SpreadID)
}

// reconcileClosing finalizes a spread whose close order filled → realized P&L
// = close proceeds − TotalDebit. A canceled/rejected close reverts to "open" so
// manageOpen retries next beat (never strand a position in limbo).
func (e *ProphetHedgeExecutor) reconcileClosing(ctx context.Context, sp *models.DBProphetHedgeSpread, now time.Time, res *HedgeResult) {
	if sp.CloseOrderID == "" {
		res.Errors = append(res.Errors, fmt.Sprintf("reconcile-close %s: empty CloseOrderID", sp.SpreadID))
		return
	}
	ord, err := e.trader.GetOrder(ctx, sp.CloseOrderID)
	if err != nil {
		res.Errors = append(res.Errors, fmt.Sprintf("reconcile-close %s: GetOrder: %v", sp.SpreadID, err))
		return
	}
	switch ord.Status {
	case "filled", "partially_filled":
		if ord.FilledAvgPrice == nil {
			res.Errors = append(res.Errors, fmt.Sprintf("reconcile-close %s: %s with nil fill — leaving closing", sp.SpreadID, ord.Status))
			return
		}
		proceeds := *ord.FilledAvgPrice * 100 * float64(sp.Contracts)
		sp.RealizedPnL = proceeds - sp.TotalDebit
		sp.Status = "closed"
		t := now
		sp.ClosedAt = &t
		if err := e.ledger.Save(sp); err != nil {
			res.Errors = append(res.Errors, fmt.Sprintf("reconcile-close %s: save closed: %v", sp.SpreadID, err))
		}
	case "canceled", "expired", "rejected":
		sp.Status = "open"
		sp.CloseOrderID = ""
		if err := e.ledger.Save(sp); err != nil {
			res.Errors = append(res.Errors, fmt.Sprintf("reconcile-close %s: save revert: %v", sp.SpreadID, err))
		}
	default:
		// still working — leave closing
	}
}

// liveOpenCount counts spreads occupying a concurrency slot: pending_fill + open.
// A spread in "closing" (incl. a roll's close placed this beat) is EXEMPT so its
// replacement can open without breaching the cap (D-DP17).
func liveOpenCount(open []*models.DBProphetHedgeSpread) int {
	n := 0
	for _, sp := range open {
		if sp.Status == "pending_fill" || sp.Status == "open" {
			n++
		}
	}
	return n
}

func (e *ProphetHedgeExecutor) openNew(ctx context.Context, open []*models.DBProphetHedgeSpread, now time.Time, res *HedgeResult) {
	if liveOpenCount(open) >= hedgeMaxConcurrent {
		res.Skips = append(res.Skips, fmt.Sprintf("concurrency cap (%d)", hedgeMaxConcurrent))
		return
	}
	acct, err := e.acct.GetAccount(ctx)
	if err != nil {
		res.Errors = append(res.Errors, fmt.Sprintf("openNew: account: %v", err))
		return
	}
	bar, err := e.acct.GetLatestBar(ctx, "QQQ")
	if err != nil || bar == nil || bar.Close <= 0 {
		res.Errors = append(res.Errors, "openNew: QQQ spot unavailable")
		return
	}
	spot := bar.Close
	status := e.regime.GetStatus()
	profile := selectStructure(status, 0.0)

	exp, ok := e.pickExpiry(ctx, profile, now)
	if !ok {
		res.Skips = append(res.Skips, "no monthly expiry in DTE band")
		return
	}
	chain, err := e.chain.GetOptionChain(ctx, "QQQ", exp)
	if err != nil {
		res.Errors = append(res.Errors, fmt.Sprintf("openNew: chain: %v", err))
		return
	}
	long, short, ok := pickPutStrikes(chain, spot, profile)
	if !ok {
		res.Skips = append(res.Skips, "no valid strike pair (degenerate chain)")
		return
	}
	longSnap, err1 := e.chain.GetOptionSnapshot(ctx, long.Symbol)
	shortSnap, err2 := e.chain.GetOptionSnapshot(ctx, short.Symbol)
	if err1 != nil || err2 != nil || longSnap == nil || shortSnap == nil {
		res.Errors = append(res.Errors, "openNew: leg snapshot unavailable")
		return
	}
	longMid := (longSnap.Bid + longSnap.Ask) / 2
	shortMid := (shortSnap.Bid + shortSnap.Ask) / 2
	debitPerShare := longMid - shortMid

	contracts := sizeSpread(acct.PortfolioValue, debitPerShare)
	if contracts < 1 {
		res.Skips = append(res.Skips, fmt.Sprintf("armed but unaffordable: 1 contract debit $%.0f > %.1f%% cap", debitPerShare*100, hedgeDebitCapPct*100))
		return
	}

	if e.guard != nil {
		q := &interfaces.OptionsQuote{Symbol: long.Symbol, BidPrice: longSnap.Bid, AskPrice: longSnap.Ask, Timestamp: now}
		if err := e.guard.CheckOptionsOpen(AgentProphetDefensive, "QQQ", long.Symbol, q, now); err != nil {
			res.Skips = append(res.Skips, fmt.Sprintf("guard: %v", err))
			return
		}
	}

	ceiling := long.StrikePrice - short.StrikePrice
	limit := marketableLimitCapped(longMid, shortMid, longSnap.Ask-longSnap.Bid, shortSnap.Ask-shortSnap.Bid, 0.25, ceiling)

	id, err := e.trader.PlaceMultiLegOrder(ctx, MultiLegOrder{
		Underlying: "QQQ", Contracts: contracts, TimeInForce: "day", Strategy: hedgeStrategyTag, LimitPrice: limit,
		Legs: []MultiLegOrderLeg{
			{Symbol: long.Symbol, Side: "buy", PositionIntent: "buy_to_open"},
			{Symbol: short.Symbol, Side: "sell", PositionIntent: "sell_to_open"},
		},
	})
	if err != nil {
		res.Errors = append(res.Errors, fmt.Sprintf("openNew: place: %v", err))
		return
	}
	sp := &models.DBProphetHedgeSpread{
		SpreadID: fmt.Sprintf("hedge-%d", now.UnixNano()), Underlying: "QQQ", Expiration: exp,
		LongPutSymbol: long.Symbol, LongPutStrike: long.StrikePrice,
		ShortPutSymbol: short.Symbol, ShortPutStrike: short.StrikePrice,
		Contracts: contracts, NetDebitPerContract: debitPerShare, TotalDebit: debitPerShare * 100 * float64(contracts),
		RegimeScoreAtEntry: status.Score, PortfolioValueAtEntry: acct.PortfolioValue,
		EntryOrderID: id, Status: "pending_fill",
	}
	if err := e.ledger.Save(sp); err != nil {
		res.Errors = append(res.Errors, fmt.Sprintf("openNew: save: %v", err))
		return
	}
	res.Opened = append(res.Opened, sp.SpreadID)
}

// pickExpiry returns the nearest contract expiration whose DTE ∈ [DTEMin,DTEMax].
// Probes a chain near the band midpoint; the broker returns listed monthlies.
func (e *ProphetHedgeExecutor) pickExpiry(ctx context.Context, p SpreadProfile, now time.Time) (time.Time, bool) {
	probe := now.Add(time.Duration((p.DTEMin+p.DTEMax)/2) * 24 * time.Hour)
	chain, err := e.chain.GetOptionChain(ctx, "QQQ", probe)
	if err != nil || len(chain) == 0 {
		return time.Time{}, false
	}
	var best time.Time
	bestDTE := -1
	for _, c := range chain {
		dte := int(c.ExpirationDate.Sub(now).Hours() / 24)
		if dte >= p.DTEMin && dte <= p.DTEMax {
			if bestDTE == -1 || dte < bestDTE {
				bestDTE, best = dte, c.ExpirationDate
			}
		}
	}
	if bestDTE == -1 {
		return time.Time{}, false
	}
	return best, true
}
