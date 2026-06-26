# Phase 4 Foundation: Single-leg P&L attribution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture an entry IV/spot/time snapshot when a Prophet `v2-options` single-leg fills, and on close decompose its mark-based realized P&L into direction/theta/IV/residual using the same reprice algorithm the verticals use — persisted on the managed-position row, advisory/teaching-only, behind a default-OFF flag.

**Architecture:** A new pure `services/prophet_singleleg_attribution.go` holds the attribution math (reusing the existing `bsPrice`) plus narrow-interface fetch helpers. `DBManagedPosition`/`ManagedPosition` gain option-only columns. Two thin, flag-and-option-gated, fail-soft hooks in `position_manager.go` (`activateFilledEntry` for entry capture, `CloseManagedPosition` for mark-based close attribution) call the helpers. No new table, no new injected dependency, no Node/dashboard change.

**Tech Stack:** Go 1.26 (module `prophet-trader`), standard library + `gorm`, `go test`.

## Global Constraints

- **Advisory/teaching-only.** The hooks must NEVER block, delay, or fail a fill or a close. Every fetch is fail-soft; degraded data → zeros / skipped attribution.
- **Flag-gated:** new `ENABLE_PROPHET_SINGLELEG_ATTRIBUTION` (default OFF), mirroring `ENABLE_PROPHET_DEBIT_VERTICALS` exactly. Flag off ⇒ both hooks are immediate no-ops.
- **Option-gated:** hooks act only on `AgentStrategy == "v2-options"` rows whose `Symbol` passes `IsOptionSymbol`. Equity rows (Turtle/Coil/etc.) short-circuit first.
- **Mark-based close:** the close is async (no exit fill at `CloseManagedPosition`); attribution runs synchronously from the close-time mid `(Bid+Ask)/2`. `realizedPnL = (exitMark − EntryPrice) × 100 × Quantity × sideSign`.
- **No new dependency:** spot via `pm.dataService.GetLatestBar(underlying).Close`; IV + mark via `pm.tradingService.GetOptionsChain(underlying, expiry)` matched by OCC `Symbol`.
- **Vertical engine untouched:** reuse only the `bsPrice` primitive; do NOT modify `prophet_vertical_attribution.go`. Keep `attributeSingleLegPnl` behavior-parallel to `attributeVerticalPnl` (same theta→direction→IV order).
- **Persist on `DBManagedPosition` columns (no sidecar).** Columns are `v2-options`-only; zero on equity rows.
- **Package `services`** for the new file; `gofmt`-clean; commits scoped `feat(prophet-vertical): ...` ending with the `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer.

---

### Task 1: Pure single-leg attribution

**Files:**
- Create: `services/prophet_singleleg_attribution.go`
- Test: `services/prophet_singleleg_attribution_test.go`

**Interfaces:**
- Consumes: unexported `bsPrice(optType string, spot, strike, t, vol, r float64) float64` from `prophet_vertical_attribution.go` (same package).
- Produces:
  - `type SingleLegSnapshot struct { Spot, Vol, TimeToExpiry float64 }`
  - `type SingleLegAttribution struct { Direction, Theta, IV, Residual float64 }`
  - `func attributeSingleLegPnl(optType string, isLong bool, strike float64, entry, exit SingleLegSnapshot, realizedPnL float64, contracts int) SingleLegAttribution`

- [ ] **Step 1: Write the failing tests**

Create `services/prophet_singleleg_attribution_test.go`:

```go
package services

import "testing"

// almostEqual is already defined in prophet_vertical_structure_test.go (same package) — do NOT redefine it.

func TestAttributeSingleLegPnl_PureIVCrush(t *testing.T) {
	// Long call; spot & time held flat, only vol drops. All modeled P&L → IV.
	entry := SingleLegSnapshot{Spot: 100, Vol: 0.40, TimeToExpiry: 0.10}
	exit := SingleLegSnapshot{Spot: 100, Vol: 0.20, TimeToExpiry: 0.10}
	// Modeled total = (bs(exit) - bs(entry)) * 100. Pass that exact value as
	// realizedPnL so Residual is ~0 and IV carries the whole move.
	modeled := (bsPrice("call", 100, 100, 0.10, 0.20, 0) - bsPrice("call", 100, 100, 0.10, 0.40, 0)) * 100
	a := attributeSingleLegPnl("call", true, 100, entry, exit, modeled, 1)
	if !almostEqual(a.Theta, 0, 1e-9) {
		t.Fatalf("theta = %v, want 0 (time flat)", a.Theta)
	}
	if !almostEqual(a.Direction, 0, 1e-9) {
		t.Fatalf("direction = %v, want 0 (spot flat)", a.Direction)
	}
	if a.IV >= 0 {
		t.Fatalf("IV = %v, want negative (vol fell on a long option)", a.IV)
	}
	if !almostEqual(a.Residual, 0, 1e-6) {
		t.Fatalf("residual = %v, want ~0", a.Residual)
	}
}

func TestAttributeSingleLegPnl_PureDirection(t *testing.T) {
	// Long call; vol & time flat, spot rises → all modeled P&L → Direction (>0).
	entry := SingleLegSnapshot{Spot: 100, Vol: 0.30, TimeToExpiry: 0.10}
	exit := SingleLegSnapshot{Spot: 110, Vol: 0.30, TimeToExpiry: 0.10}
	modeled := (bsPrice("call", 110, 100, 0.10, 0.30, 0) - bsPrice("call", 100, 100, 0.10, 0.30, 0)) * 100
	a := attributeSingleLegPnl("call", true, 100, entry, exit, modeled, 1)
	if a.Direction <= 0 {
		t.Fatalf("direction = %v, want positive", a.Direction)
	}
	if !almostEqual(a.Theta, 0, 1e-9) || !almostEqual(a.IV, 0, 1e-9) {
		t.Fatalf("theta=%v iv=%v, want both 0", a.Theta, a.IV)
	}
}

func TestAttributeSingleLegPnl_ThetaDecayLongOption(t *testing.T) {
	// Long call; spot & vol flat, time decays → Theta < 0 (long option bleeds).
	entry := SingleLegSnapshot{Spot: 100, Vol: 0.30, TimeToExpiry: 0.10}
	exit := SingleLegSnapshot{Spot: 100, Vol: 0.30, TimeToExpiry: 0.02}
	a := attributeSingleLegPnl("call", true, 100, entry, exit, 0, 1)
	if a.Theta >= 0 {
		t.Fatalf("theta = %v, want negative (time decay on a long option)", a.Theta)
	}
}

func TestAttributeSingleLegPnl_ResidualReconciles(t *testing.T) {
	// Residual makes the four components sum to the realized P&L exactly.
	entry := SingleLegSnapshot{Spot: 100, Vol: 0.35, TimeToExpiry: 0.10}
	exit := SingleLegSnapshot{Spot: 104, Vol: 0.28, TimeToExpiry: 0.05}
	const realized = 137.0
	a := attributeSingleLegPnl("call", true, 100, entry, exit, realized, 2)
	if !almostEqual(a.Direction+a.Theta+a.IV+a.Residual, realized, 1e-9) {
		t.Fatalf("components sum = %v, want %v", a.Direction+a.Theta+a.IV+a.Residual, realized)
	}
}

func TestAttributeSingleLegPnl_LongPutDirection(t *testing.T) {
	// Long put; spot falls → Direction > 0 (a long put gains as spot drops).
	entry := SingleLegSnapshot{Spot: 100, Vol: 0.30, TimeToExpiry: 0.10}
	exit := SingleLegSnapshot{Spot: 92, Vol: 0.30, TimeToExpiry: 0.10}
	modeled := (bsPrice("put", 92, 100, 0.10, 0.30, 0) - bsPrice("put", 100, 100, 0.10, 0.30, 0)) * 100
	a := attributeSingleLegPnl("put", true, 100, entry, exit, modeled, 1)
	if a.Direction <= 0 {
		t.Fatalf("direction = %v, want positive (long put, spot fell)", a.Direction)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./services/ -run TestAttributeSingleLegPnl -v`
Expected: FAIL — compile error `undefined: SingleLegSnapshot / attributeSingleLegPnl`.

- [ ] **Step 3: Write the implementation**

Create `services/prophet_singleleg_attribution.go`:

```go
package services

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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./services/ -run TestAttributeSingleLegPnl -v`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add services/prophet_singleleg_attribution.go services/prophet_singleleg_attribution_test.go
git commit -m "feat(prophet-vertical): pure single-leg P&L attribution (reuses bsPrice)

attributeSingleLegPnl decomposes a single option leg's realized P&L into
direction/theta/IV/residual via the same theta→direction→IV reprice walk as
attributeVerticalPnl, pricing one leg with bsPrice. Pure; vertical engine
untouched.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Snapshot fetch helpers

Free functions (narrow-interface, tiny-fake-testable) that fetch the spot/IV/mark/time for an OCC symbol. The `PositionManager` hooks (Task 4) call these with `pm.dataService` / `pm.tradingService`.

**Files:**
- Modify: `services/prophet_singleleg_attribution.go` (append)
- Test: `services/prophet_singleleg_attribution_test.go` (append)

**Interfaces:**
- Consumes: `IsOptionSymbol`, `ParseOCC`, `ParseOCCUnderlying`, `ParseOCCStrike` from `services/occ.go`; `interfaces.Bar`, `interfaces.OptionContract`.
- Produces:
  - `type barFetcher interface { GetLatestBar(ctx context.Context, symbol string) (*interfaces.Bar, error) }`
  - `type chainFetcher interface { GetOptionsChain(ctx context.Context, underlying string, expiration time.Time) ([]*interfaces.OptionContract, error) }`
  - `func singleLegSnapshotNow(ctx context.Context, bars barFetcher, chains chainFetcher, occSymbol string, now time.Time) (snap SingleLegSnapshot, mark float64, ok bool)` — `ok=false` if not an option or spot unavailable; `snap.Vol`/`mark` may be 0 on a degraded options feed.

- [ ] **Step 1: Write the failing tests**

Append to `services/prophet_singleleg_attribution_test.go` (add imports `context`, `time`, `prophet-trader/interfaces` to the file's import block):

```go
type fakeBarFetcher struct {
	bar *interfaces.Bar
	err error
}

func (f *fakeBarFetcher) GetLatestBar(_ context.Context, _ string) (*interfaces.Bar, error) {
	return f.bar, f.err
}

type fakeChainFetcher struct {
	chain []*interfaces.OptionContract
	err   error
}

func (f *fakeChainFetcher) GetOptionsChain(_ context.Context, _ string, _ time.Time) ([]*interfaces.OptionContract, error) {
	return f.chain, f.err
}

func TestSingleLegSnapshotNow_HappyPath(t *testing.T) {
	now := time.Date(2026, 6, 22, 15, 0, 0, 0, time.UTC)
	sym := "QQQ260918C00400000" // expiry 2026-09-18, call, strike 400
	bars := &fakeBarFetcher{bar: &interfaces.Bar{Close: 405}}
	chains := &fakeChainFetcher{chain: []*interfaces.OptionContract{
		{Symbol: sym, Bid: 12.0, Ask: 12.4, ImpliedVolatility: 0.22},
	}}
	snap, mark, ok := singleLegSnapshotNow(context.Background(), bars, chains, sym, now)
	if !ok {
		t.Fatal("ok=false, want true")
	}
	if !almostEqual(snap.Spot, 405, 1e-9) {
		t.Fatalf("spot = %v, want 405", snap.Spot)
	}
	if !almostEqual(snap.Vol, 0.22, 1e-9) {
		t.Fatalf("vol = %v, want 0.22", snap.Vol)
	}
	if !almostEqual(mark, 12.2, 1e-9) { // (12.0+12.4)/2
		t.Fatalf("mark = %v, want 12.2", mark)
	}
	if snap.TimeToExpiry <= 0 {
		t.Fatalf("tte = %v, want > 0", snap.TimeToExpiry)
	}
}

func TestSingleLegSnapshotNow_NotAnOption(t *testing.T) {
	now := time.Date(2026, 6, 22, 15, 0, 0, 0, time.UTC)
	if _, _, ok := singleLegSnapshotNow(context.Background(), &fakeBarFetcher{}, &fakeChainFetcher{}, "QQQ", now); ok {
		t.Fatal("ok=true for a bare equity ticker, want false")
	}
}

func TestSingleLegSnapshotNow_SpotUnavailable(t *testing.T) {
	now := time.Date(2026, 6, 22, 15, 0, 0, 0, time.UTC)
	sym := "QQQ260918C00400000"
	if _, _, ok := singleLegSnapshotNow(context.Background(), &fakeBarFetcher{bar: &interfaces.Bar{Close: 0}}, &fakeChainFetcher{}, sym, now); ok {
		t.Fatal("ok=true with no spot, want false")
	}
}

func TestSingleLegSnapshotNow_DegradedOptionFeed(t *testing.T) {
	// Spot present but the chain has no quotes → ok=true, but vol/mark are 0.
	now := time.Date(2026, 6, 22, 15, 0, 0, 0, time.UTC)
	sym := "QQQ260918C00400000"
	snap, mark, ok := singleLegSnapshotNow(context.Background(), &fakeBarFetcher{bar: &interfaces.Bar{Close: 405}}, &fakeChainFetcher{chain: []*interfaces.OptionContract{{Symbol: sym, Bid: 0, Ask: 0}}}, sym, now)
	if !ok {
		t.Fatal("ok=false, want true (spot present)")
	}
	if snap.Vol != 0 || mark != 0 {
		t.Fatalf("vol=%v mark=%v, want both 0 on degraded feed", snap.Vol, mark)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./services/ -run TestSingleLegSnapshotNow -v`
Expected: FAIL — compile error `undefined: singleLegSnapshotNow` (and the fake interfaces have nothing to satisfy yet).

- [ ] **Step 3: Write the implementation**

Append to `services/prophet_singleleg_attribution.go` (add imports `context`, `time`, `prophet-trader/interfaces`):

```go
// barFetcher / chainFetcher are the narrow data deps the single-leg snapshot
// needs — both satisfied by the services PositionManager already holds
// (interfaces.DataService.GetLatestBar, interfaces.TradingService.GetOptionsChain).
type barFetcher interface {
	GetLatestBar(ctx context.Context, symbol string) (*interfaces.Bar, error)
}

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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./services/ -run 'TestSingleLegSnapshotNow|TestAttributeSingleLegPnl' -v`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add services/prophet_singleleg_attribution.go services/prophet_singleleg_attribution_test.go
git commit -m "feat(prophet-vertical): single-leg snapshot fetch helpers (spot/IV/mark/TTE)

singleLegSnapshotNow fetches spot via a barFetcher and IV+mid via a chainFetcher
matched by OCC symbol, parsing expiry/type/strike from the symbol. Narrow
interfaces (satisfied by DataService/TradingService); fail-soft.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Persistence columns + mappings

Add the option-only snapshot/attribution fields to both the in-memory `ManagedPosition` and the persisted `DBManagedPosition`, and carry them through both mapping functions.

**Files:**
- Modify: `models/models.go` (the `DBManagedPosition` struct, ~`:126`)
- Modify: `services/position_manager.go` (the `ManagedPosition` struct ~`:20`; `managedPositionToDB` ~`:1672`; `dbToManagedPosition` ~`:1728`)
- Test: `services/position_manager_singleleg_attribution_test.go` (new)

**Interfaces:**
- Produces (on both structs): `EntryUnderlyingSpot, EntryIV, EntryTimeToExpiry, SingleLegRealizedPnL, AttribDirection, AttribTheta, AttribIV, AttribResidual float64`.

- [ ] **Step 1: Write the failing round-trip test**

Create `services/position_manager_singleleg_attribution_test.go`:

```go
package services

import "testing"

func TestManagedPosition_SingleLegAttribution_RoundTrip(t *testing.T) {
	// managedPositionToDB and dbToManagedPosition use only their argument (no pm
	// fields), so a zero-value PositionManager is sufficient.
	pm := &PositionManager{}
	pos := &ManagedPosition{
		ID:                  "p1",
		Symbol:              "QQQ260918C00400000",
		AgentStrategy:       "v2-options",
		EntryUnderlyingSpot: 405.0,
		EntryIV:             0.22,
		EntryTimeToExpiry:   0.24,
		SingleLegRealizedPnL: -120.0,
		AttribDirection:     50.0,
		AttribTheta:         -90.0,
		AttribIV:            -70.0,
		AttribResidual:      -10.0,
	}
	db := pm.managedPositionToDB(pos)
	if db.EntryUnderlyingSpot != 405.0 || db.EntryIV != 0.22 || db.EntryTimeToExpiry != 0.24 {
		t.Fatalf("entry snapshot not mapped to DB: %+v", db)
	}
	if db.SingleLegRealizedPnL != -120.0 || db.AttribDirection != 50.0 || db.AttribTheta != -90.0 || db.AttribIV != -70.0 || db.AttribResidual != -10.0 {
		t.Fatalf("attribution not mapped to DB: %+v", db)
	}
	back := pm.dbToManagedPosition(db)
	if back.EntryUnderlyingSpot != 405.0 || back.EntryIV != 0.22 || back.EntryTimeToExpiry != 0.24 ||
		back.SingleLegRealizedPnL != -120.0 || back.AttribDirection != 50.0 || back.AttribTheta != -90.0 ||
		back.AttribIV != -70.0 || back.AttribResidual != -10.0 {
		t.Fatalf("round-trip lost fields: %+v", back)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./services/ -run TestManagedPosition_SingleLegAttribution_RoundTrip -v`
Expected: FAIL — compile error (`ManagedPosition`/`DBManagedPosition` have no such fields).

- [ ] **Step 3: Add the fields to `DBManagedPosition`**

In `models/models.go`, inside `type DBManagedPosition struct`, after the `RemainingQty float64` line (the end of the Status block, ~`:173`), add:

```go
	// Single-leg options attribution (Phase 4 foundation). Populated only for
	// AgentStrategy=="v2-options" rows: the entry snapshot is captured at fill,
	// the attribution computed (mark-based) at close. Zero for equity positions
	// and when the feed was degraded at capture/close time.
	EntryUnderlyingSpot  float64
	EntryIV              float64
	EntryTimeToExpiry    float64 // years
	SingleLegRealizedPnL float64 `gorm:"column:single_leg_realized_pnl"`
	AttribDirection      float64
	AttribTheta          float64
	AttribIV             float64
	AttribResidual       float64
```

- [ ] **Step 4: Add the fields to `ManagedPosition`**

In `services/position_manager.go`, inside `type ManagedPosition struct`, after the `RemainingQty float64 \`json:"remaining_qty"\`` line (~`:59`), add:

```go
	// Single-leg options attribution (Phase 4 foundation; v2-options only).
	EntryUnderlyingSpot  float64 `json:"entry_underlying_spot,omitempty"`
	EntryIV              float64 `json:"entry_iv,omitempty"`
	EntryTimeToExpiry    float64 `json:"entry_time_to_expiry,omitempty"`
	SingleLegRealizedPnL float64 `json:"single_leg_realized_pnl,omitempty"`
	AttribDirection      float64 `json:"attrib_direction,omitempty"`
	AttribTheta          float64 `json:"attrib_theta,omitempty"`
	AttribIV             float64 `json:"attrib_iv,omitempty"`
	AttribResidual       float64 `json:"attrib_residual,omitempty"`
```

- [ ] **Step 5: Map the fields in both directions**

In `managedPositionToDB` (`services/position_manager.go` ~`:1672`), inside the `dbPos := &models.DBManagedPosition{ ... }` literal, after `ClosedAt: pos.ClosedAt,`, add:

```go
		EntryUnderlyingSpot:  pos.EntryUnderlyingSpot,
		EntryIV:              pos.EntryIV,
		EntryTimeToExpiry:    pos.EntryTimeToExpiry,
		SingleLegRealizedPnL: pos.SingleLegRealizedPnL,
		AttribDirection:      pos.AttribDirection,
		AttribTheta:          pos.AttribTheta,
		AttribIV:             pos.AttribIV,
		AttribResidual:       pos.AttribResidual,
```

In `dbToManagedPosition` (~`:1728`), inside the `pos := &ManagedPosition{ ... }` literal, after `RemainingQty: dbPos.RemainingQty,`, add:

```go
		EntryUnderlyingSpot:  dbPos.EntryUnderlyingSpot,
		EntryIV:              dbPos.EntryIV,
		EntryTimeToExpiry:    dbPos.EntryTimeToExpiry,
		SingleLegRealizedPnL: dbPos.SingleLegRealizedPnL,
		AttribDirection:      dbPos.AttribDirection,
		AttribTheta:          dbPos.AttribTheta,
		AttribIV:             dbPos.AttribIV,
		AttribResidual:       dbPos.AttribResidual,
```

- [ ] **Step 6: Format, run the test, verify it passes**

Run:
```bash
gofmt -w models/models.go services/position_manager.go services/position_manager_singleleg_attribution_test.go
go test ./services/ -run TestManagedPosition_SingleLegAttribution_RoundTrip -v
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add models/models.go services/position_manager.go services/position_manager_singleleg_attribution_test.go
git commit -m "feat(prophet-vertical): single-leg attribution columns on managed positions

Add entry-snapshot + attribution float columns to ManagedPosition and
DBManagedPosition (v2-options only; zero for equities) and carry them through
both mapping functions. Additive AutoMigrate; no behavior change yet.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Flag plumbing + the two gated hooks

Add the flag, the `PositionManager` gating field + setter, the main.go wiring, and the two fail-soft hook methods wired into `activateFilledEntry` and `CloseManagedPosition`.

**Files:**
- Modify: `config/config.go` (struct field ~`:51`; `Load` ~`:151`)
- Modify: `config/config_test.go` (mirror the existing vertical-flag default/true tests)
- Modify: `.env.example` (add the flag near `ENABLE_PROPHET_DEBIT_VERTICALS`)
- Modify: `services/position_manager.go` (PositionManager field + setter; `captureSingleLegEntrySnapshot` + `attributeSingleLegClose` methods; one-line call in `activateFilledEntry` ~`:700` and in `CloseManagedPosition` ~`:1253`)
- Modify: `cmd/bot/main.go` (call the setter after the PositionManager is constructed)
- Test: `services/position_manager_singleleg_attribution_test.go` (append gating tests)

**Interfaces:**
- Consumes: `singleLegSnapshotNow`, `attributeSingleLegPnl`, `SingleLegSnapshot` (Tasks 1–2); `IsOptionSymbol`, `ParseOCC`, `ParseOCCStrike`; `config.AppConfig.EnableProphetSingleLegAttribution`.
- Produces: `func (pm *PositionManager) EnableSingleLegAttribution(enabled bool)`; `captureSingleLegEntrySnapshot`, `attributeSingleLegClose` (unexported).

- [ ] **Step 1: Write the failing gating tests**

Append to `services/position_manager_singleleg_attribution_test.go` (add `"context"` and `"time"` to its imports):

```go
func TestCaptureSingleLegEntry_GatingNoOps(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 6, 22, 15, 0, 0, 0, time.UTC)

	// Flag OFF → no-op even for a v2-options option (nil services must not panic).
	off := &PositionManager{}
	posOff := &ManagedPosition{Symbol: "QQQ260918C00400000", AgentStrategy: "v2-options"}
	off.captureSingleLegEntrySnapshot(ctx, posOff, now)
	if posOff.EntryIV != 0 || posOff.EntryUnderlyingSpot != 0 {
		t.Fatal("flag off must capture nothing")
	}

	// Flag ON but equity (non-option) → no-op.
	on := &PositionManager{}
	on.EnableSingleLegAttribution(true)
	posEq := &ManagedPosition{Symbol: "QQQ", AgentStrategy: "trend"}
	on.captureSingleLegEntrySnapshot(ctx, posEq, now)
	if posEq.EntryIV != 0 {
		t.Fatal("non-option must capture nothing")
	}
}

func TestAttributeSingleLegClose_SkipsOnIncompleteEntry(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 6, 22, 15, 0, 0, 0, time.UTC)
	pm := &PositionManager{}
	pm.EnableSingleLegAttribution(true)
	// v2-options option but entry snapshot never captured (zeros) → skip, no panic
	// (must return before touching the nil services).
	pos := &ManagedPosition{Symbol: "QQQ260918C00400000", AgentStrategy: "v2-options", Side: "buy", Quantity: 1, EntryPrice: 12.0}
	pm.attributeSingleLegClose(ctx, pos, now)
	if pos.AttribDirection != 0 || pos.SingleLegRealizedPnL != 0 {
		t.Fatal("incomplete entry snapshot must skip attribution")
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./services/ -run 'TestCaptureSingleLegEntry_GatingNoOps|TestAttributeSingleLegClose_SkipsOnIncompleteEntry' -v`
Expected: FAIL — `EnableSingleLegAttribution` / `captureSingleLegEntrySnapshot` / `attributeSingleLegClose` undefined.

- [ ] **Step 3: Add the config flag**

In `config/config.go`, after the `EnableProphetDebitVerticals bool` field (~`:51`), add:

```go
	// EnableProphetSingleLegAttribution gates the single-leg P&L attribution
	// hooks in PositionManager (Phase 4 foundation). Default false.
	EnableProphetSingleLegAttribution bool
```

In `Load` (~`:151`), after the `EnableProphetDebitVerticals:` line, add:

```go
		EnableProphetSingleLegAttribution: getEnvOrDefault("ENABLE_PROPHET_SINGLELEG_ATTRIBUTION", "false") == "true",
```

In `config/config_test.go`, mirror the two existing `ENABLE_PROPHET_DEBIT_VERTICALS` cases (default-false and `="true"`) for `ENABLE_PROPHET_SINGLELEG_ATTRIBUTION` / `AppConfig.EnableProphetSingleLegAttribution` (copy those two assertions verbatim with the new env var + field name).

In `.env.example`, near the `ENABLE_PROPHET_DEBIT_VERTICALS` line, add:

```
# Phase 4 foundation: single-leg P&L attribution hooks (teaching-only, fail-soft). Default off.
ENABLE_PROPHET_SINGLELEG_ATTRIBUTION=false
```

- [ ] **Step 4: Add the PositionManager field + setter**

In `services/position_manager.go`, add a field to `type PositionManager struct` (after `storageService *database.LocalStorage`, ~`:112`):

```go
	singleLegAttribEnabled bool
```

And the setter (place it near the other `PositionManager` methods, e.g. just above `managedPositionToDB`):

```go
// EnableSingleLegAttribution toggles the Phase-4 single-leg P&L attribution
// hooks. Off by default; main.go sets it from config.
func (pm *PositionManager) EnableSingleLegAttribution(enabled bool) {
	pm.singleLegAttribEnabled = enabled
}
```

- [ ] **Step 5: Add the two hook methods**

Add to `services/position_manager.go` (near the setter):

```go
// captureSingleLegEntrySnapshot records the entry greek snapshot for a
// v2-options single-leg at fill. Flag/option-gated, fail-soft: any miss leaves
// the fields zero and the fill proceeds.
func (pm *PositionManager) captureSingleLegEntrySnapshot(ctx context.Context, position *ManagedPosition, now time.Time) {
	if !pm.singleLegAttribEnabled || position.AgentStrategy != "v2-options" || !IsOptionSymbol(position.Symbol) {
		return
	}
	snap, _, ok := singleLegSnapshotNow(ctx, pm.dataService, pm.tradingService, position.Symbol, now)
	if !ok {
		return
	}
	position.EntryUnderlyingSpot = snap.Spot
	position.EntryIV = snap.Vol
	position.EntryTimeToExpiry = snap.TimeToExpiry
}

// attributeSingleLegClose computes mark-based P&L attribution at close for a
// v2-options single-leg with a complete entry snapshot. Flag/option-gated,
// fail-soft, skipped on degraded inputs. Never affects the close.
func (pm *PositionManager) attributeSingleLegClose(ctx context.Context, position *ManagedPosition, now time.Time) {
	if !pm.singleLegAttribEnabled || position.AgentStrategy != "v2-options" || !IsOptionSymbol(position.Symbol) {
		return
	}
	if position.EntryUnderlyingSpot <= 0 || position.EntryIV <= 0 || position.EntryTimeToExpiry <= 0 {
		return // incomplete entry snapshot — nothing to attribute against
	}
	exit, mark, ok := singleLegSnapshotNow(ctx, pm.dataService, pm.tradingService, position.Symbol, now)
	if !ok || mark <= 0 || exit.Vol <= 0 {
		return // degraded exit feed
	}
	_, _, optTypeByte, _ := ParseOCC(position.Symbol)
	optType := "call"
	if optTypeByte == 'P' {
		optType = "put"
	}
	strike, _ := ParseOCCStrike(position.Symbol)
	isLong := position.Side == "buy"
	sideSign := 1.0
	if !isLong {
		sideSign = -1.0
	}
	realized := (mark - position.EntryPrice) * 100 * position.Quantity * sideSign
	entry := SingleLegSnapshot{Spot: position.EntryUnderlyingSpot, Vol: position.EntryIV, TimeToExpiry: position.EntryTimeToExpiry}
	attr := attributeSingleLegPnl(optType, isLong, strike, entry, exit, realized, int(position.Quantity))
	position.SingleLegRealizedPnL = realized
	position.AttribDirection = attr.Direction
	position.AttribTheta = attr.Theta
	position.AttribIV = attr.IV
	position.AttribResidual = attr.Residual
}
```

- [ ] **Step 6: Wire the hooks into the lifecycle**

In `activateFilledEntry` (`services/position_manager.go` ~`:700`), after `position.UpdatedAt = time.Now()` and BEFORE `pm.placeRiskOrders(ctx, position)`, add:

```go
	pm.captureSingleLegEntrySnapshot(ctx, position, time.Now())
```

In `CloseManagedPosition` (~`:1253`), after the `pm.mu.Unlock()` that follows the `CLOSED` transition and BEFORE `if err := pm.savePositionToDB(position); err != nil {`, add:

```go
	pm.attributeSingleLegClose(ctx, position, now)
```

(`now` is the variable declared in the `CLOSED` transition block above; `ctx` is the method parameter.)

- [ ] **Step 7: Wire main.go**

In `cmd/bot/main.go`, locate the `PositionManager` construction (grep `NewPositionManager`); immediately after the manager variable is assigned, add (using that variable's name, e.g. `positionManager`):

```go
	positionManager.EnableSingleLegAttribution(cfg.EnableProphetSingleLegAttribution)
```

- [ ] **Step 8: Format, run tests, vet, build**

Run:
```bash
gofmt -w config/config.go config/config_test.go services/position_manager.go cmd/bot/main.go
go test ./config/ ./services/ -run 'SingleLeg|ProphetSingleLeg|Config'
go vet ./config/ ./services/ ./cmd/bot/
go test ./services/
go build ./...
```
Expected: the single-leg + config tests PASS; `go vet` clean; `go test ./services/` reports `ok`; `go build ./...` succeeds (proves the main.go wiring + the new field references compile).

- [ ] **Step 9: Commit**

```bash
git add config/config.go config/config_test.go .env.example services/position_manager.go services/position_manager_singleleg_attribution_test.go cmd/bot/main.go
git commit -m "feat(prophet-vertical): wire single-leg attribution hooks (flag-gated, fail-soft)

ENABLE_PROPHET_SINGLELEG_ATTRIBUTION (default off) gates two PositionManager
hooks: capture the entry IV/spot/time snapshot at fill (activateFilledEntry) and
compute mark-based direction/theta/IV/residual at close (CloseManagedPosition),
for v2-options single-legs only. Reuses existing data handles; never affects a
fill or close. Inert until the flag is on.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- Pure `attributeSingleLegPnl` reusing `bsPrice`, vertical engine untouched — Task 1. ✓
- Entry-snapshot capture (spot/IV/TTE) at fill — Tasks 2 (fetch) + 4 (`captureSingleLegEntrySnapshot` in `activateFilledEntry`). ✓
- Mark-based synchronous close attribution; `realizedPnL = (mark − entry)×100×qty×sideSign` — Task 4 (`attributeSingleLegClose` in `CloseManagedPosition`). ✓
- Persist on `DBManagedPosition` columns, both mappings — Task 3. ✓
- New default-OFF flag `ENABLE_PROPHET_SINGLELEG_ATTRIBUTION`, mirrors the vertical flag — Task 4. ✓
- Option-gated (`v2-options` + `IsOptionSymbol`) + fail-soft + flag-off no-op — Task 4 gating + Task 2 fail-soft fetch. ✓
- Data sources: `GetLatestBar` (spot), `GetOptionsChain` (IV+mark), no new dependency — Task 2. ✓
- Out of scope (tally, dashboard, Node, negative-expectancy baseline) — no task touches them. ✓

**2. Placeholder scan:** No TBD/"handle edge cases"/bare "write tests". Two "grep to locate" steps (the `.env.example`/config flag mirror, the `NewPositionManager` call site in main.go) name the exact existing template to copy + the exact line to add — concrete, not vague. Every code step shows complete code.

**3. Type consistency:** `SingleLegSnapshot{Spot,Vol,TimeToExpiry}`, `SingleLegAttribution{Direction,Theta,IV,Residual}`, `attributeSingleLegPnl(optType,isLong,strike,entry,exit,realizedPnL,contracts)`, `singleLegSnapshotNow(...)→(snap,mark,ok)`, the eight `DBManagedPosition`/`ManagedPosition` field names, `EnableSingleLegAttribution`, `captureSingleLegEntrySnapshot`, `attributeSingleLegClose`, and `EnableProphetSingleLegAttribution` are spelled identically across tasks and match the real signatures read from `prophet_vertical_attribution.go`, `occ.go`, `interfaces/trading.go`, and `config/config.go`.
