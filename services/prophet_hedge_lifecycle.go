package services

import (
	"time"

	"prophet-trader/models"
)

// deriveArm decides whether the hedge may OPEN new spreads this beat.
// CRITICAL (D-DP1): RegimeGateService.GetStatus() returns Score=0 / Tier=UNKNOWN
// when the regime file is missing or unparseable, and IsStale past the freshness
// window. A naive Score<threshold test would arm on blind data (0 < 50). So a
// valid, fresh tier is required. UNKNOWN/stale ⇒ NOT armed (don't open on blind
// data) — but the caller must NOT force-close existing spreads on this signal.
func deriveArm(s RegimeGateStatus) (armed bool, reason string) {
	if s.Tier == "UNKNOWN" {
		return false, "regime tier UNKNOWN (missing/unparseable) — not arming"
	}
	if s.IsStale {
		return false, "regime data stale — not arming"
	}
	if s.Score >= hedgeArmThreshold {
		return false, "regime score >= arm threshold (disarmed)"
	}
	return true, ""
}

func hedgeDTE(sp *models.DBProphetHedgeSpread, now time.Time) int {
	return int(sp.Expiration.Sub(now).Hours() / 24)
}

// shouldHarvest: close to bank the spike when the spread's current market value
// reaches hedgeHarvestFrac of its max payoff (D-DP5).
func shouldHarvest(sp *models.DBProphetHedgeSpread, currentValue float64) bool {
	if sp.MaxPayoff <= 0 {
		return false
	}
	return currentValue >= hedgeHarvestFrac*sp.MaxPayoff
}

// shouldRoll: at/under the roll DTE floor AND still armed → close + reopen.
func shouldRoll(sp *models.DBProphetHedgeSpread, now time.Time, armed bool) bool {
	return armed && hedgeDTE(sp, now) <= hedgeRollDTE
}

// shouldExpire: at/under the roll DTE floor AND disarmed → let it expire / close.
func shouldExpire(sp *models.DBProphetHedgeSpread, now time.Time, armed bool) bool {
	return !armed && hedgeDTE(sp, now) <= hedgeRollDTE
}

// shouldCloseITMShort: assignment defense (D-DP T2.4). The short put is the
// lower/more-OTM strike, so the harvest rule preempts most cases; this covers
// the residual (overnight gap, slow disarmed grind to expiry). Close if near
// expiry AND spot is at/below the short strike (short leg ITM, early-assignment
// risk on American-style QQQ options).
func shouldCloseITMShort(sp *models.DBProphetHedgeSpread, now time.Time, spot float64) bool {
	return hedgeDTE(sp, now) <= hedgeITMShortDTE && spot <= sp.ShortPutStrike
}
