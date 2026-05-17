package services

import (
	"context"
	"fmt"
	"time"

	"prophet-trader/interfaces"
	"prophet-trader/models"

	"github.com/sirupsen/logrus"
)

// turtleUniverse mirrors controllers.TrendUniverse — kept local so the
// executor has no upstream import on controllers, which would create a cycle.
// If these ever drift, both must be updated together; consider promoting to
// a shared models package as a follow-up.
var turtleUniverse = []string{"TLT", "GLD", "USO", "DBC", "UUP", "EEM"}

const (
	turtleWindowStartMin  = 16*60 + 55 // 16:55 ET
	turtleWindowEndMin    = 17*60 + 5  // 17:05 ET
	turtlePositionCap     = 5
	turtleDeployedCapPct  = 18.0
	turtleAggRiskCapPct   = 0.025
	turtleSegmentBreaker  = -2.0
	turtleLimitMultiplier = 1.005
)

// signalFetcher is implemented by *TrendSignalService in production.
type signalFetcher interface {
	GetSignal(ctx context.Context, symbol string) (*TrendSignal, error)
}

// barFetcher is implemented by *AlpacaDataService in production.
type barFetcher interface {
	GetLatestBar(ctx context.Context, symbol string) (*interfaces.Bar, error)
}

// turtleTrader is the trading subset the executor needs.
type turtleTrader interface {
	PlaceOrder(ctx context.Context, order *interfaces.Order) (*interfaces.OrderResult, error)
	GetOrder(ctx context.Context, orderID string) (*interfaces.Order, error)
	GetAccount(ctx context.Context) (*interfaces.Account, error)
}

// segmentPnLFetcher is implemented by *SegmentPnLService.
type segmentPnLFetcher interface {
	GetSegmentPnL(ctx context.Context, strategy string) (*SegmentPnL, error)
}

// regimeGateFetcher is implemented by *RegimeGateService.
type regimeGateFetcher interface {
	GetStatus() RegimeGateStatus
}

// turtleGuard is the TradeGuard subset for buy-side checks.
type turtleGuard interface {
	CheckBuy(ctx context.Context, agent AgentSource, symbol string, allocationDollars float64) error
}

// HeartbeatResult is the per-beat outcome returned by RunHeartbeat. Cached
// by the scheduler and exposed via /api/v1/turtle/status.
type HeartbeatResult struct {
	Date           string   `json:"date"`
	PositionsOpen  int      `json:"positions_open"`
	Evaluated      []string `json:"evaluated,omitempty"`
	Entries        []string `json:"entries,omitempty"`
	Exits          []string `json:"exits,omitempty"`
	Skips          []string `json:"skips,omitempty"`
	Errors         []string `json:"errors,omitempty"`
	CircuitBreaker bool     `json:"circuit_breaker"`
	SkipEntries    bool     `json:"skip_entries"`
	// Skipped is the top-level early-return skip reason from preloopCheck
	// (out-of-window or duplicate-heartbeat). Empty if the beat ran.
	Skipped string `json:"skipped,omitempty"`
}

// TurtleExecutor runs the full TRADING_RULES_TREND.md heartbeat sequence on
// each tick. Owns no state — all per-beat scratch lives in HeartbeatResult.
type TurtleExecutor struct {
	ledger     *TurtleLedger
	signals    signalFetcher
	bars       barFetcher
	trader     turtleTrader
	segmentPnL segmentPnLFetcher
	regimeGate regimeGateFetcher
	guard      turtleGuard
	logger     *logrus.Logger
}

// NewTurtleExecutor wires the executor with all live deps.
func NewTurtleExecutor(
	ledger *TurtleLedger,
	signals signalFetcher,
	bars barFetcher,
	trader turtleTrader,
	segmentPnL segmentPnLFetcher,
	regimeGate regimeGateFetcher,
	guard turtleGuard,
	logger *logrus.Logger,
) *TurtleExecutor {
	return &TurtleExecutor{
		ledger:     ledger,
		signals:    signals,
		bars:       bars,
		trader:     trader,
		segmentPnL: segmentPnL,
		regimeGate: regimeGate,
		guard:      guard,
		logger:     logger,
	}
}

// wouldExceedAggregateRiskCap returns true if adding the proposed entry
// would push aggregate risk above turtleAggRiskCapPct (2.5%).
// Aggregate risk = Σ(2 * atr_at_entry * shares) / portfolio_value across
// all open and pending_fill rows.
//
// Strict-greater semantics: exactly 2.5% is allowed (returns false). When
// portfolio is non-positive, the helper fails closed (returns true) — we
// can't compute the ratio safely, so don't approve.
func wouldExceedAggregateRiskCap(open []*models.DBTrendLedgerEntry, proposedATR float64, proposedShares int, portfolio float64) bool {
	if portfolio <= 0 {
		return true // fail-closed
	}
	sum := 2.0 * proposedATR * float64(proposedShares)
	for _, row := range open {
		sum += 2.0 * row.ATRAtEntry * float64(row.Shares)
	}
	return sum/portfolio > turtleAggRiskCapPct
}

// preloopCheck returns a non-empty reason when the beat should be aborted
// entirely before reconcile/exits/entries. Only out-of-window and
// duplicate-heartbeat cases short-circuit the whole beat; regime/circuit/
// deployed checks merely set SkipEntries (handled inside RunHeartbeat).
func (e *TurtleExecutor) preloopCheck(now time.Time, session *models.DBTurtleSession) string {
	et, _ := time.LoadLocation("America/New_York")
	local := now.In(et)
	mins := local.Hour()*60 + local.Minute()
	if mins < turtleWindowStartMin || mins > turtleWindowEndMin {
		return fmt.Sprintf("out-of-window: %02d:%02d ET (runs 16:55-17:05)", local.Hour(), local.Minute())
	}
	today := local.Format("2006-01-02")
	if session != nil && session.LastHeartbeatDate == today {
		return fmt.Sprintf("duplicate heartbeat for %s — skipping", today)
	}
	return ""
}

// todayET returns the ET-localized YYYY-MM-DD date for now.
func todayET(now time.Time) string {
	et, _ := time.LoadLocation("America/New_York")
	return now.In(et).Format("2006-01-02")
}

// RunHeartbeat runs the full per-day heartbeat sequence from
// TRADING_RULES_TREND.md "Heartbeat Behavior" (lines 332-374).
//
// Sequence:
//  1. preloop checks (out-of-window, duplicate heartbeat) — short-circuit
//  2. load/create session, reconcile pending-fill orders
//  3. determine gating flags (regime, segment circuit breaker, deployed cap)
//  4. exit loop across all open ledger rows
//  5. entry loop across the universe (only when no exit errors and gates clear)
//  6. cold-start flip + session save
func (e *TurtleExecutor) RunHeartbeat(ctx context.Context, now time.Time) (*HeartbeatResult, error) {
	res := &HeartbeatResult{Date: todayET(now)}

	// Load session up front so preloop can check duplicate-heartbeat.
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
		// First-run: create the singleton row. SaveSession normalizes the
		// empty SessionID to "singleton" inside the storage layer.
		session = &models.DBTurtleSession{SessionID: "singleton"}
	}

	// Update session bookkeeping (LastHeartbeatDate) at the END, after the
	// beat actually runs. If anything below panics, the next beat will
	// re-process today rather than silently mark it complete.

	// Snapshot the open ledger once; pass to all loops.
	openRows, err := e.ledger.ListOpen()
	if err != nil {
		res.Errors = append(res.Errors, fmt.Sprintf("list open: %v", err))
		return res, nil
	}

	// Split rows into open (for exits) and pending_fill (for reconcile).
	var openForExits []*models.DBTrendLedgerEntry
	var pendingFills []*models.DBTrendLedgerEntry
	for _, r := range openRows {
		switch r.Status {
		case "open":
			openForExits = append(openForExits, r)
		case "pending_fill":
			pendingFills = append(pendingFills, r)
		}
	}

	// Step 4 (run FIRST per the plan skeleton): pending-fill reconciliation.
	e.reconcilePendingFills(ctx, pendingFills, now, res)

	// Compute gate flags from segment-PnL + regime + persisted circuit breaker.
	e.applyGates(ctx, session, res)

	// Step 2: exit loop.
	e.runExits(ctx, openForExits, now, res)

	// Step 3: entry loop (skipped if exits had errors or gates closed).
	if !res.SkipEntries && len(res.Errors) == 0 {
		// Build held-symbol set from BOTH open and pending_fill rows so we
		// don't double up on a ticker that still has yesterday's order
		// in flight.
		held := map[string]struct{}{}
		for _, r := range openRows {
			held[r.Ticker] = struct{}{}
		}
		e.runEntries(ctx, openRows, held, session, now, res)
	}

	// Cold-start flip: per rules-doc line 168 the flag flips after the first
	// heartbeat with at least one filled position. At order-placement time we
	// don't know if the order will fill; we treat "successful order placement"
	// as the trigger (the entry exists in the ledger as pending_fill).
	// Reconciliation handles the "did it actually fill" case on the next beat.
	if !session.ColdStartCompleted && len(res.Entries) > 0 {
		session.ColdStartCompleted = true
	}

	session.LastHeartbeatDate = todayET(now)
	if res.CircuitBreaker {
		session.CircuitBreakerTrippedDate = todayET(now)
	}
	if err := e.ledger.SaveSession(session); err != nil {
		res.Errors = append(res.Errors, fmt.Sprintf("save session: %v", err))
	}

	// Count of still-open positions (open + pending_fill) at end of beat,
	// for the status endpoint.
	if fresh, err := e.ledger.ListOpen(); err == nil {
		res.PositionsOpen = len(fresh)
	}
	return res, nil
}

// reconcilePendingFills handles Step 4: for each pending_fill row, check the
// broker order state and transition the row accordingly. See the rule
// pinned in the task brief for status semantics.
func (e *TurtleExecutor) reconcilePendingFills(ctx context.Context, rows []*models.DBTrendLedgerEntry, now time.Time, res *HeartbeatResult) {
	for _, row := range rows {
		if row.EntryOrderID == "" {
			res.Errors = append(res.Errors, fmt.Sprintf("reconcile %s: empty EntryOrderID", row.Ticker))
			continue
		}
		ord, err := e.trader.GetOrder(ctx, row.EntryOrderID)
		if err != nil {
			res.Errors = append(res.Errors, fmt.Sprintf("reconcile %s: GetOrder(%s): %v", row.Ticker, row.EntryOrderID, err))
			continue
		}
		switch ord.Status {
		case "filled", "partially_filled":
			if ord.FilledAvgPrice == nil {
				res.Errors = append(res.Errors, fmt.Sprintf("reconcile %s: %s status with nil FilledAvgPrice — leaving as pending_fill", row.Ticker, ord.Status))
				continue
			}
			row.Status = "open"
			row.EntryPrice = *ord.FilledAvgPrice
			row.Shares = int(ord.FilledQty)
			row.InitialStop = row.EntryPrice - 2.0*row.ATRAtEntry
			if err := e.ledger.Save(row); err != nil {
				res.Errors = append(res.Errors, fmt.Sprintf("reconcile %s: save: %v", row.Ticker, err))
			}
		case "canceled", "expired":
			row.Status = "closed"
			row.ExitReason = "missed_entry"
			t := now
			row.ExitDate = &t
			if err := e.ledger.Save(row); err != nil {
				res.Errors = append(res.Errors, fmt.Sprintf("reconcile %s: save: %v", row.Ticker, err))
			}
		default:
			// "new", "accepted", "pending_new", etc. — still working; leave alone.
		}
	}
}

// applyGates inspects regime, segment-PnL, deployed cap, and the persisted
// circuit-breaker date, mutating res.SkipEntries / res.CircuitBreaker.
//
// Order of checks matches the rules-doc "Heartbeat Behavior" section:
//   - regime block → SkipEntries
//   - segment circuit breaker (PnL <= -2.0%) → CircuitBreaker + SkipEntries
//   - persisted circuit-breaker date == today → CircuitBreaker still in effect
//   - deployed cap (>= 18.0%) → SkipEntries
//
// On segment-PnL fetch error the gate fails closed (SkipEntries=true) so we
// don't add capital while the live deployed/PnL view is dark.
func (e *TurtleExecutor) applyGates(ctx context.Context, session *models.DBTurtleSession, res *HeartbeatResult) {
	if e.regimeGate != nil && e.regimeGate.GetStatus().BlockNewEntries {
		res.SkipEntries = true
	}
	// Persisted breaker: if we tripped earlier today and the session was saved
	// before a crash, honor that flag for the rest of the day.
	if session != nil && session.CircuitBreakerTrippedDate == res.Date {
		res.CircuitBreaker = true
		res.SkipEntries = true
	}
	if e.segmentPnL == nil {
		return
	}
	seg, err := e.segmentPnL.GetSegmentPnL(ctx, "trend")
	if err != nil {
		res.Errors = append(res.Errors, fmt.Sprintf("segment pnl: %v", err))
		res.SkipEntries = true
		return
	}
	if seg.UnrealizedPnLPct <= turtleSegmentBreaker {
		res.CircuitBreaker = true
		res.SkipEntries = true
	}
	if seg.DeployedPercent >= turtleDeployedCapPct {
		res.SkipEntries = true
	}
}

// runExits applies the exit loop. For each open row, fetch today's signal +
// bar, compute days_since_entry, evaluate the exit rules; if a rule fires,
// place a market sell tagged Strategy="trend" and flip the ledger row.
// Errors are appended to res.Errors but don't halt the loop — other rows
// still get evaluated. Per the plan's self-review gap #1, any exit error
// later aborts the entry loop entirely (handled by RunHeartbeat).
func (e *TurtleExecutor) runExits(ctx context.Context, rows []*models.DBTrendLedgerEntry, now time.Time, res *HeartbeatResult) {
	for _, row := range rows {
		sig, err := e.signals.GetSignal(ctx, row.Ticker)
		if err != nil {
			res.Errors = append(res.Errors, fmt.Sprintf("exit %s: signal: %v", row.Ticker, err))
			continue
		}
		bar, err := e.bars.GetLatestBar(ctx, row.Ticker)
		if err != nil {
			res.Errors = append(res.Errors, fmt.Sprintf("exit %s: bar: %v", row.Ticker, err))
			continue
		}
		days := int(now.Sub(row.EntryDate).Hours() / 24)
		ev := evaluateExit(row, sig, bar.Open, days)
		if ev.Reason == "" {
			continue
		}
		ord, err := e.trader.PlaceOrder(ctx, &interfaces.Order{
			Symbol:      row.Ticker,
			Qty:         float64(row.Shares),
			Side:        "sell",
			Type:        "market",
			TimeInForce: "day",
			Strategy:    "trend",
		})
		if err != nil {
			res.Errors = append(res.Errors, fmt.Sprintf("exit %s: place sell: %v", row.Ticker, err))
			continue
		}
		row.Status = "closed"
		row.ExitReason = ev.Reason
		row.ExitOrderID = ord.OrderID
		exitT := now
		row.ExitDate = &exitT
		if err := e.ledger.Save(row); err != nil {
			res.Errors = append(res.Errors, fmt.Sprintf("exit %s: save: %v", row.Ticker, err))
			continue
		}
		res.Exits = append(res.Exits, row.Ticker)
	}
}

// runEntries iterates the universe and places limit buys for each ticker
// that passes the full eligibility ladder: not already held, fresh signal
// passes evaluateEntry (with coldStart proximity if session.ColdStartCompleted
// is false), under the position-count cap, under the aggregate-risk cap, and
// the TradeGuard's CheckBuy approves it. Per-ticker failures append to skips
// or errors but don't halt the loop (self-review gap #5).
//
// AgentMain is passed to TradeGuard: Turtle is not from the penny pipeline,
// so the symbol-overlap / penny-cap rules don't apply; the daily-loss
// circuit breaker (account-wide) still engages.
func (e *TurtleExecutor) runEntries(ctx context.Context, openRows []*models.DBTrendLedgerEntry, held map[string]struct{}, session *models.DBTurtleSession, now time.Time, res *HeartbeatResult) {
	entriesPlaced := 0
	coldStart := session == nil || !session.ColdStartCompleted

	for _, ticker := range turtleUniverse {
		if _, ok := held[ticker]; ok {
			continue
		}
		// Position-count cap (open + pending_fill + entries placed this beat).
		if len(openRows)+entriesPlaced >= turtlePositionCap {
			res.Skips = append(res.Skips, fmt.Sprintf("%s: position count cap (%d)", ticker, turtlePositionCap))
			continue
		}
		sig, err := e.signals.GetSignal(ctx, ticker)
		if err != nil {
			res.Errors = append(res.Errors, fmt.Sprintf("entry %s: signal: %v", ticker, err))
			continue
		}
		ev := evaluateEntry(sig, coldStart)
		if !ev.Eligible {
			res.Skips = append(res.Skips, fmt.Sprintf("%s: %s", ticker, ev.Reason))
			continue
		}
		acct, err := e.trader.GetAccount(ctx)
		if err != nil {
			res.Errors = append(res.Errors, fmt.Sprintf("entry %s: account: %v", ticker, err))
			continue
		}
		regimeMult := 1.0
		if e.regimeGate != nil {
			regimeMult = e.regimeGate.GetStatus().SizingMultiplier
		}
		dollars := computePositionDollars(acct.PortfolioValue, sig.LastClose, sig.ATR20, regimeMult)
		if dollars == 0 {
			res.Skips = append(res.Skips, fmt.Sprintf("%s: computed position dollars = 0 (regime/inputs)", ticker))
			continue
		}
		proposedShares := int(dollars / sig.LastClose)
		if proposedShares < 1 {
			res.Skips = append(res.Skips, fmt.Sprintf("%s: proposed shares < 1 (portfolio too small)", ticker))
			continue
		}
		if wouldExceedAggregateRiskCap(openRows, sig.ATR20, proposedShares, acct.PortfolioValue) {
			res.Skips = append(res.Skips, fmt.Sprintf("%s: aggregate risk cap would exceed %.1f%%", ticker, turtleAggRiskCapPct*100))
			continue
		}
		if e.guard != nil {
			if err := e.guard.CheckBuy(ctx, AgentMain, ticker, dollars); err != nil {
				res.Skips = append(res.Skips, fmt.Sprintf("%s: guard: %v", ticker, err))
				continue
			}
		}
		limitPrice := sig.LastClose * turtleLimitMultiplier
		ord, err := e.trader.PlaceOrder(ctx, &interfaces.Order{
			Symbol:      ticker,
			Qty:         float64(proposedShares),
			Side:        "buy",
			Type:        "limit",
			TimeInForce: "day",
			LimitPrice:  &limitPrice,
			Strategy:    "trend",
		})
		if err != nil {
			res.Errors = append(res.Errors, fmt.Sprintf("entry %s: place buy: %v", ticker, err))
			continue
		}
		entry := &models.DBTrendLedgerEntry{
			Ticker:                 ticker,
			EntryDate:              now,
			EntryPrice:             sig.LastClose,
			Shares:                 proposedShares,
			ATRAtEntry:             sig.ATR20,
			InitialStop:            sig.LastClose - 2.0*sig.ATR20,
			Donchian100HighAtEntry: sig.Donchian100High,
			Strategy:               "trend",
			Status:                 "pending_fill",
			EntryOrderID:           ord.OrderID,
		}
		if err := e.ledger.Save(entry); err != nil {
			res.Errors = append(res.Errors, fmt.Sprintf("entry %s: save: %v", ticker, err))
			continue
		}
		entriesPlaced++
		res.Entries = append(res.Entries, ticker)
	}
}

// EntryEval is the result of the per-ticker eligibility check before placing
// a new Turtle long entry. Eligible=false ⇒ skip; Reason is for the activity log.
type EntryEval struct {
	Eligible bool
	Reason   string
}

// evaluateEntry applies the entry rules from TRADING_RULES_TREND.md "Signal
// Definitions → Entry signal". When coldStart is true (no successful first
// heartbeat yet), the proximity filter is added on top of the standard
// breakout + regime + volatility checks.
//
// Order of checks (must match the rule doc):
//  1. sig != nil and BarsCount >= 250          (insufficient history skip)
//  2. last_close > donchian_100_high          (breakout)
//  3. last_close > sma_200                    (regime filter)
//  4. atr_20 / last_close >= 0.005            (volatility floor; 0.5%)
//  5. cold-start only: last_close - donchian_100_high <= atr_20
//     (proximity filter — entries only near the breakout area; reject when
//     last_close is more than 1 ATR ABOVE the breakout, since by check #2
//     last_close > donchian_100_high is already guaranteed)
func evaluateEntry(sig *TrendSignal, coldStart bool) EntryEval {
	if sig == nil {
		return EntryEval{false, "no signal"}
	}
	if sig.BarsCount < 250 {
		return EntryEval{false, fmt.Sprintf("insufficient history: bars=%d", sig.BarsCount)}
	}
	if sig.LastClose <= sig.Donchian100High {
		return EntryEval{false, "last_close not above Donchian-100 high"}
	}
	if sig.LastClose <= sig.SMA200 {
		return EntryEval{false, "last_close not above SMA-200 (regime filter)"}
	}
	if sig.LastClose == 0 || sig.ATR20/sig.LastClose < 0.005 {
		return EntryEval{false, "ATR / last_close below 0.5% volatility floor"}
	}
	if coldStart {
		if sig.LastClose-sig.Donchian100High > sig.ATR20 {
			return EntryEval{false, "cold-start proximity filter: > 1 ATR above breakout"}
		}
	}
	return EntryEval{true, ""}
}

// ExitEval is the result of the per-position exit check at heartbeat time.
// Empty Reason ⇒ hold; non-empty ⇒ exit at market for the named rule.
type ExitEval struct {
	Reason string // "trailing_stop" | "initial_hard_stop" | ""
}

// evaluateExit applies TRADING_RULES_TREND.md "Exit signals" against today's
// open price (the first trade of the session, recorded into the daily bar).
// At 17:00 ET the daily bar's Open is final, so the executor reads it from
// the latest daily bar — see Task 3.
//
//   - Trailing stop (always active): today_open <= donchian_50_low → exit.
//   - Initial hard stop (only active when days_since_entry <= 20):
//     today_open <= entry.InitialStop → exit.
//
// Both nil entry and nil sig produce a hold (no exit signal, no panic).
func evaluateExit(entry *models.DBTrendLedgerEntry, sig *TrendSignal, todayOpen float64, daysSinceEntry int) ExitEval {
	if entry == nil || sig == nil {
		return ExitEval{}
	}
	if todayOpen <= sig.Donchian50Low {
		return ExitEval{Reason: "trailing_stop"}
	}
	if daysSinceEntry <= 20 && todayOpen <= entry.InitialStop {
		return ExitEval{Reason: "initial_hard_stop"}
	}
	return ExitEval{}
}

// computePositionDollars implements TRADING_RULES_TREND.md "Position Sizing":
//
//	stop_distance_per_share = 2 * atr20
//	position_dollars = (portfolio * 0.005) / (stop_distance_per_share / last_close)
//	position_dollars = min(position_dollars * sizing_multiplier, portfolio * 0.04)
//
// The 0.005 (50 bps) is the per-trade risk budget; the 0.04 (4%) is the
// per-position notional cap (TRADING_RULES_TREND.md line 253:
// "Maximum 4% of portfolio per single trend position (hard cap, regardless
// of computed size)") that prevents low-vol assets from sizing pathologically
// large. Returns 0 when any input is non-positive.
func computePositionDollars(portfolio, lastClose, atr20, sizingMultiplier float64) float64 {
	if portfolio <= 0 || lastClose <= 0 || atr20 <= 0 {
		return 0
	}
	stopDistance := 2.0 * atr20
	riskBudget := portfolio * 0.005
	raw := riskBudget / (stopDistance / lastClose)
	raw *= sizingMultiplier
	cap := portfolio * 0.04
	if raw > cap {
		return cap
	}
	return raw
}
