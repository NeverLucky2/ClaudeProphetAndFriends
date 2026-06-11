# Prophet Debit Verticals — Phase 1 (Pure Core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure, I/O-free decision and math core for Prophet's debit verticals — strike selection, economics, exit/backstop rules, a Black-Scholes pricer, and the direction/theta/IV P&L attribution walk — fully test-driven.

**Architecture:** A set of pure Go functions in `package services`, mirroring the existing `prophet_hedge_structure.go` / `prophet_hedge_lifecycle.go` style (pure functions + an executor that does I/O — the executor is Phase 2). No DB, no broker, no network in this phase. Reuses the existing `marketableLimitCapped` helper and `interfaces.OptionContract`.

**Tech Stack:** Go, `math` (incl. `math.Erfc` for the normal CDF), standard `testing`.

---

## Scope & phasing

The full feature (spec: `docs/superpowers/specs/2026-06-11-prophet-debit-verticals-design.md`) decomposes into four phases, each producing working, testable software and getting its own plan:

- **Phase 1 (this plan):** pure core — types, strike-snapper, economics, exit rules, BS pricer, attribution. No I/O.
- **Phase 2:** persistence + executor — `models.DBProphetVertical` + migration, `ProphetVerticalLedger`, `ProphetVerticalExecutor` (mleg place + two-phase fail-closed close + manage tick + reconcile), config flag `ENABLE_PROPHET_DEBIT_VERTICALS`.
- **Phase 3:** API + MCP tools — `OrderController` endpoints + the proposal record/TTL, and the four MCP tools (`propose_/place_/list_/close_debit_vertical`).
- **Phase 4:** single-leg attribution + sleeve tally — single-leg entry-IV snapshot at open + close hook, structure-agnostic attribution reuse, the comparison tally.

Phase 1 is self-contained: every function here is pure and unit-tested, with zero dependencies on Phases 2-4.

## File structure (Phase 1)

- Create `services/prophet_vertical_structure.go` — `VerticalDirection`, `VerticalStructure`, `verticalEconomics`, `nearestContract`, `pickVerticalStrikes`, `verticalDebitLimit`.
- Create `services/prophet_vertical_structure_test.go` — tests for the above + a shared `almostEqual` test helper.
- Create `services/prophet_vertical_lifecycle.go` — `verticalDTE`, `shouldTakeProfit`, `shouldSalvageStop`, `shouldForceCloseBeforeExpiry`, `shortLegITM`, `bothLegsOTM`, plus `VerticalExitConfig`, `VerticalState`, `selectVerticalExit`.
- Create `services/prophet_vertical_lifecycle_test.go` — tests for the predicates + the precedence resolver.
- Create `services/prophet_vertical_attribution.go` — `normCDF`, `bsPrice`, `verticalLegType`, `VerticalSnapshot`, `verticalValuePerShare`, `VerticalAttribution`, `attributeVerticalPnl`.
- Create `services/prophet_vertical_attribution_test.go` — BS known-value tests + the attribution isolation/reconciliation tests.

All in `package services`. The existing `marketableLimitCapped` (in `prophet_hedge_structure.go`) is reused, not duplicated.

---

### Task 1: Vertical types & economics

**Files:**
- Create: `services/prophet_vertical_structure.go`
- Test: `services/prophet_vertical_structure_test.go`

- [ ] **Step 1: Write the failing test**

```go
package services

import (
	"math"
	"testing"
)

// almostEqual is the shared float comparison helper for the vertical tests.
func almostEqual(a, b, eps float64) bool { return math.Abs(a-b) <= eps }

func TestVerticalEconomics_CallDebit(t *testing.T) {
	// Long $240 call / short $260 call, $7 net debit. Width 20.
	maxLoss, maxGain, breakeven := verticalEconomics(CallDebit, 240, 260, 7)
	if !almostEqual(maxLoss, 700, 1e-9) {
		t.Fatalf("maxLoss = %v, want 700", maxLoss)
	}
	if !almostEqual(maxGain, 1300, 1e-9) { // (20 - 7) * 100
		t.Fatalf("maxGain = %v, want 1300", maxGain)
	}
	if !almostEqual(breakeven, 247, 1e-9) { // longStrike + debit
		t.Fatalf("breakeven = %v, want 247", breakeven)
	}
}

func TestVerticalEconomics_PutDebit(t *testing.T) {
	// Long $230 put / short $220 put, $3 net debit. Width 10.
	maxLoss, maxGain, breakeven := verticalEconomics(PutDebit, 230, 220, 3)
	if !almostEqual(maxLoss, 300, 1e-9) {
		t.Fatalf("maxLoss = %v, want 300", maxLoss)
	}
	if !almostEqual(maxGain, 700, 1e-9) { // (10 - 3) * 100
		t.Fatalf("maxGain = %v, want 700", maxGain)
	}
	if !almostEqual(breakeven, 227, 1e-9) { // longStrike - debit
		t.Fatalf("breakeven = %v, want 227", breakeven)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/ -run TestVerticalEconomics -v`
Expected: FAIL — compile error, `verticalEconomics`/`CallDebit`/`PutDebit` undefined.

- [ ] **Step 3: Write minimal implementation**

```go
package services

import "math"

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./services/ -run TestVerticalEconomics -v`
Expected: PASS (both subtests).

- [ ] **Step 5: Commit**

```bash
git add services/prophet_vertical_structure.go services/prophet_vertical_structure_test.go
git commit -m "feat(prophet-vertical): vertical direction types + economics (pure)"
```

---

### Task 2: Strike-snapper

**Files:**
- Modify: `services/prophet_vertical_structure.go`
- Test: `services/prophet_vertical_structure_test.go`

- [ ] **Step 1: Write the failing test**

```go
func chainFixture() map[string]*interfaces.OptionContract {
	// Strikes 220..260 step 5, both calls and puts.
	m := map[string]*interfaces.OptionContract{}
	for k := 220.0; k <= 260; k += 5 {
		for _, typ := range []string{"call", "put"} {
			sym := typ + "-" + // simple unique key for the test
				strconvFloat(k)
			m[sym] = &interfaces.OptionContract{Symbol: sym, ContractType: typ, StrikePrice: k}
		}
	}
	return m
}

// strconvFloat keeps the fixture key unique without pulling fmt into asserts.
func strconvFloat(f float64) string { return strconv.FormatFloat(f, 'f', 0, 64) }

func TestPickVerticalStrikes_CallDebit_SnapsAndOrders(t *testing.T) {
	chain := chainFixture()
	long, short, ok := pickVerticalStrikes(chain, CallDebit, 241, 18) // target long ~240, width ~18 -> short ~258
	if !ok {
		t.Fatal("expected ok=true")
	}
	if long.StrikePrice != 240 { // nearest call to 241
		t.Fatalf("long strike = %v, want 240", long.StrikePrice)
	}
	if short.StrikePrice != 260 { // nearest call to 258
		t.Fatalf("short strike = %v, want 260", short.StrikePrice)
	}
	if short.StrikePrice <= long.StrikePrice {
		t.Fatal("call-debit short must be strictly above long")
	}
}

func TestPickVerticalStrikes_PutDebit_SnapsBelow(t *testing.T) {
	chain := chainFixture()
	long, short, ok := pickVerticalStrikes(chain, PutDebit, 231, 12) // long ~230, short ~218 -> snaps to 220
	if !ok {
		t.Fatal("expected ok=true")
	}
	if long.StrikePrice != 230 {
		t.Fatalf("long strike = %v, want 230", long.StrikePrice)
	}
	if short.StrikePrice != 220 {
		t.Fatalf("short strike = %v, want 220", short.StrikePrice)
	}
}

func TestPickVerticalStrikes_Degenerate_NotOK(t *testing.T) {
	// Chain with a single call strike: long and short snap to the same contract.
	chain := map[string]*interfaces.OptionContract{
		"c1": {Symbol: "c1", ContractType: "call", StrikePrice: 240},
	}
	if _, _, ok := pickVerticalStrikes(chain, CallDebit, 240, 20); ok {
		t.Fatal("expected ok=false for a degenerate single-strike chain")
	}
	if _, _, ok := pickVerticalStrikes(chainFixture(), CallDebit, 240, 0); ok {
		t.Fatal("expected ok=false for non-positive width")
	}
}
```

Add imports to the test file: `"strconv"` and `"prophet-trader/interfaces"`.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/ -run TestPickVerticalStrikes -v`
Expected: FAIL — `pickVerticalStrikes` undefined.

- [ ] **Step 3: Write minimal implementation**

Append to `services/prophet_vertical_structure.go` (and add `"prophet-trader/interfaces"` to its imports):

```go
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./services/ -run TestPickVerticalStrikes -v`
Expected: PASS (all three subtests).

- [ ] **Step 5: Commit**

```bash
git add services/prophet_vertical_structure.go services/prophet_vertical_structure_test.go
git commit -m "feat(prophet-vertical): strike-snapper for call/put debit verticals (pure)"
```

---

### Task 3: Debit-limit pricer (reuse hedge helper)

**Files:**
- Modify: `services/prophet_vertical_structure.go`
- Test: `services/prophet_vertical_structure_test.go`

- [ ] **Step 1: Write the failing test**

```go
func TestVerticalDebitLimit_CrossesAndCaps(t *testing.T) {
	// long mid 10, short mid 4 -> net mid 6. Each leg BA width 0.40, buffer 0.25
	// -> 6 + 0.25*(0.8) = 6.20. Width 20 ceiling is far above, so no clamp.
	lim := verticalDebitLimit(10, 4, 0.40, 0.40, 20, 0.25)
	if !almostEqual(lim, 6.20, 1e-9) {
		t.Fatalf("limit = %v, want 6.20", lim)
	}
	// Tight $1 width: same marketable calc (6.20) exceeds the $1 intrinsic
	// ceiling, so it clamps to 1.0.
	capped := verticalDebitLimit(10, 4, 0.40, 0.40, 1, 0.25)
	if !almostEqual(capped, 1.0, 1e-9) {
		t.Fatalf("capped limit = %v, want 1.0", capped)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/ -run TestVerticalDebitLimit -v`
Expected: FAIL — `verticalDebitLimit` undefined.

- [ ] **Step 3: Write minimal implementation**

Append to `services/prophet_vertical_structure.go`:

```go
// verticalDebitLimit prices a marketable net-debit limit for a debit vertical,
// reusing the hedge pricer (marketableLimitCapped). longMid/shortMid are
// per-share mids; longBA/shortBA the per-leg bid/ask widths; width the absolute
// strike distance (the intrinsic ceiling — the spread can't be worth more).
func verticalDebitLimit(longMid, shortMid, longBA, shortBA, width, bufferFrac float64) float64 {
	return marketableLimitCapped(longMid, shortMid, longBA, shortBA, bufferFrac, math.Abs(width))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./services/ -run TestVerticalDebitLimit -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/prophet_vertical_structure.go services/prophet_vertical_structure_test.go
git commit -m "feat(prophet-vertical): net-debit limit pricer reusing marketableLimitCapped"
```

---

### Task 4: Lifecycle predicates

**Files:**
- Create: `services/prophet_vertical_lifecycle.go`
- Test: `services/prophet_vertical_lifecycle_test.go`

- [ ] **Step 1: Write the failing test**

```go
package services

import (
	"testing"
	"time"
)

func TestVerticalDTE(t *testing.T) {
	now := time.Date(2026, 6, 11, 12, 0, 0, 0, time.UTC)
	exp := now.Add(5 * 24 * time.Hour)
	if got := verticalDTE(exp, now); got != 5 {
		t.Fatalf("dte = %d, want 5", got)
	}
}

func TestShouldTakeProfit(t *testing.T) {
	if !shouldTakeProfit(750, 1000, 0.75) {
		t.Fatal("750 >= 75% of 1000 -> take profit")
	}
	if shouldTakeProfit(700, 1000, 0.75) {
		t.Fatal("700 < 75% of 1000 -> no")
	}
	if shouldTakeProfit(900, 0, 0.75) {
		t.Fatal("zero max gain -> no")
	}
}

func TestShouldSalvageStop(t *testing.T) {
	if !shouldSalvageStop(100, 700, 0.20) { // 100 <= 20% of 700 (=140)
		t.Fatal("residual at/under floor -> salvage")
	}
	if shouldSalvageStop(200, 700, 0.20) {
		t.Fatal("200 > 140 floor -> no")
	}
}

func TestShouldForceCloseBeforeExpiry(t *testing.T) {
	if !shouldForceCloseBeforeExpiry(2, 2) {
		t.Fatal("dte 2 <= forceDTE 2 -> force")
	}
	if shouldForceCloseBeforeExpiry(3, 2) {
		t.Fatal("dte 3 > 2 -> no")
	}
}

func TestShortLegITM(t *testing.T) {
	if !shortLegITM(CallDebit, 261, 260) {
		t.Fatal("call-debit short ITM when spot above short strike")
	}
	if shortLegITM(CallDebit, 259, 260) {
		t.Fatal("call-debit short OTM when spot below short strike")
	}
	if !shortLegITM(PutDebit, 219, 220) {
		t.Fatal("put-debit short ITM when spot below short strike")
	}
}

func TestBothLegsOTM(t *testing.T) {
	// call-debit long 240 / short 260: both OTM when spot < 240 (long strike).
	if !bothLegsOTM(CallDebit, 239, 240, 260) {
		t.Fatal("call-debit both OTM below long strike")
	}
	if bothLegsOTM(CallDebit, 245, 240, 260) {
		t.Fatal("spot between strikes -> long ITM, not both-OTM")
	}
	// put-debit long 230 / short 220: both OTM when spot > 230 (long strike).
	if !bothLegsOTM(PutDebit, 231, 230, 220) {
		t.Fatal("put-debit both OTM above long strike")
	}
	if bothLegsOTM(PutDebit, 225, 230, 220) {
		t.Fatal("spot between strikes -> long put ITM, not both-OTM")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/ -run 'TestVerticalDTE|TestShould|TestShortLegITM|TestBothLegsOTM' -v`
Expected: FAIL — predicates undefined.

- [ ] **Step 3: Write minimal implementation**

```go
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./services/ -run 'TestVerticalDTE|TestShould|TestShortLegITM|TestBothLegsOTM' -v`
Expected: PASS (all subtests).

- [ ] **Step 5: Commit**

```bash
git add services/prophet_vertical_lifecycle.go services/prophet_vertical_lifecycle_test.go
git commit -m "feat(prophet-vertical): pure lifecycle predicates (dte/salvage/force/itm/otm)"
```

---

### Task 5: Exit precedence resolver

**Files:**
- Modify: `services/prophet_vertical_lifecycle.go`
- Test: `services/prophet_vertical_lifecycle_test.go`

- [ ] **Step 1: Write the failing test**

```go
func baseExitCfg() VerticalExitConfig {
	return VerticalExitConfig{SalvageFloorFrac: 0.20, ForceDTE: 2, CaptureDTE: 3, ExpectedExitCost: 5}
}

func baseCallState() VerticalState {
	return VerticalState{
		Direction: CallDebit, Spot: 250, LongStrike: 240, ShortStrike: 260,
		CurrentValueTotal: 800, MaxGainTotal: 1300, TotalDebit: 700, DTE: 20,
	}
}

func TestSelectVerticalExit_HoldsWhenNoTrigger(t *testing.T) {
	if reason, act := selectVerticalExit(baseCallState(), baseExitCfg()); act || reason != "" {
		t.Fatalf("expected hold, got (%q,%v)", reason, act)
	}
}

func TestSelectVerticalExit_SalvageWinsOverForceClose(t *testing.T) {
	s := baseCallState()
	s.CurrentValueTotal = 100 // <= 20% of 700 (=140) -> salvage
	s.DTE = 1                 // also <= forceDTE; salvage must take precedence
	if reason, act := selectVerticalExit(s, baseExitCfg()); !act || reason != "salvage_stop" {
		t.Fatalf("expected salvage_stop, got (%q,%v)", reason, act)
	}
}

func TestSelectVerticalExit_ProfitCaptureOnShortITMNearExpiry(t *testing.T) {
	s := baseCallState()
	s.Spot = 261 // short (260) ITM
	s.DTE = 3    // <= captureDTE
	if reason, act := selectVerticalExit(s, baseExitCfg()); !act || reason != "profit_capture" {
		t.Fatalf("expected profit_capture, got (%q,%v)", reason, act)
	}
}

func TestSelectVerticalExit_ForceCloseCatchAll(t *testing.T) {
	s := baseCallState()
	s.Spot = 250 // between strikes: not both-OTM, short not ITM
	s.DTE = 2
	if reason, act := selectVerticalExit(s, baseExitCfg()); !act || reason != "force_close" {
		t.Fatalf("expected force_close, got (%q,%v)", reason, act)
	}
}

func TestSelectVerticalExit_WorthlessCarveOut_LetsExpire(t *testing.T) {
	s := baseCallState()
	s.Spot = 235          // below long (240): BOTH legs OTM
	s.CurrentValueTotal = 4 // <= ExpectedExitCost (5)
	s.DTE = 2             // would otherwise force-close
	if reason, act := selectVerticalExit(s, baseExitCfg()); act || reason != "let_expire" {
		t.Fatalf("expected let_expire/hold, got (%q,%v)", reason, act)
	}
}

func TestSelectVerticalExit_NotWorthlessEnough_ForceCloses(t *testing.T) {
	s := baseCallState()
	s.Spot = 235          // both OTM...
	s.CurrentValueTotal = 9 // ...but residual 9 > ExpectedExitCost 5 -> still force
	s.DTE = 2
	if reason, act := selectVerticalExit(s, baseExitCfg()); !act || reason != "force_close" {
		t.Fatalf("expected force_close, got (%q,%v)", reason, act)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/ -run TestSelectVerticalExit -v`
Expected: FAIL — `VerticalExitConfig`/`VerticalState`/`selectVerticalExit` undefined.

- [ ] **Step 3: Write minimal implementation**

Append to `services/prophet_vertical_lifecycle.go`:

```go
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
// auto-exercise into shares at expiry.
func selectVerticalExit(s VerticalState, cfg VerticalExitConfig) (reason string, act bool) {
	if shouldSalvageStop(s.CurrentValueTotal, s.TotalDebit, cfg.SalvageFloorFrac) {
		return "salvage_stop", true
	}
	if s.DTE <= cfg.CaptureDTE && shortLegITM(s.Direction, s.Spot, s.ShortStrike) {
		return "profit_capture", true
	}
	if shouldForceCloseBeforeExpiry(s.DTE, cfg.ForceDTE) {
		if bothLegsOTM(s.Direction, s.Spot, s.LongStrike, s.ShortStrike) && s.CurrentValueTotal <= cfg.ExpectedExitCost {
			return "let_expire", false
		}
		return "force_close", true
	}
	return "", false
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./services/ -run TestSelectVerticalExit -v`
Expected: PASS (all subtests).

- [ ] **Step 5: Commit**

```bash
git add services/prophet_vertical_lifecycle.go services/prophet_vertical_lifecycle_test.go
git commit -m "feat(prophet-vertical): deterministic exit resolver w/ precedence + worthless carve-out"
```

---

### Task 6: Black-Scholes pricer

**Files:**
- Create: `services/prophet_vertical_attribution.go`
- Test: `services/prophet_vertical_attribution_test.go`

- [ ] **Step 1: Write the failing test**

```go
package services

import "testing"

func TestBsPrice_ATMCallKnownValue(t *testing.T) {
	// spot=strike=100, t=1y, vol=20%, r=0 -> ~7.9656.
	got := bsPrice("call", 100, 100, 1, 0.20, 0)
	if !almostEqual(got, 7.9656, 1e-3) {
		t.Fatalf("ATM call = %v, want ~7.9656", got)
	}
}

func TestBsPrice_PutCallParityATM(t *testing.T) {
	// r=0, spot=strike -> call price == put price.
	c := bsPrice("call", 100, 100, 1, 0.20, 0)
	p := bsPrice("put", 100, 100, 1, 0.20, 0)
	if !almostEqual(c, p, 1e-9) {
		t.Fatalf("ATM call %v != put %v at r=0", c, p)
	}
}

func TestBsPrice_DegenerateReturnsIntrinsic(t *testing.T) {
	if got := bsPrice("call", 110, 100, 0, 0.20, 0); !almostEqual(got, 10, 1e-9) {
		t.Fatalf("expired ITM call intrinsic = %v, want 10", got)
	}
	if got := bsPrice("put", 90, 100, -1, 0.20, 0); !almostEqual(got, 10, 1e-9) {
		t.Fatalf("expired ITM put intrinsic = %v, want 10", got)
	}
	if got := bsPrice("call", 90, 100, 1, 0, 0); !almostEqual(got, 0, 1e-9) {
		t.Fatalf("zero-vol OTM call = %v, want 0", got)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/ -run TestBsPrice -v`
Expected: FAIL — `bsPrice` undefined.

- [ ] **Step 3: Write minimal implementation**

```go
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./services/ -run TestBsPrice -v`
Expected: PASS (all subtests).

- [ ] **Step 5: Commit**

```bash
git add services/prophet_vertical_attribution.go services/prophet_vertical_attribution_test.go
git commit -m "feat(prophet-vertical): Black-Scholes pricer (instructional, r=0)"
```

---

### Task 7: Vertical value + P&L attribution walk

**Files:**
- Modify: `services/prophet_vertical_attribution.go`
- Test: `services/prophet_vertical_attribution_test.go`

- [ ] **Step 1: Write the failing test**

```go
func TestVerticalValuePerShare_CallDebitPositive(t *testing.T) {
	// Long 240 / short 260 calls, spot 250, 30d (~0.082y), 30% vol.
	snap := VerticalSnapshot{Spot: 250, LongVol: 0.30, ShortVol: 0.30, TimeToExpiry: 30.0 / 365}
	v := verticalValuePerShare(CallDebit, 240, 260, snap)
	if v <= 0 {
		t.Fatalf("call-debit spread value should be positive, got %v", v)
	}
	if v >= 20 { // can never exceed the width
		t.Fatalf("spread value %v must be below width 20", v)
	}
}

func TestAttribute_PureIVCrush_BooksToIV(t *testing.T) {
	// Identical spot AND time at entry/exit; only IV drops. Direction and theta
	// must be ~0; all modeled P&L lands in IV. This is the headline lesson.
	long, short := 240.0, 260.0
	entry := VerticalSnapshot{Spot: 250, LongVol: 0.50, ShortVol: 0.50, TimeToExpiry: 30.0 / 365}
	exit := VerticalSnapshot{Spot: 250, LongVol: 0.25, ShortVol: 0.25, TimeToExpiry: 30.0 / 365}

	// Realized = modeled total here (residual should be ~0); compute modeled
	// total independently from the per-share values to avoid trusting the walk.
	v0 := verticalValuePerShare(CallDebit, long, short, entry)
	v1 := verticalValuePerShare(CallDebit, long, short, exit)
	realized := (v1 - v0) * 100 // 1 contract

	a := attributeVerticalPnl(CallDebit, long, short, entry, exit, realized, 1)
	if !almostEqual(a.Theta, 0, 1e-6) {
		t.Fatalf("theta should be ~0 (time unchanged), got %v", a.Theta)
	}
	if !almostEqual(a.Direction, 0, 1e-6) {
		t.Fatalf("direction should be ~0 (spot unchanged), got %v", a.Direction)
	}
	if almostEqual(a.IV, 0, 1e-6) {
		t.Fatalf("IV component should be non-zero (vol moved), got %v", a.IV)
	}
	if !almostEqual(a.Residual, 0, 1e-6) {
		t.Fatalf("residual should reconcile to ~0, got %v", a.Residual)
	}
}

func TestAttribute_PureDirection_BooksToDirection(t *testing.T) {
	long, short := 240.0, 260.0
	entry := VerticalSnapshot{Spot: 250, LongVol: 0.30, ShortVol: 0.30, TimeToExpiry: 30.0 / 365}
	exit := VerticalSnapshot{Spot: 256, LongVol: 0.30, ShortVol: 0.30, TimeToExpiry: 30.0 / 365}
	v0 := verticalValuePerShare(CallDebit, long, short, entry)
	v1 := verticalValuePerShare(CallDebit, long, short, exit)
	realized := (v1 - v0) * 100
	a := attributeVerticalPnl(CallDebit, long, short, entry, exit, realized, 1)
	if !almostEqual(a.Theta, 0, 1e-6) || !almostEqual(a.IV, 0, 1e-6) {
		t.Fatalf("theta/IV should be ~0, got theta=%v iv=%v", a.Theta, a.IV)
	}
	if a.Direction <= 0 {
		t.Fatalf("upward spot move on a call-debit should book positive direction, got %v", a.Direction)
	}
}

func TestAttribute_ResidualReconciles(t *testing.T) {
	long, short := 240.0, 260.0
	entry := VerticalSnapshot{Spot: 250, LongVol: 0.40, ShortVol: 0.40, TimeToExpiry: 30.0 / 365}
	exit := VerticalSnapshot{Spot: 244, LongVol: 0.55, ShortVol: 0.55, TimeToExpiry: 10.0 / 365}
	a := attributeVerticalPnl(CallDebit, long, short, entry, exit, -123.45, 1)
	sum := a.Direction + a.Theta + a.IV + a.Residual
	if !almostEqual(sum, -123.45, 1e-6) {
		t.Fatalf("components must sum to realized -123.45, got %v", sum)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/ -run 'TestVerticalValuePerShare|TestAttribute' -v`
Expected: FAIL — `verticalValuePerShare`/`VerticalSnapshot`/`attributeVerticalPnl` undefined.

- [ ] **Step 3: Write minimal implementation**

Append to `services/prophet_vertical_attribution.go`:

```go
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./services/ -run 'TestVerticalValuePerShare|TestAttribute' -v`
Expected: PASS (all subtests).

- [ ] **Step 5: Run the full services package + vet + build**

Run: `go test ./services/ -run 'Vertical|Attribute|BsPrice|Should|SelectVerticalExit|PickVertical' -v && go vet ./services/ && go build ./...`
Expected: all PASS / clean. (Working tree is CRLF; if `gofmt -l` flags files, verify with `git stash` of unrelated changes or `tr -d '\r' | gofmt -d` per the repo's `.gitattributes text=auto` normalization.)

- [ ] **Step 6: Commit**

```bash
git add services/prophet_vertical_attribution.go services/prophet_vertical_attribution_test.go
git commit -m "feat(prophet-vertical): per-share value + direction/theta/IV attribution walk"
```

---

## Self-Review

**1. Spec coverage (Phase 1 scope):**
- Strike-snapper (call & put, `ok=false`, width) → Task 2. ✓
- Net-debit limit reuse of `marketableLimitCapped` → Task 3. ✓
- Economics (max loss/gain/breakeven) → Task 1. ✓
- Lifecycle rules + precedence + worthless carve-out (both-legs-OTM) → Tasks 4-5. ✓
- BS pricer + attribution walk + order-dependence + reconciliation, incl. the headline pure-IV-crush test → Tasks 6-7. ✓
- Deferred to later phases (correctly out of Phase 1 scope): DB model/migration, ledger, executor + fail-closed close, config flag, MCP tools + proposal record/TTL, single-leg attribution + tally, guard wiring. These are Phases 2-4.

**2. Placeholder scan:** none — every step has complete code and exact run commands.

**3. Type consistency:** `VerticalDirection`/`CallDebit`/`PutDebit` (Task 1) are used consistently in Tasks 2,4,5,7. `VerticalSnapshot` fields (`Spot`,`LongVol`,`ShortVol`,`TimeToExpiry`) match between `verticalValuePerShare` and `attributeVerticalPnl`. `VerticalState`/`VerticalExitConfig` field names match between definition (Task 5) and tests. `almostEqual` is defined once in `prophet_vertical_structure_test.go` and reused across the package's test files (Go compiles all `_test.go` in a package together).

---

## Roadmap (subsequent plans)

- **Phase 2 — persistence & executor:** `models.DBProphetVertical` (mirror `DBProphetHedgeSpread`: legs, strikes, debit, max loss/gain, breakeven, entry snapshot fields, status `pending_fill|open|closing|closed|failed`, attribution fields) + gorm migration; `ProphetVerticalLedger` (mirror `ProphetHedgeLedger`); `ProphetVerticalExecutor` mirroring `ProphetHedgeExecutor` — **two-phase fail-closed close** (`closeVertical`→`closing`→`reconcileClosing`→`closed`; canceled/rejected reverts to `open`), `RunManageTick` running reconcile + `selectVerticalExit`, per-leg `CheckOptionsOpen`; config flag `ENABLE_PROPHET_DEBIT_VERTICALS`; exclude vertical legs from `prophet_options_stop_monitor` by strategy tag. Settle the `mleg.LimitPrice` sign convention here.
- **Phase 3 — API & MCP tools:** `OrderController` endpoints + a short-lived **proposal record** (ID + TTL + exact OCC legs + quoted debit + entry snapshot); `place` re-prices the stored legs and rejects on TTL/drift (the identity contract); four MCP tools `propose_/place_/list_/close_debit_vertical`.
- **Phase 4 — single-leg attribution & tally:** persist a single-leg entry-IV snapshot at open + a close-attribution hook; generalize the attribution walk to a single leg (reuse `bsPrice`); the sleeve tally comparing single-leg vs vertical; the pre-registered negative-expectancy expectation note.
