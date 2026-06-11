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
