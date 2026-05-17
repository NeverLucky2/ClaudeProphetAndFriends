package services

import (
	"fmt"

	"prophet-trader/models"
)

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
