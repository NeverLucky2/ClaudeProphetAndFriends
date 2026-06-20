package services

import (
	"context"
	"time"

	"prophet-trader/interfaces"
)

// SingleLegSnapshot is the market state for repricing one option leg.
type SingleLegSnapshot struct {
	Spot         float64
	Vol          float64
	TimeToExpiry float64 // years
}

// SingleLegAttribution decomposes a single leg's realized P&L into model
// components (dollars). Teaching output.
type SingleLegAttribution struct {
	Direction float64
	Theta     float64
	IV        float64
	Residual  float64
}

// singleLegValuePerShare prices one option leg per share (r=0). sideSign is
// +1 for a long (bought) leg, −1 for a short (sold) leg.
func singleLegValuePerShare(optType string, sideSign, strike float64, snap SingleLegSnapshot) float64 {
	return sideSign * bsPrice(optType, snap.Spot, strike, snap.TimeToExpiry, snap.Vol, 0)
}

// attributeSingleLegPnl decomposes realizedPnL (total dollars) into
// direction/theta/IV via the SAME fixed-order theta→direction→IV reprice walk as
// attributeVerticalPnl, pricing one leg with bsPrice. Kept behavior-parallel to
// the vertical engine on purpose (so the single-leg-vs-vertical comparison is a
// like-for-like decomposition). optType is "call"|"put"; isLong true for a
// bought leg; contracts scales per-share values to dollars (×100×contracts).
func attributeSingleLegPnl(optType string, isLong bool, strike float64, entry, exit SingleLegSnapshot, realizedPnL float64, contracts int) SingleLegAttribution {
	sideSign := 1.0
	if !isLong {
		sideSign = -1.0
	}
	scale := 100 * float64(contracts)
	v0 := singleLegValuePerShare(optType, sideSign, strike, entry)

	// Step 1 — theta: advance time to exit, hold spot & vol at entry.
	sTheta := entry
	sTheta.TimeToExpiry = exit.TimeToExpiry
	vTheta := singleLegValuePerShare(optType, sideSign, strike, sTheta)

	// Step 2 — direction: move spot to exit, vol still at entry, time at exit.
	sDir := sTheta
	sDir.Spot = exit.Spot
	vDir := singleLegValuePerShare(optType, sideSign, strike, sDir)

	// Step 3 — IV: move vol to exit (full exit snapshot).
	vIV := singleLegValuePerShare(optType, sideSign, strike, exit)

	theta := (vTheta - v0) * scale
	direction := (vDir - vTheta) * scale
	iv := (vIV - vDir) * scale
	residual := realizedPnL - (theta + direction + iv)
	return SingleLegAttribution{Direction: direction, Theta: theta, IV: iv, Residual: residual}
}

// chainFetcher is the narrow data dep the single-leg snapshot needs for the options chain,
// satisfied by interfaces.TradingService.GetOptionsChain. barFetcher is already defined
// in turtle_executor.go with the same GetLatestBar signature.
type chainFetcher interface {
	GetOptionsChain(ctx context.Context, underlying string, expiration time.Time) ([]*interfaces.OptionContract, error)
}

// occExpiry parses an OCC symbol's YYMMDD expiry to a UTC date.
func occExpiry(occSymbol string) (time.Time, bool) {
	_, expStr, _, ok := ParseOCC(occSymbol)
	if !ok {
		return time.Time{}, false
	}
	exp, err := time.Parse("060102", expStr)
	if err != nil {
		return time.Time{}, false
	}
	return exp, true
}

// optionMidAndIV finds the contract by OCC symbol in chain and returns its mid
// (Bid+Ask)/2 and implied vol. ok=false if not found or either quote ≤ 0.
func optionMidAndIV(chain []*interfaces.OptionContract, occSymbol string) (mid, iv float64, ok bool) {
	for _, c := range chain {
		if c == nil || c.Symbol != occSymbol {
			continue
		}
		if c.Bid <= 0 || c.Ask <= 0 {
			return 0, 0, false
		}
		return (c.Bid + c.Ask) / 2, c.ImpliedVolatility, true
	}
	return 0, 0, false
}

// singleLegSnapshotNow fetches the underlying spot, the option's implied vol,
// its mid mark, and time-to-expiry for occSymbol at time now. ok=false if
// occSymbol is not an option or the underlying spot is unavailable; on a
// degraded options feed ok is still true but snap.Vol and mark are 0 (the caller
// decides whether that is good enough to attribute).
func singleLegSnapshotNow(ctx context.Context, bars barFetcher, chains chainFetcher, occSymbol string, now time.Time) (snap SingleLegSnapshot, mark float64, ok bool) {
	if !IsOptionSymbol(occSymbol) {
		return SingleLegSnapshot{}, 0, false
	}
	exp, expOK := occExpiry(occSymbol)
	if !expOK {
		return SingleLegSnapshot{}, 0, false
	}
	underlying := ParseOCCUnderlying(occSymbol)
	bar, err := bars.GetLatestBar(ctx, underlying)
	if err != nil || bar == nil || bar.Close <= 0 {
		return SingleLegSnapshot{}, 0, false
	}
	snap.Spot = bar.Close
	snap.TimeToExpiry = exp.Sub(now).Hours() / 24 / 365
	if chain, cerr := chains.GetOptionsChain(ctx, underlying, exp); cerr == nil {
		if mid, iv, found := optionMidAndIV(chain, occSymbol); found {
			snap.Vol = iv
			mark = mid
		}
	}
	return snap, mark, true
}
