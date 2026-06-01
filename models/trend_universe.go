package models

import "strings"

// TrendInstrument is one ETF in the Turtle/Trend basket, annotated with its
// macro-driver cluster. The cluster drives the one-position-per-driver
// diversification cap (see services.clusterSlotTaken).
type TrendInstrument struct {
	Ticker  string
	Cluster string
}

// TrendUniverse is the single source of truth for the Turtle/Trend basket:
// 15 liquid, unleveraged, non-inverse ETFs spanning 6 genuinely different
// macro drivers. No leveraged/inverse names (decay destroys trend systems);
// no broad-equity beta except the capped intl_equity cluster. Both the HTTP
// controller (controllers.TrendController) and the Go executor
// (services.TurtleExecutor) read from this list — do not re-declare it.
var TrendUniverse = []TrendInstrument{
	{"TLT", "rates"}, {"IEF", "rates"}, {"TIP", "rates"},
	{"GLD", "metals"}, {"SLV", "metals"},
	{"USO", "energy"}, {"UNG", "energy"},
	{"DBC", "commodity"}, {"DBA", "commodity"}, {"DBB", "commodity"},
	{"UUP", "fx"}, {"FXE", "fx"}, {"FXY", "fx"},
	{"EEM", "intl_equity"}, {"EFA", "intl_equity"},
}

// TrendUniverseTickers returns just the tickers, for call sites that need a
// plain []string (the agent-universe gate; the controller's 400 payload).
func TrendUniverseTickers() []string {
	out := make([]string, len(TrendUniverse))
	for i, inst := range TrendUniverse {
		out[i] = inst.Ticker
	}
	return out
}

// ClusterOf returns the driver cluster for a ticker (case-insensitive), or ""
// if the ticker is not part of the trend universe.
func ClusterOf(ticker string) string {
	t := strings.ToUpper(strings.TrimSpace(ticker))
	for _, inst := range TrendUniverse {
		if inst.Ticker == t {
			return inst.Cluster
		}
	}
	return ""
}

// InTrendUniverse reports whether ticker is part of the trend basket.
func InTrendUniverse(ticker string) bool {
	return ClusterOf(ticker) != ""
}
