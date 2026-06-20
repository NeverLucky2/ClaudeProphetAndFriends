# Wire verticalCheapness into the propose path — Design

**Date:** 2026-06-20
**Status:** Approved (brainstorming complete)
**Feature:** Prophet debit verticals (teaching feature) — connects the already-merged pure `assessVerticalCheapness` scorer to the live propose flow.

## Goal

Make Prophet's debit-vertical proposal **cheapness-aware at decision time**: when a vertical is proposed, compute the cheap/fair/rich teaching read and surface it on the proposal card the LLM sees. Advisory only — it informs the decision, never blocks a placement. This is the deferred "call site" wiring from the pure-module work (`d46a13b`); the scorer logic already exists and is tested, this design only connects its inputs and exposes its output.

## Decisions (settled in brainstorming)

- **Role: advisory only.** Cheapness is shown on the card; it does not gate placement. Matches the teaching-toy intent (watch defined-risk verticals bleed, including deliberately "rich" entries) and the paper-phase "more risk now" posture.
- **Surfacing: card-only.** Add fields to `VerticalCard` (the JSON the LLM reads). No persisted columns, no DB migration, no dashboard work. Persisting entry-cheapness on the row is left to Phase 4 (the attribution/tally phase that would consume it).
- **RV lookback: 20 trading days**, matching Prophet's existing IV-RV gate (`controllers/iv_controller.go:54` calls `GetAnnualizedRealizedVol(ctx, symbol, 20)`, surfaced as `realized_vol_20d`).
- **RV unavailable → skew-only.** A nil RV service, a fetch error, or insufficient history yields `rv = 0`, which the scorer already handles (skew-only label, `IVtoRV = 0`). Mirrors the IVController, which silently ignores RV-fetch failures and treats `RealizedVol20d == 0` as "no signal."

## Scope

Go-only change. Five files, no migration, no Node/dashboard change.

### Files

1. **`services/prophet_vertical_proposals.go`** (modify) — new `realizedVolSource` interface; `rv` field on `VerticalProposer`; `NewVerticalProposer` + `NewVerticalProposerForBot` signature change; cheapness computation in `Propose`; three new `VerticalCard` fields.
2. **`services/prophet_vertical_constants.go`** (modify) — add `verticalRVLookbackDays = 20`.
3. **`cmd/bot/main.go`** (modify, 1 line) — pass the existing `realizedVolSvc` into `NewVerticalProposerForBot`.
4. **`services/prophet_vertical_proposals_test.go`** (modify) — update the 3 existing `NewVerticalProposer(...)` call sites for the new arg; add cheapness-enrichment tests.
5. **`services/prophet_vertical_cheapness.go`** — **no change** (the scorer already exists; this design only calls it).

## Component design

### realizedVolSource interface (new, in `prophet_vertical_proposals.go`)

A narrow, one-method interface kept local to the proposals file, mirroring the existing `chainSource` and `openGuard` interfaces there:

```go
// realizedVolSource supplies trailing annualized realized vol for an underlying,
// used to score entry cheapness (IV-vs-RV). Implemented by *RealizedVolService;
// may be nil (cheapness then falls back to a skew-only read).
type realizedVolSource interface {
	GetAnnualizedRealizedVol(ctx context.Context, symbol string, lookbackDays int) (float64, error)
}
```

`*RealizedVolService` (`services/realized_vol_service.go`) already has this exact method signature, so it satisfies the interface with no adapter.

### VerticalProposer (modify)

Add an `rv realizedVolSource` field. Constructor gains `rv` as the **last** parameter (minimal churn to existing readers):

```go
func NewVerticalProposer(src chainSource, guard openGuard, store *proposalStore, rv realizedVolSource) *VerticalProposer
```

`rv` may be nil; `Propose` guards for it.

### NewVerticalProposerForBot (modify)

Add `rv *RealizedVolService` as the last parameter and thread it through:

```go
func NewVerticalProposerForBot(ts interfaces.TradingService, ds interfaces.DataService, guard *TradeGuard, rv *RealizedVolService) *VerticalProposer {
	return NewVerticalProposer(NewChainSourceAdapter(ts, ds), guard, NewProposalStore(), rv)
}
```

### main.go wiring (modify, 1 line)

`realizedVolSvc` is already constructed at `cmd/bot/main.go:315` (the same instance the IV controller uses). The Phase-3a call at `cmd/bot/main.go:458` becomes:

```go
verticalProposer = services.NewVerticalProposerForBot(tradingService, dataService, tradeGuard, realizedVolSvc)
```

`realizedVolSvc` (line 315) is in scope at line 458 (same `main` body, defined earlier). No duplicate service is constructed.

### Propose cheapness computation (modify)

Inserted **after** the debit and debit-cap rejection gates pass (so a doomed proposal never triggers an RV fetch) and **before** the `VerticalCard` is built:

```go
rv := 0.0
if p.rv != nil {
	if v, err := p.rv.GetAnnualizedRealizedVol(ctx, underlying, verticalRVLookbackDays); err == nil {
		rv = v
	}
}
cheap := assessVerticalCheapness(dir, long.ImpliedVolatility, short.ImpliedVolatility, rv)
```

Then the card is populated with three new fields from `cheap`. The legs' IVs are the same `long.ImpliedVolatility` / `short.ImpliedVolatility` already used to populate the card's existing `LongIV` / `ShortIV` (`prophet_vertical_proposals.go:160`).

### VerticalCard fields (new)

Three fields appended to the struct:

```go
Cheapness string  `json:"cheapness"`  // teaching label, e.g. "cheap: call_debit, favorable skew, IV<=RV"
SkewDiff  float64 `json:"skew_diff"`  // shortIV - longIV (vol sold minus vol bought)
IVtoRV    float64 `json:"iv_to_rv"`   // longIV / 20d realized vol; 0 when RV unavailable
```

These flow to the LLM unchanged through the existing Node proxy tool (`propose_debit_vertical` in `mcp-server.js` relays the card JSON verbatim) — no Node change required. A dashboard that doesn't read these fields ignores them.

### verticalRVLookbackDays constant (new, in `prophet_vertical_constants.go`)

```go
verticalRVLookbackDays = 20 // realized-vol lookback for the cheapness read (matches Prophet's IV-RV gate)
```

## Data flow

```
LLM calls propose_debit_vertical (Node MCP tool)
  → POST /api/v1/options/verticals/propose (Go OrderController)
    → VerticalProposer.Propose:
        pickVerticalStrikes → price debit → cap check
        rv = realizedVolSvc.GetAnnualizedRealizedVol(underlying, 20)   [nil/err → 0]
        cheap = assessVerticalCheapness(dir, longIV, shortIV, rv)
        card.Cheapness/SkewDiff/IVtoRV = cheap.*
    → card JSON (now incl. cheapness) returned
  → Node relays card verbatim → LLM reads cheapness in its decision
```

## Error handling

- **RV service nil** (e.g., a test, or a future wiring that omits it): `rv = 0`, skew-only read. No panic, no error to the caller.
- **RV fetch error / insufficient history**: error ignored, `rv = 0`, skew-only read. The propose still succeeds with a valid card.
- **Leg IV missing** (`ImpliedVolatility == 0`): the scorer's `HasIVtoRV` requires `longIV > 0`, so a zero long IV also yields skew-only — consistent and safe.
- Cheapness never returns an error and never blocks the propose; a degraded feed only degrades the read to skew-only (or, with both IV and RV absent, a flat/neutral read).

## Testing (TDD)

New tests in `services/prophet_vertical_proposals_test.go`, reusing the existing `fakeChainSource` / `fakeOpenGuard` / `twoLegChain()` scaffolding:

- **`fakeRealizedVolSource`** test double returning a configurable `(vol, err)`.
- **Cheapness enrichment, happy path:** `twoLegChain()` has long IV 0.45 / short IV 0.42 (`SkewDiff = -0.03` → steep). Inject RV so the read is deterministic; assert `card.SkewDiff ≈ -0.03`, `card.IVtoRV ≈ longIV/rv`, and `card.Cheapness` has the expected verdict prefix. (With `SkewDiff -0.03 < -skewVolTol`, this is a `rich: … steep skew` card regardless of RV — a good demonstration that the steep call-debit skew dominates.)
- **Skew-only fallback (RV nil):** construct the proposer with `rv = nil`; assert `card.IVtoRV == 0` and `card.Cheapness` contains `"no RV"`.
- **Skew-only fallback (RV error):** `fakeRealizedVolSource{err: …}`; assert the propose still succeeds and the card is skew-only (`IVtoRV == 0`).
- **Existing call-site updates:** the 3 `NewVerticalProposer(...)` calls (lines 77, 98, 111) get the new `nil` arg; their existing assertions are unaffected (RV-nil only adds skew-only card fields, leaving `NetDebit`/`MaxLossUSD`/store behavior unchanged).

Verification bar: `go test ./services/` green, `go vet ./services/` clean, build clean.

## Deploy

Rebuild the Go bot + restart. Behind the existing `ENABLE_PROPHET_DEBIT_VERTICALS` flag (the propose endpoint 403s when off, so this is inert until the flag is on). Advisory + graceful RV fallback = low risk. With the flag on, the next propose returns a card carrying the cheapness read.

## Out of scope (deferred to Phase 4)

- Gating / blocking placement on cheapness.
- Persisting entry cheapness on `prophet_vertical_spreads` (`EntrySkewDiff` / `EntryIVtoRV` / `EntryRealizedVol` columns) and the model migration that implies.
- Dashboard rendering of the cheapness read.
- Running cheapness on the single-leg sleeve (the single-leg-vs-vertical tally).
