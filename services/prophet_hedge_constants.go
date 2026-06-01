package services

// Defensive-Prophet hedge tuning constants. Paper-phase values; the live-money
// values are pre-registered in the spec (arm <35, sizing 0.5%/max-2) and are NOT
// set here. See docs/superpowers/specs/2026-06-01-defensive-prophet-design.md.
const (
	hedgeStrategyTag    = "prophet-defensive"
	hedgeArmThreshold   = 50   // arm when regime Score < this (paper); live = 35
	hedgeMaxConcurrent  = 3    // max concurrent live spreads
	hedgeDebitCapPct    = 0.01 // ≤1% portfolio net debit per spread
	hedgeLongPctOTM     = 0.05 // long put ~5% OTM
	hedgeShortPctOTM    = 0.15 // short put ~15% OTM
	hedgeDTEMin         = 45
	hedgeDTEMax         = 60
	hedgeHarvestFrac    = 0.60 // close at ≥60% of max payoff
	hedgeRollDTE        = 21   // roll (armed) / expire (disarmed) threshold
	hedgeITMShortDTE    = 7    // assignment-defense window
	hedgeWindowStartMin = 17 * 60
	hedgeWindowEndMin   = 17*60 + 10
)
