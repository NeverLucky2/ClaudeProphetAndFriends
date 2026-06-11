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
