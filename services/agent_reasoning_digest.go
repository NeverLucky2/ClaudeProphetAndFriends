package services

import "fmt"

// Deterministic, zero-LLM-token "why" lines for the mechanical agents (Coil,
// Turtle). These functions only FORMAT real signal values plus the agent's
// actual decision — they never re-derive the decision, so the rendered
// explanation can never contradict what the agent did. Surfaced to the user as a
// daily teaching digest. ASCII-only output (avoids Windows log-encoding pitfalls).

// fmtUSD formats a price as $X.XX.
func fmtUSD(v float64) string { return fmt.Sprintf("$%.2f", v) }

// volPctOf returns ATR as a percent of price (0 when price is 0).
func volPctOf(atr, price float64) float64 {
	if price == 0 {
		return 0
	}
	return 100 * atr / price
}

// ExplainMeanRevEntry renders Coil's per-symbol entry rationale. The verdict is
// taken from the service's authoritative sig.EntrySignal; on a pass it names the
// first failing gate in the documented order (RSI → uptrend → pullback →
// earnings).
func ExplainMeanRevEntry(sig MeanRevSignal) string {
	rsi := fmt.Sprintf("RSI(2)=%.1f", sig.RSI2)
	if sig.EntrySignal {
		return fmt.Sprintf(
			"Coil %s ENTER (oversold pullback in uptrend): %s (<5), close %s above SMA-200 %s, below SMA-5 %s, no earnings within 5d",
			sig.Ticker, rsi, fmtUSD(sig.LastClose), fmtUSD(sig.SMA200), fmtUSD(sig.SMA5),
		)
	}
	return fmt.Sprintf("Coil %s PASS -> no entry (%s): %s, close %s",
		sig.Ticker, meanRevBlocker(sig), rsi, fmtUSD(sig.LastClose))
}

// meanRevBlocker names the first failing entry gate, in the rule-documented
// order. Mirrors the entry predicate in MeanRevSignalService (rsi2 <
// meanRevRSIEntryMax && close > SMA200 && close < SMA5 && !earnings).
func meanRevBlocker(sig MeanRevSignal) string {
	switch {
	case !(sig.RSI2 < meanRevRSIEntryMax):
		return fmt.Sprintf("RSI(2)=%.1f >= 5, not oversold enough", sig.RSI2)
	case !(sig.LastClose > sig.SMA200):
		return fmt.Sprintf("close %s below SMA-200 %s (not an uptrend)", fmtUSD(sig.LastClose), fmtUSD(sig.SMA200))
	case !(sig.LastClose < sig.SMA5):
		return fmt.Sprintf("close %s not below SMA-5 %s (no pullback)", fmtUSD(sig.LastClose), fmtUSD(sig.SMA5))
	case sig.EarningsWithin5d:
		return "earnings within 5 days"
	default:
		return "all gates pass" // unreachable when EntrySignal is false
	}
}

// ExplainTrendEntry renders Turtle's per-symbol entry rationale. `entered` and
// `blockReason` come from the executor's own evaluateEntry result (EntryEval), so
// the line never re-derives — it surfaces the executor's authoritative verdict
// and, on a pass, its verbatim reason.
func ExplainTrendEntry(sig TrendSignal, entered bool, blockReason string) string {
	facts := fmt.Sprintf(
		"close %s, Donchian-100 high %s, SMA-200 %s, ATR-20 %s (%.1f%% vol), Donchian-50 low %s (trail)",
		fmtUSD(sig.LastClose), fmtUSD(sig.Donchian100High), fmtUSD(sig.SMA200),
		fmtUSD(sig.ATR20), volPctOf(sig.ATR20, sig.LastClose), fmtUSD(sig.Donchian50Low),
	)
	if entered {
		return fmt.Sprintf("Turtle %s ENTER (breakout above Donchian-100 high, above SMA-200): %s", sig.Ticker, facts)
	}
	return fmt.Sprintf("Turtle %s PASS -> no entry (%s): %s", sig.Ticker, blockReason, facts)
}
