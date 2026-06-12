package services

import "time"

// Prophet debit-vertical tuning constants. Compile-time knobs (the hedge-engine
// pattern — not env vars). Pre-registered in the feature spec §10; paper-phase
// teaching-toy values.
const (
	verticalStrategyTag = "v2-vertical" // distinct from "v2-options" so the
	// options stop monitor ignores vertical legs (it filters on exactly
	// "v2-options") and broker reconciliation attributes combos correctly.
	verticalContracts        = 1      // v1: always 1 contract (clean attribution)
	verticalDebitCapUSD      = 1000.0 // max net debit per vertical (= max loss cap), absolute $
	verticalLimitBufferFrac  = 0.25   // marketable-limit buffer (same as hedge opens)
	verticalForceDTE         = 2      // force-close at/under this DTE
	verticalCaptureDTE       = 3      // capture short-ITM at/under this DTE
	verticalSalvageFloorFrac = 0.20   // salvage-stop at ≤20% of debit paid
	verticalExpectedExitCost = 5.0    // $/contract round-trip estimate for the let-expire carve-out

	verticalTickInterval = 5 * time.Minute  // manage cadence while market open
	verticalIdleInterval = 30 * time.Minute // re-check cadence while closed
)

// verticalExitConfig bundles the backstop constants for selectVerticalExit.
func verticalExitConfig() VerticalExitConfig {
	return VerticalExitConfig{
		SalvageFloorFrac: verticalSalvageFloorFrac,
		ForceDTE:         verticalForceDTE,
		CaptureDTE:       verticalCaptureDTE,
		ExpectedExitCost: verticalExpectedExitCost,
	}
}
