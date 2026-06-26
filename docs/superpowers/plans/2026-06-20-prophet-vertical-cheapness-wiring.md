# Wire verticalCheapness into the Propose Path — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compute the cheap/fair/rich `assessVerticalCheapness` read when a debit vertical is proposed and surface it (label + skew + IV/RV) on the `VerticalCard` the LLM reads — advisory only, never blocking a placement.

**Architecture:** Give `VerticalProposer` one new dependency — a narrow `realizedVolSource` interface satisfied by the existing `*RealizedVolService` — and call the already-merged pure `assessVerticalCheapness` inside `Propose`, feeding it the two legs' implied vols and a 20-day realized vol. Surface the result as three new `VerticalCard` JSON fields, which flow to the LLM unchanged through the existing Node proxy tool. RV nil/error → a skew-only read.

**Tech Stack:** Go 1.26 (module `prophet-trader`), standard library, `go test`.

## Global Constraints

- **Advisory only** — cheapness is shown on the card; it must NEVER block, reject, or alter a placement decision.
- **Card-only surfacing** — no DB migration, no persisted columns, no dashboard, no Node change. Only the Go `VerticalCard` struct gains fields.
- **RV lookback = 20 trading days** — use the new const `verticalRVLookbackDays = 20`, matching Prophet's existing IV-RV gate (`controllers/iv_controller.go:54`).
- **RV nil/error/insufficient → skew-only** — `rv = 0` on any failure; `assessVerticalCheapness` already handles `realizedVol ≤ 0`. Never propagate an RV error to the propose caller.
- **Reuse the single RV instance** — pass the `realizedVolSvc` already constructed at `cmd/bot/main.go:315`; do not construct a second `RealizedVolService`.
- **Package `services`**; follow the existing narrow-interface pattern in `prophet_vertical_proposals.go` (`chainSource`, `openGuard`).
- **Constructor param order:** `rv` is appended as the LAST parameter of both `NewVerticalProposer` and `NewVerticalProposerForBot` (minimal churn).
- **Card JSON field names:** `cheapness`, `skew_diff`, `iv_to_rv` (exact).
- **gofmt-clean** — the constants block is `=`-aligned; run `gofmt -w` on every changed `.go` file before committing.
- **Commit convention:** conventional commit scoped `feat(prophet-vertical): ...`, ending the body with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

### Task 1: Wire cheapness into Propose and the VerticalCard

This is a single atomic change: the `NewVerticalProposer` signature change forces the three test call sites and `NewVerticalProposerForBot`/`main.go` to update together, so the whole package + `cmd/bot` only compiles once all pieces are present. TDD: the new test references the new 4-arg constructor and new card fields, so RED is a package compile failure; GREEN lands the full wiring.

**Files:**
- Modify: `services/prophet_vertical_proposals.go` (interface, proposer field, both constructors, `VerticalCard` fields, `Propose` body)
- Modify: `services/prophet_vertical_constants.go` (new const)
- Modify: `cmd/bot/main.go:458` (pass `realizedVolSvc`)
- Test: `services/prophet_vertical_proposals_test.go` (new fake + 3 new tests + 3 call-site updates)

**Interfaces:**
- Consumes: `assessVerticalCheapness(dir VerticalDirection, longIV, shortIV, realizedVol float64) VerticalCheapness` (returns `{SkewDiff, HasIVtoRV, IVtoRV float64; Label string}`) from `prophet_vertical_cheapness.go`; `*RealizedVolService.GetAnnualizedRealizedVol(ctx, symbol, lookbackDays) (float64, error)` from `realized_vol_service.go`; the package-level test helpers `almostEqual`, `fakeChainSource`, `fakeOpenGuard`, `twoLegChain()`.
- Produces:
  - `type realizedVolSource interface { GetAnnualizedRealizedVol(ctx context.Context, symbol string, lookbackDays int) (float64, error) }`
  - `func NewVerticalProposer(src chainSource, guard openGuard, store *proposalStore, rv realizedVolSource) *VerticalProposer`
  - `func NewVerticalProposerForBot(ts interfaces.TradingService, ds interfaces.DataService, guard *TradeGuard, rv *RealizedVolService) *VerticalProposer`
  - `VerticalCard` gains `Cheapness string`, `SkewDiff float64`, `IVtoRV float64`
  - `const verticalRVLookbackDays = 20`

- [ ] **Step 1: Write the failing tests**

In `services/prophet_vertical_proposals_test.go`, update the import block to add `"errors"` and `"strings"`:

```go
import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"prophet-trader/interfaces"
)
```

Append the fake and the three tests at the end of the file:

```go
type fakeRealizedVolSource struct {
	vol float64
	err error
}

func (f *fakeRealizedVolSource) GetAnnualizedRealizedVol(_ context.Context, _ string, _ int) (float64, error) {
	return f.vol, f.err
}

func TestProposer_Propose_EnrichesCheapness(t *testing.T) {
	now := time.Date(2026, 6, 18, 15, 0, 0, 0, time.UTC)
	exp := time.Date(2026, 6, 20, 0, 0, 0, 0, time.UTC)
	// twoLegChain: long C130 IV 0.45, short C140 IV 0.42 → SkewDiff -0.03 (steep).
	src := &fakeChainSource{chain: twoLegChain(), spot: 130}
	rv := &fakeRealizedVolSource{vol: 0.50}
	p := NewVerticalProposer(src, &fakeOpenGuard{}, newProposalStore(), rv)

	_, card, err := p.Propose(context.Background(), "NVDA", CallDebit, exp, 10.0, now)
	if err != nil {
		t.Fatal(err)
	}
	if !almostEqual(card.SkewDiff, -0.03, 1e-9) {
		t.Fatalf("SkewDiff = %v, want -0.03", card.SkewDiff)
	}
	if !almostEqual(card.IVtoRV, 0.90, 1e-9) { // longIV 0.45 / rv 0.50
		t.Fatalf("IVtoRV = %v, want 0.90", card.IVtoRV)
	}
	if !strings.HasPrefix(card.Cheapness, "rich") || !strings.Contains(card.Cheapness, "steep skew") {
		t.Fatalf("Cheapness = %q, want rich/steep-skew", card.Cheapness)
	}
}

func TestProposer_Propose_NilRV_SkewOnly(t *testing.T) {
	now := time.Date(2026, 6, 18, 15, 0, 0, 0, time.UTC)
	src := &fakeChainSource{chain: twoLegChain(), spot: 130}
	p := NewVerticalProposer(src, &fakeOpenGuard{}, newProposalStore(), nil)

	_, card, err := p.Propose(context.Background(), "NVDA", CallDebit, time.Now(), 10.0, now)
	if err != nil {
		t.Fatal(err)
	}
	if card.IVtoRV != 0 {
		t.Fatalf("IVtoRV = %v, want 0 with nil RV", card.IVtoRV)
	}
	if !strings.Contains(card.Cheapness, "no RV") {
		t.Fatalf("Cheapness = %q, want 'no RV'", card.Cheapness)
	}
}

func TestProposer_Propose_RVError_SkewOnly(t *testing.T) {
	now := time.Date(2026, 6, 18, 15, 0, 0, 0, time.UTC)
	src := &fakeChainSource{chain: twoLegChain(), spot: 130}
	rv := &fakeRealizedVolSource{err: errors.New("feed down")}
	p := NewVerticalProposer(src, &fakeOpenGuard{}, newProposalStore(), rv)

	_, card, err := p.Propose(context.Background(), "NVDA", CallDebit, time.Now(), 10.0, now)
	if err != nil {
		t.Fatalf("propose must succeed despite RV error: %v", err)
	}
	if card.IVtoRV != 0 {
		t.Fatalf("IVtoRV = %v, want 0 on RV error", card.IVtoRV)
	}
}
```

Update the three existing `NewVerticalProposer(...)` call sites to pass the new last arg `nil` (they do not exercise cheapness):

- Line ~77 (`TestProposer_Propose_StoresAndCards`):
  ```go
  p := NewVerticalProposer(src, &fakeOpenGuard{}, newProposalStore(), nil)
  ```
- Line ~98 (`TestProposer_Propose_RejectsNonPositiveDebit`):
  ```go
  p := NewVerticalProposer(&fakeChainSource{chain: chain, spot: 130}, &fakeOpenGuard{}, newProposalStore(), nil)
  ```
- Line ~111 (`TestProposer_ValidateForPlace`):
  ```go
  p := NewVerticalProposer(src, &fakeOpenGuard{}, store, nil)
  ```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./services/ -run TestProposer_Propose -v`
Expected: FAIL — package compile error (`too many arguments in call to NewVerticalProposer` and `card.Cheapness/SkewDiff/IVtoRV` undefined). This is the expected RED for a signature+struct change.

- [ ] **Step 3: Add the constant**

In `services/prophet_vertical_constants.go`, add inside the existing `const (...)` block, immediately after the `verticalContracts = 1 ...` line:

```go
	verticalRVLookbackDays = 20 // realized-vol lookback (trading days) for the cheapness read — matches Prophet's IV-RV gate
```

- [ ] **Step 4: Add the interface and the proposer field**

In `services/prophet_vertical_proposals.go`, immediately after the `openGuard` interface (the block ending at the line `CheckOptionsOpen(agent AgentSource, underlying, symbol string, q *interfaces.OptionsQuote, now time.Time) error` then `}`), add:

```go
// realizedVolSource supplies trailing annualized realized vol for an underlying,
// used to score entry cheapness (IV-vs-RV). Implemented by *RealizedVolService;
// may be nil (cheapness then falls back to a skew-only read).
type realizedVolSource interface {
	GetAnnualizedRealizedVol(ctx context.Context, symbol string, lookbackDays int) (float64, error)
}
```

In the `VerticalProposer` struct, add the `rv` field:

```go
type VerticalProposer struct {
	src   chainSource
	guard openGuard
	store *proposalStore
	rv    realizedVolSource
}
```

Update `NewVerticalProposer`:

```go
func NewVerticalProposer(src chainSource, guard openGuard, store *proposalStore, rv realizedVolSource) *VerticalProposer {
	return &VerticalProposer{src: src, guard: guard, store: store, rv: rv}
}
```

- [ ] **Step 5: Add the VerticalCard fields**

In `services/prophet_vertical_proposals.go`, in the `VerticalCard` struct, add three fields after the existing `ShortIV float64 \`json:"short_iv"\`` line (keep them inside the struct):

```go
	Cheapness   string  `json:"cheapness"`  // teaching label, e.g. "cheap: call_debit, favorable skew, IV<=RV"
	SkewDiff    float64 `json:"skew_diff"`  // shortIV - longIV (vol sold minus vol bought)
	IVtoRV      float64 `json:"iv_to_rv"`   // longIV / 20d realized vol; 0 when RV unavailable
```

- [ ] **Step 6: Compute cheapness in Propose and populate the card**

In `Propose`, insert the cheapness computation between the debit-cap rejection check and the `id := fmt.Sprintf("vp-%d", now.UnixNano())` line:

```go
	// Entry cheapness teaching read (advisory). An RV fetch failure degrades to
	// a skew-only read; it never blocks the proposal.
	rv := 0.0
	if p.rv != nil {
		if v, err := p.rv.GetAnnualizedRealizedVol(ctx, underlying, verticalRVLookbackDays); err == nil {
			rv = v
		}
	}
	cheap := assessVerticalCheapness(dir, long.ImpliedVolatility, short.ImpliedVolatility, rv)
```

In the `card := VerticalCard{...}` literal, add a line after the existing `LongIV: long.ImpliedVolatility, ShortIV: short.ImpliedVolatility,` line:

```go
		Cheapness: cheap.Label, SkewDiff: cheap.SkewDiff, IVtoRV: cheap.IVtoRV,
```

- [ ] **Step 7: Update NewVerticalProposerForBot**

In `services/prophet_vertical_proposals.go`, change `NewVerticalProposerForBot` to accept and thread the RV service:

```go
func NewVerticalProposerForBot(ts interfaces.TradingService, ds interfaces.DataService, guard *TradeGuard, rv *RealizedVolService) *VerticalProposer {
	return NewVerticalProposer(
		NewChainSourceAdapter(ts, ds),
		guard,
		NewProposalStore(),
		rv,
	)
}
```

- [ ] **Step 8: Update the main.go wiring**

In `cmd/bot/main.go`, line ~458, pass the existing `realizedVolSvc` (constructed at line ~315) as the new last argument:

```go
		verticalProposer = services.NewVerticalProposerForBot(tradingService, dataService, tradeGuard, realizedVolSvc)
```

- [ ] **Step 9: Format, then run the tests to verify they pass**

Run:
```bash
gofmt -w services/prophet_vertical_proposals.go services/prophet_vertical_constants.go services/prophet_vertical_proposals_test.go cmd/bot/main.go
go test ./services/ -run TestProposer_Propose -v
```
Expected: PASS — `TestProposer_Propose_EnrichesCheapness`, `TestProposer_Propose_NilRV_SkewOnly`, `TestProposer_Propose_RVError_SkewOnly`, plus the pre-existing `TestProposer_Propose_*` all green.

- [ ] **Step 10: Verify the whole package + cmd/bot build, and the suite is clean**

Run:
```bash
gofmt -l services/prophet_vertical_proposals.go services/prophet_vertical_constants.go services/prophet_vertical_proposals_test.go cmd/bot/main.go
go vet ./services/ ./cmd/bot/
go test ./services/
go build ./...
```
Expected: `gofmt -l` prints nothing (all formatted); `go vet` prints nothing; `go test ./services/` reports `ok prophet-trader/services`; `go build ./...` succeeds (this is what proves the `main.go` wiring compiles against the new `NewVerticalProposerForBot` signature).

- [ ] **Step 11: Commit**

```bash
git add services/prophet_vertical_proposals.go services/prophet_vertical_constants.go services/prophet_vertical_proposals_test.go cmd/bot/main.go
git commit -m "feat(prophet-vertical): surface entry cheapness on the proposal card

VerticalProposer gains a realizedVolSource dep; Propose computes
assessVerticalCheapness from the legs' IV + 20d realized vol and surfaces
cheapness/skew_diff/iv_to_rv on the VerticalCard the LLM reads. Advisory only —
never blocks a placement. RV nil/error degrades to a skew-only read. Reuses the
realizedVolSvc already built in main.go; no migration, no Node/dashboard change.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage** (against `docs/superpowers/specs/2026-06-20-prophet-vertical-cheapness-wiring-design.md`):
- `realizedVolSource` interface — Step 4. ✓
- `rv` field + `NewVerticalProposer` signature — Step 4. ✓
- `NewVerticalProposerForBot` signature — Step 7. ✓
- `main.go` one-line wiring (reuse `realizedVolSvc`) — Step 8. ✓
- `Propose` cheapness computation, placed after the cap gate, before the card — Step 6. ✓
- Three `VerticalCard` fields (`cheapness`/`skew_diff`/`iv_to_rv`) — Step 5. ✓
- `verticalRVLookbackDays = 20` — Step 3. ✓
- RV nil/error → skew-only — Step 6 logic + Steps 1 tests (`NilRV_SkewOnly`, `RVError_SkewOnly`). ✓
- Advisory only (never blocks) — no rejection added in Step 6; computation is read-only. ✓
- Tests reuse existing scaffolding; 3 call-site updates — Step 1. ✓
- `go test`/`go vet`/build verification — Steps 9-10. ✓
- Out of scope (gating, persisted columns, migration, dashboard, single-leg) — none of the steps touch these. ✓

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"write tests for the above". Every code step shows the exact code; every run step shows the exact command + expected output. ✓

**3. Type consistency:** `realizedVolSource`, `GetAnnualizedRealizedVol`, `verticalRVLookbackDays`, `assessVerticalCheapness`, `cheap.Label`/`cheap.SkewDiff`/`cheap.IVtoRV`, and the card fields `Cheapness`/`SkewDiff`/`IVtoRV` are spelled identically across steps and match the real signatures read from `realized_vol_service.go`, `prophet_vertical_cheapness.go`, and `prophet_vertical_proposals.go`. The test's expected `SkewDiff = -0.03` and `IVtoRV = 0.90` follow from `twoLegChain()`'s IVs (0.42 − 0.45; 0.45 / 0.50). ✓
