package services

import "math"

// VerticalDirection identifies a debit vertical's directional bias.
type VerticalDirection string

const (
	// CallDebit is bullish: buy the lower-strike call, sell the higher-strike call.
	CallDebit VerticalDirection = "call_debit"
	// PutDebit is bearish: buy the higher-strike put, sell the lower-strike put.
	PutDebit VerticalDirection = "put_debit"
)

// VerticalStructure is a fully-specified debit vertical ready to price/place.
// The long leg is always the more expensive (closer-to-money) leg, so
// NetDebitPerShare (= long mid − short mid) is positive for a genuine debit.
type VerticalStructure struct {
	Direction        VerticalDirection
	LongSymbol       string
	LongStrike       float64
	ShortSymbol      string
	ShortStrike      float64
	NetDebitPerShare float64
}

// verticalEconomics returns per-CONTRACT max loss, max gain, and the underlying
// breakeven price for a debit vertical. Width = |longStrike − shortStrike|.
// Max loss = net debit (×100); max gain = (width − net debit) ×100.
func verticalEconomics(dir VerticalDirection, longStrike, shortStrike, netDebitPerShare float64) (maxLoss, maxGain, breakeven float64) {
	width := math.Abs(longStrike - shortStrike)
	maxLoss = netDebitPerShare * 100
	maxGain = (width - netDebitPerShare) * 100
	switch dir {
	case CallDebit:
		breakeven = longStrike + netDebitPerShare
	case PutDebit:
		breakeven = longStrike - netDebitPerShare
	}
	return maxLoss, maxGain, breakeven
}
