package services

import "fmt"

// Prophet debit-vertical "cheapness" teaching constants. Pure, local, and
// intentionally NOT placed in prophet_vertical_constants.go so this module
// never collides with the in-flight executor/scheduler work. Pre-registered,
// paper-phase teaching-toy values.
//
// Vols are decimals (0.30 == 30%). skewVolTol is a vol-point tolerance;
// ivToRv* are dimensionless IV/RV ratios.
const (
	// skewVolTol: SkewDiff at or above -skewVolTol counts as flat-or-favorable
	// (you sell at least as rich a vol as you buy). Below it the skew is steep
	// — you sell cheaper vol than you buy, so the vertical is structurally
	// expensive.
	skewVolTol = 0.01 // 1 vol point
	// ivToRvCheapMax: long-leg IV at or under this multiple of realized vol is
	// "not overpaying" for the net-long vega.
	ivToRvCheapMax = 1.10
	// ivToRvRichMin: long-leg IV at or above this multiple of realized vol is
	// "clearly overpaying" — rich regardless of a favorable skew.
	ivToRvRichMin = 1.30
)

// VerticalCheapness is a teaching read on whether a debit vertical is
// structurally cheap, fair, or rich at entry, judged from two no-history
// signals: the vertical's vol skew (sell-leg IV vs buy-leg IV) and, when a
// realized-vol estimate is supplied, the long leg's IV-to-RV ratio. With no
// historical IV surface this is an ABSOLUTE-threshold read, not a
// regime-relative one — a documented limitation, honest for the paper phase.
type VerticalCheapness struct {
	SkewDiff  float64 // shortLegIV - longLegIV (vol sold minus vol bought)
	HasIVtoRV bool    // true only when realizedVol > 0 AND longIV > 0
	IVtoRV    float64 // longIV / realizedVol; meaningful only when HasIVtoRV
	Label     string  // verdict + reason; filled by the label logic
}

// assessVerticalCheapness scores a debit vertical's entry cheapness. Pure: no
// I/O, no clock. longIV/shortIV are the per-leg implied vols (decimals);
// realizedVol is an optional realized-vol estimate (<=0 means "unknown", and
// the read falls back to skew only). dir is reflected in the teaching label.
func assessVerticalCheapness(dir VerticalDirection, longIV, shortIV, realizedVol float64) VerticalCheapness {
	c := VerticalCheapness{SkewDiff: shortIV - longIV}
	c.HasIVtoRV = realizedVol > 0 && longIV > 0
	if c.HasIVtoRV {
		c.IVtoRV = longIV / realizedVol
	}

	favorable := c.SkewDiff >= -skewVolTol
	overpaying := c.HasIVtoRV && c.IVtoRV >= ivToRvRichMin
	cheapVol := c.HasIVtoRV && c.IVtoRV <= ivToRvCheapMax

	switch {
	case !favorable:
		c.Label = fmt.Sprintf("rich: %s, steep skew", dir)
	case overpaying:
		c.Label = fmt.Sprintf("rich: %s, IV>>RV", dir)
	case !c.HasIVtoRV:
		c.Label = fmt.Sprintf("cheap: %s, favorable skew (no RV)", dir)
	case cheapVol:
		c.Label = fmt.Sprintf("cheap: %s, favorable skew, IV<=RV", dir)
	default:
		c.Label = fmt.Sprintf("fair: %s, favorable skew, IV~RV", dir)
	}
	return c
}
