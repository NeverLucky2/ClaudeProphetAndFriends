# Phase 4 Foundation: Prophet single-leg P&L attribution — Design

**Date:** 2026-06-20
**Status:** Approved (brainstorming complete)
**Feature:** Prophet debit verticals (teaching feature), Phase 4 — *foundation only*. Extends the structure-agnostic P&L attribution to Prophet's single-leg options. The single-leg-vs-vertical comparison tally is explicitly a later cycle.

## Goal

When a Prophet single-leg option (`AgentStrategy="v2-options"`) fills, capture an entry snapshot (underlying spot, implied vol, time-to-expiry). When it closes, decompose its realized P&L into direction / theta / IV / residual using the same reprice algorithm the verticals use, and persist that decomposition. This makes the "right on direction, still lost to IV/theta" story durable per single-leg trade — the data the next cycle's tally will compare against the verticals.

## Decisions (settled in brainstorming)

- **Foundation only.** Build entry-snapshot capture + close-hook attribution. DEFER the single-leg-vs-vertical comparison tally, dashboard surfacing, and the negative-expectancy baseline write-up to a later cycle (data must accrue first).
- **Persist on `DBManagedPosition` (columns), not a sidecar table.** The single-leg already has a lifecycle row (`models/models.go:126`, `managed_positions`); reusing it means the hooks set fields on the row they already hold — no second table, no dual-write (the project's recurring orphan failure mode). Columns are populated only for `v2-options` rows; equity rows leave them zero, exactly as `AgentStrategy` already does.
- **New default-OFF flag `ENABLE_PROPHET_SINGLELEG_ATTRIBUTION`.** This touches the *shared* `position_manager.go`, so a dedicated flag gives a clean rollback and keeps it inert until enabled — separate from `ENABLE_PROPHET_DEBIT_VERTICALS`.
- **Reuse the shared `bsPrice` primitive + the same theta→direction→IV sequence**, in a new isolated `attributeSingleLegPnl`. The proven vertical attribution engine is **not modified** (lower risk); the two are kept behavior-parallel by mirrored tests.
- **Long single-legs are the target.** Prophet buys to open (long calls/puts). The attribution takes the option type and position side so a short leg would still attribute correctly, but long is the expected case.
- **Fail-soft everywhere.** Attribution data is teaching-only. A degraded feed at capture or close stores zeros / skips attribution; it must never block, delay, or fail a fill or a close.

## Scope

### Files

1. **`services/prophet_singleleg_attribution.go`** (new) + test — the pure attribution function and its snapshot/result types. Reuses the unexported `bsPrice` from `prophet_vertical_attribution.go` (same `services` package).
2. **`models/models.go`** (modify) — add option-only columns to `DBManagedPosition`.
3. **`services/position_manager.go`** (modify) — entry hook in `activateFilledEntry` (~`:693`), close hook in `CloseManagedPosition` (~`:1150`), both gated to `v2-options` single-legs + the flag; plus a fail-soft snapshot helper.
4. **Config / flag plumbing** (modify) — add `ENABLE_PROPHET_SINGLELEG_ATTRIBUTION` alongside `EnableProphetDebitVerticals` (same config struct + `.env.example`).
5. **`database/storage.go`** — no new table; `DBManagedPosition` is already AutoMigrated, so the additive columns are picked up. (Confirm during planning.)

## Component design

### 1. Pure single-leg attribution (`prophet_singleleg_attribution.go`)

```go
// SingleLegSnapshot is the greek state of one option leg at a point in time.
type SingleLegSnapshot struct {
	Spot         float64 // underlying price
	Vol          float64 // implied vol (decimal, 0.30 == 30%)
	TimeToExpiry float64 // years
}

// SingleLegAttribution decomposes a single leg's realized P&L (teaching output).
type SingleLegAttribution struct {
	Direction float64
	Theta     float64
	IV        float64
	Residual  float64
}

// attributeSingleLegPnl decomposes realizedPnL via the SAME theta→direction→IV
// reprice sequence as attributeVerticalPnl, but pricing one leg with bsPrice.
// optType is "call"|"put"; isLong true for a bought leg; contracts scales ×100.
func attributeSingleLegPnl(optType string, isLong bool, strike float64,
	entry, exit SingleLegSnapshot, realizedPnL float64, contracts int) SingleLegAttribution
```

The walk mirrors the vertical engine: start at entry; **theta** = revalue moving time entry→exit (spot, vol held at entry); **direction** = revalue moving spot entry→exit (vol at entry, time at exit); **IV** = revalue moving vol entry→exit (spot, time at exit); **residual** = realizedPnL − (direction+theta+IV), absorbing model-vs-fill drift. Pure: no I/O, no clock.

### 2. Persistence — `DBManagedPosition` columns (`models/models.go`)

Added (all `v2-options`-only; zero for equity rows):

```go
// Single-leg options attribution (Phase 4). Captured at fill / computed at close
// for AgentStrategy=="v2-options" rows; zero for non-option positions and when
// the feed was degraded at capture time.
EntryUnderlyingSpot float64
EntryIV             float64
EntryTimeToExpiry   float64 // years
SingleLegRealizedPnL float64 `gorm:"column:single_leg_realized_pnl"`
AttribDirection     float64
AttribTheta         float64
AttribIV            float64
AttribResidual      float64
```

(`RealizedPnL` is namespaced `SingleLeg...` to avoid colliding with any existing P&L semantics on the shared row — confirm exact naming during planning.)

### 3. Entry hook — `activateFilledEntry` (`position_manager.go:~693`)

After the existing `position.EntryPrice = *order.FilledAvgPrice`, when the flag is on AND the position is a `v2-options` single-leg (OCC symbol via `ParseOCC`):

- underlying = OCC underlying; `EntryUnderlyingSpot` = underlying mid (spot source).
- `EntryIV` = the option's implied vol (greeks source).
- `EntryTimeToExpiry` = (OCC expiry − now) in years.

Fail-soft: any fetch error or missing field → leave the field zero (mirrors the vertical `EntryLongVol` "zero == degraded" convention). The fill proceeds regardless.

### 4. Close hook — `CloseManagedPosition` (`position_manager.go:~1150`)

When the flag is on AND a `v2-options` single-leg with a non-zero entry snapshot reaches a terminal close with realized P&L known:

- `SingleLegRealizedPnL` = realized P&L (reconcile to broker fills; mirror the vertical close path).
- exit snapshot = current underlying spot + option IV + (expiry − now) years.
- run `attributeSingleLegPnl(optType, isLong, strike, entry, exit, realizedPnL, contracts)` and persist `AttribDirection/Theta/IV/Residual`.

Skipped (not errored) when the entry snapshot is incomplete (any of spot/IV/TTE zero) or the exit feed is degraded — attribution is teaching-only.

### 5. Data sources (integration seam — confirm during planning)

The hooks need, at fill and at close: the underlying **spot** and the option's **implied vol**. `PositionManager` already revalues option positions (it sets `CurrentPrice`/`UnrealizedPL`, `position_manager.go:~1083`), so an options-data/quote handle is reachable. Design assumes a narrow injected `singleLegGreeksSource` (IV) + spot source, both fail-soft. **Plan-time verification:** confirm exactly which data dependency `PositionManager` already holds for option revaluation and whether it exposes IV, vs. needing a new injected dependency.

## Data flow

```
place (v2-options single-leg) → order fills
  → activateFilledEntry: capture entry {spot, IV, TTE}  [flag on, fail-soft]
  … position managed (stops/targets) …
CloseManagedPosition: realized P&L known
  → capture exit {spot, IV, TTE}
  → attributeSingleLegPnl(...) → persist Direction/Theta/IV/Residual  [skip if degraded]
```

## Error handling

- Entry/exit feed failure → zeros; capture/attribution degrades or is skipped; the trade is never affected.
- Incomplete entry snapshot at close → attribution skipped (row still closes normally).
- Flag off → both hooks are no-ops (zero added latency, zero behavior change on the shared path).
- Non-`v2-options` rows (equities: Turtle/Coil/etc.) → hooks short-circuit immediately on the strategy check.

## Testing

- **Pure attribution (TDD):** `attributeSingleLegPnl` — the headline pure-IV-crush case (spot & time flat, vol drops → all loss booked to `IV`); a pure-direction case (spot moves, vol/time flat); a theta case (time decays, spot/vol flat); a long-put case; residual reconciliation to `realizedPnL`. Mirror the vertical attribution tests so the two engines stay behavior-parallel.
- **Entry hook:** with a fake greeks/spot source, assert a `v2-options` fill captures the entry snapshot; a degraded source leaves zeros; a non-option (equity) fill captures nothing; flag-off captures nothing.
- **Close hook:** assert a closed `v2-options` single-leg with a valid entry snapshot persists the four attribution fields; an incomplete entry snapshot skips attribution without erroring; flag-off skips.

Bar: `go test ./services/` green, `go vet` clean, build clean.

## Deploy

Rebuild Go + restart bot. Behind `ENABLE_PROPHET_SINGLELEG_ATTRIBUTION` (default OFF) — fully inert until enabled; the additive `DBManagedPosition` columns migrate harmlessly on first boot regardless of the flag.

## Out of scope (next cycle)

- The single-leg-vs-vertical comparison **tally / report** (the teaching payoff).
- Dashboard rendering of attribution.
- API/Node surfacing of the new single-leg attribution fields.
- The pre-registered long-premium negative-expectancy baseline write-up.
