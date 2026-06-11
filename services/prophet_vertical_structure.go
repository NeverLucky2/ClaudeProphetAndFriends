package services

import (
	"math"

	"prophet-trader/interfaces"
)

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

// nearestContract returns the listed contract of contractType whose strike is
// closest to target. Pure: no I/O. Returns nil if no contract of that type.
func nearestContract(chain map[string]*interfaces.OptionContract, contractType string, target float64) *interfaces.OptionContract {
	var best *interfaces.OptionContract
	bestDist := math.MaxFloat64
	for _, c := range chain {
		if c.ContractType != contractType {
			continue
		}
		if d := math.Abs(c.StrikePrice - target); d < bestDist {
			bestDist = d
			best = c
		}
	}
	return best
}

// pickVerticalStrikes snaps a long-leg target strike + a target width to real
// listed strikes for a debit vertical. Returns ok=false (caller skips, never
// half-builds) unless two distinct contracts form a genuine debit spread:
// call_debit needs the short strike strictly ABOVE the long; put_debit strictly
// BELOW. The long leg is always the more expensive (closer-to-money) leg.
func pickVerticalStrikes(chain map[string]*interfaces.OptionContract, dir VerticalDirection, longTarget, widthTarget float64) (long, short *interfaces.OptionContract, ok bool) {
	if widthTarget <= 0 {
		return nil, nil, false
	}
	switch dir {
	case CallDebit:
		long = nearestContract(chain, "call", longTarget)
		short = nearestContract(chain, "call", longTarget+widthTarget)
		if long == nil || short == nil || short.StrikePrice <= long.StrikePrice {
			return nil, nil, false
		}
	case PutDebit:
		long = nearestContract(chain, "put", longTarget)
		short = nearestContract(chain, "put", longTarget-widthTarget)
		if long == nil || short == nil || short.StrikePrice >= long.StrikePrice {
			return nil, nil, false
		}
	default:
		return nil, nil, false
	}
	return long, short, true
}

// verticalDebitLimit prices a marketable net-debit limit for a debit vertical,
// reusing the hedge pricer (marketableLimitCapped). longMid/shortMid are
// per-share mids; longBA/shortBA the per-leg bid/ask widths; width the absolute
// strike distance (the intrinsic ceiling — the spread can't be worth more).
func verticalDebitLimit(longMid, shortMid, longBA, shortBA, width, bufferFrac float64) float64 {
	return marketableLimitCapped(longMid, shortMid, longBA, shortBA, bufferFrac, math.Abs(width))
}
