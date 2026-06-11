package services

import "time"

// verticalDTE returns whole calendar days from now to expiration.
func verticalDTE(expiration, now time.Time) int {
	return int(expiration.Sub(now).Hours() / 24)
}

// shouldTakeProfit reports whether the spread's current total value has reached
// profitFrac of its total max gain. Display helper (the LLM owns take-profit);
// not part of the deterministic resolver.
func shouldTakeProfit(currentValueTotal, maxGainTotal, profitFrac float64) bool {
	if maxGainTotal <= 0 {
		return false
	}
	return currentValueTotal >= profitFrac*maxGainTotal
}

// shouldSalvageStop reports whether the spread has decayed to ≤ salvageFloorFrac
// of the debit paid — close early to salvage residual value.
func shouldSalvageStop(currentValueTotal, totalDebit, salvageFloorFrac float64) bool {
	if totalDebit <= 0 {
		return false
	}
	return currentValueTotal <= salvageFloorFrac*totalDebit
}

// shouldForceCloseBeforeExpiry reports whether DTE has reached the force-close floor.
func shouldForceCloseBeforeExpiry(dte, forceDTE int) bool {
	return dte <= forceDTE
}

// shortLegITM reports whether the short leg is in-the-money. In a debit vertical
// this means the spread is winning (the long leg is deeper ITM by construction).
func shortLegITM(dir VerticalDirection, spot, shortStrike float64) bool {
	switch dir {
	case CallDebit:
		return spot >= shortStrike
	case PutDebit:
		return spot <= shortStrike
	}
	return false
}

// bothLegsOTM reports whether the entire spread is out-of-the-money (worthless
// at expiry, no exercise/assignment). The long leg is the closer-to-money strike,
// so both-OTM ⇔ spot is on the OTM side of the long strike.
func bothLegsOTM(dir VerticalDirection, spot, longStrike, shortStrike float64) bool {
	switch dir {
	case CallDebit:
		return spot < longStrike
	case PutDebit:
		return spot > longStrike
	}
	return false
}

// VerticalExitConfig holds the deterministic backstop thresholds.
type VerticalExitConfig struct {
	SalvageFloorFrac float64 // salvage-stop at this fraction of the debit paid
	ForceDTE         int     // force-close at/under this DTE
	CaptureDTE       int     // capture short-ITM at/under this DTE
	ExpectedExitCost float64 // per-contract round-trip cost for the carve-out
}

// VerticalState is the live snapshot a manage-tick evaluates.
type VerticalState struct {
	Direction         VerticalDirection
	Spot              float64
	LongStrike        float64
	ShortStrike       float64
	CurrentValueTotal float64
	MaxGainTotal      float64
	TotalDebit        float64
	DTE               int
}

// selectVerticalExit applies the deterministic backstops in precedence order
// (salvage → profit-capture → force-close as the catch-all) and returns the
// close reason with act=true, or act=false to hold. The worthless-spread
// carve-out suppresses a force-close (returns "let_expire", act=false) when the
// ENTIRE spread is OTM and residual ≤ the expected exit cost — letting it expire
// rather than pay a bid/ask round-trip to close ~zero risk. The carve-out
// requires BOTH legs OTM (not just the short leg): a still-ITM long leg would
// auto-exercise into shares at expiry. When both legs are OTM and we're at/under
// force-close DTE, the carve-out takes precedence over salvage to avoid
// unnecessary closing costs for near-worthless spreads.
func selectVerticalExit(s VerticalState, cfg VerticalExitConfig) (reason string, act bool) {
	// Special case: at/under force-close DTE with both legs OTM, check the worthless
	// carve-out before salvage to avoid closing near-worthless spreads.
	if shouldForceCloseBeforeExpiry(s.DTE, cfg.ForceDTE) &&
		bothLegsOTM(s.Direction, s.Spot, s.LongStrike, s.ShortStrike) {
		if s.CurrentValueTotal <= cfg.ExpectedExitCost {
			return "let_expire", false
		}
		return "force_close", true
	}

	if shouldSalvageStop(s.CurrentValueTotal, s.TotalDebit, cfg.SalvageFloorFrac) {
		return "salvage_stop", true
	}
	if s.DTE <= cfg.CaptureDTE && shortLegITM(s.Direction, s.Spot, s.ShortStrike) {
		return "profit_capture", true
	}
	if shouldForceCloseBeforeExpiry(s.DTE, cfg.ForceDTE) {
		return "force_close", true
	}
	return "", false
}
