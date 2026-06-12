package services

import "context"

// MultiLegOrder represents a multi-leg options combo order for Alpaca's mleg API
// (e.g. DefensiveProphet's put-debit spreads). Relocated here from the retired
// Harvest service; the type is shared infrastructure, not condor-specific.
type MultiLegOrder struct {
	Underlying  string
	Legs        []MultiLegOrderLeg
	Contracts   int
	// LimitPrice is passed straight through to Alpaca's mleg limit_price.
	// Alpaca convention (Options Level 3 docs): POSITIVE = net debit we pay,
	// NEGATIVE = net credit we receive, 0 = market combo. (An earlier comment
	// here said positive=credit — that was Harvest-era legacy and wrong.)
	LimitPrice  float64
	TimeInForce string  // "day"
	// Strategy identifies the agent that owns this combo. Encoded into
	// Alpaca's client_order_id as "{strategy}:{uuid}" so the tag survives
	// fills and reconciliation. Empty string is a no-op (legacy behavior).
	Strategy string
}

// MultiLegOrderLeg is one leg of the combo.
type MultiLegOrderLeg struct {
	Symbol         string
	Side           string // "buy" | "sell"
	PositionIntent string // "buy_to_open" | "sell_to_open" | "buy_to_close" | "sell_to_close"
}

// PlaceMultiLegOrderFn is a function that places a multi-leg order.
// Injectable for testing without a real broker connection.
type PlaceMultiLegOrderFn func(ctx context.Context, order MultiLegOrder) (string, error)
