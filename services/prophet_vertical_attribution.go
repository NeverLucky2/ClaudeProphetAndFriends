package services

import "math"

// normCDF is the standard normal CDF via the complementary error function.
func normCDF(x float64) float64 {
	return 0.5 * math.Erfc(-x/math.Sqrt2)
}

// bsPrice returns the Black-Scholes price of a European option. r is the
// risk-free rate (we pass 0 — an instructional approximation; American early
// exercise and r are deliberately ignored). t is time to expiry in years.
// Degenerate inputs (t≤0 or vol≤0) return intrinsic value.
func bsPrice(optType string, spot, strike, t, vol, r float64) float64 {
	if t <= 0 || vol <= 0 {
		switch optType {
		case "call":
			return math.Max(spot-strike, 0)
		case "put":
			return math.Max(strike-spot, 0)
		}
		return 0
	}
	d1 := (math.Log(spot/strike) + (r+0.5*vol*vol)*t) / (vol * math.Sqrt(t))
	d2 := d1 - vol*math.Sqrt(t)
	switch optType {
	case "call":
		return spot*normCDF(d1) - strike*math.Exp(-r*t)*normCDF(d2)
	case "put":
		return strike*math.Exp(-r*t)*normCDF(-d2) - spot*normCDF(-d1)
	}
	return 0
}

// verticalLegType returns the option type of a vertical's legs ("call" for
// call_debit, "put" for put_debit) — both legs share the type.
func verticalLegType(dir VerticalDirection) string {
	if dir == PutDebit {
		return "put"
	}
	return "call"
}

// VerticalSnapshot is the market state for repricing a vertical at one instant.
type VerticalSnapshot struct {
	Spot         float64
	LongVol      float64
	ShortVol     float64
	TimeToExpiry float64 // years
}

// verticalValuePerShare prices the net spread value per share at a snapshot:
// long leg price − short leg price (both legs the vertical's type, r=0).
func verticalValuePerShare(dir VerticalDirection, longStrike, shortStrike float64, snap VerticalSnapshot) float64 {
	ot := verticalLegType(dir)
	long := bsPrice(ot, snap.Spot, longStrike, snap.TimeToExpiry, snap.LongVol, 0)
	short := bsPrice(ot, snap.Spot, shortStrike, snap.TimeToExpiry, snap.ShortVol, 0)
	return long - short
}

// VerticalAttribution decomposes realized P&L into model components (dollars).
type VerticalAttribution struct {
	Direction float64
	Theta     float64
	IV        float64
	Residual  float64
}

// attributeVerticalPnl decomposes realized P&L (total dollars, per the actual
// fills) into direction/theta/IV via a FIXED-ORDER sequential Black-Scholes
// reprice walk (theta → direction → IV). Cross-effects are booked to the later
// step (gamma → direction; vega-spot interaction → IV). Residual reconciles the
// modeled total to the realized fill P&L. contracts scales per-share values to
// dollars (×100×contracts).
func attributeVerticalPnl(dir VerticalDirection, longStrike, shortStrike float64, entry, exit VerticalSnapshot, realizedPnL float64, contracts int) VerticalAttribution {
	scale := 100 * float64(contracts)
	v0 := verticalValuePerShare(dir, longStrike, shortStrike, entry)

	// Step 1 — theta: advance time to exit, hold spot & vols at entry.
	sTheta := entry
	sTheta.TimeToExpiry = exit.TimeToExpiry
	vTheta := verticalValuePerShare(dir, longStrike, shortStrike, sTheta)

	// Step 2 — direction: move spot to exit, vols still at entry, time at exit.
	sDir := sTheta
	sDir.Spot = exit.Spot
	vDir := verticalValuePerShare(dir, longStrike, shortStrike, sDir)

	// Step 3 — IV: move vols to exit (full exit snapshot).
	vIV := verticalValuePerShare(dir, longStrike, shortStrike, exit)

	theta := (vTheta - v0) * scale
	direction := (vDir - vTheta) * scale
	iv := (vIV - vDir) * scale
	residual := realizedPnL - (theta + direction + iv)
	return VerticalAttribution{Direction: direction, Theta: theta, IV: iv, Residual: residual}
}
