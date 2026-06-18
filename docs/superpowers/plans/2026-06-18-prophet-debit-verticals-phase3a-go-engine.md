# Prophet Debit Verticals — Phase 3a (Go engine) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the Go layer that makes the dormant Phase-1/2 vertical engine drivable over HTTP — an in-memory TTL proposal store + propose/place glue (the identity contract), 4 `OrderController` endpoints with single-leg-parity guards, list enrichment, and the `main.go` wiring — all behind `ENABLE_PROPHET_DEBIT_VERTICALS` (default OFF).

**Architecture:** A new `VerticalProposer` (in `services`) owns the in-memory proposal store + the propose (chain→snap→price→snapshot→store) and validate-for-place (TTL + debit-drift) logic, reusing Phase-1 `pickVerticalStrikes`/`verticalDebitLimit` and Phase-2 `executor.Place`/`RequestClose`/`ledger.ListOpen`. The `OrderController` gains 4 flag-gated endpoints; the `place` endpoint runs `CheckBuy` + `sleeveGuard.EvaluateOpen` on the net-debit notional before delegating to `executor.Place`, matching the single-leg path. Node tools (Phase 3b) are out of scope here.

**Tech Stack:** Go, `package services` + `package controllers`; gin; gorm-backed ledger; `go test`.

**Spec:** `docs/superpowers/specs/2026-06-18-prophet-debit-verticals-phase3-tools-endpoints-design.md`

---

## File Structure

- `services/prophet_vertical_constants.go` — **modify**: add `verticalProposalTTL`, `verticalDebitDriftTolerance`.
- `services/prophet_vertical_proposals.go` — **create**: `proposalStore` (map+mutex+TTL+sweep), `VerticalProposer` (`Propose`, `ValidateForPlace`), the proposal/card types, and the small fetcher interfaces it depends on.
- `services/prophet_vertical_proposals_test.go` — **create**.
- `services/prophet_vertical_executor.go` — **modify**: add exported `ListOpenVerticalsEnriched`.
- `services/prophet_vertical_executor_test.go` — **modify**: test for the above.
- `controllers/order_controller.go` — **modify**: new fields + `SetVerticals` setter + 4 handlers (`ProposeVertical`, `PlaceVertical`, `ListVerticals`, `CloseVertical`).
- `controllers/order_controller_vertical_test.go` — **create**: handler tests.
- `cmd/bot/main.go` — **modify**: lift executor/ledger/store construction out of the flag-block; `SetVerticals`; register 4 routes.

All commands run from the worktree `.claude/worktrees/prophet-debit-verticals-phase3` (branch `prophet-debit-verticals-phase3`).

---

## Task 1: Proposal store + knobs

**Files:**
- Modify: `services/prophet_vertical_constants.go`
- Create: `services/prophet_vertical_proposals.go`, `services/prophet_vertical_proposals_test.go`

- [ ] **Step 1: Add the knobs.** In `services/prophet_vertical_constants.go`, inside the `const (...)` block (after `verticalExpectedExitCost`):

```go
	verticalProposalTTL         = 3 * time.Minute // propose→place validity window
	verticalDebitDriftTolerance = 0.15            // reject place if net debit moved >15% vs the quoted card
```

- [ ] **Step 2: Write the failing store test** (`services/prophet_vertical_proposals_test.go`):

```go
package services

import (
	"testing"
	"time"

	"prophet-trader/interfaces"
)

func testProposal(id string) *verticalProposal {
	return &verticalProposal{
		id:          id,
		req:         PlaceVerticalRequest{Underlying: "NVDA", LongSymbol: "NVDA250620C00130000", ShortSymbol: "NVDA250620C00140000"},
		quotedDebit: 4.20,
		entryLong:   &interfaces.OptionContract{Symbol: "NVDA250620C00130000"},
		entryShort:  &interfaces.OptionContract{Symbol: "NVDA250620C00140000"},
	}
}

func TestProposalStore_PutGetExpiry(t *testing.T) {
	now := time.Date(2026, 6, 18, 15, 0, 0, 0, time.UTC)
	s := newProposalStore()
	s.put(testProposal("p1"), now)

	if got, ok := s.get("p1", now.Add(2*time.Minute)); !ok || got.id != "p1" {
		t.Fatalf("within TTL: want p1, got ok=%v", ok)
	}
	if _, ok := s.get("p1", now.Add(verticalProposalTTL+time.Second)); ok {
		t.Fatal("past TTL: want miss")
	}
	if _, ok := s.get("nope", now); ok {
		t.Fatal("unknown id: want miss")
	}
}

func TestProposalStore_SweepBoundsRetention(t *testing.T) {
	now := time.Date(2026, 6, 18, 15, 0, 0, 0, time.UTC)
	s := newProposalStore()
	s.put(testProposal("old"), now)
	s.put(testProposal("fresh"), now.Add(2*time.Minute))
	s.sweep(now.Add(verticalProposalTTL + time.Second)) // "old" expired, "fresh" still valid
	if s.len() != 1 {
		t.Fatalf("after sweep want 1 retained, got %d", s.len())
	}
}
```

- [ ] **Step 3: Run → FAIL.** `go test ./services/ -run TestProposalStore -v` → undefined `verticalProposal`/`newProposalStore`.

- [ ] **Step 4: Implement the store** in `services/prophet_vertical_proposals.go`:

```go
package services

import (
	"sync"
	"time"

	"prophet-trader/interfaces"
)

// verticalProposal is a stored propose→place record. quotedDebit is the
// per-contract net debit priced at propose (Alpaca-positive, guaranteed > 0).
type verticalProposal struct {
	id          string
	expiresAt   time.Time
	req         PlaceVerticalRequest
	quotedDebit float64
	entryLong   *interfaces.OptionContract
	entryShort  *interfaces.OptionContract
}

// proposalStore is an in-memory, TTL-expiring, mutex-guarded proposal map.
// Expiry is lazy on get AND swept at the top of each propose; a restart drops
// all proposals (place then rejects "not found" → the LLM re-proposes).
type proposalStore struct {
	mu sync.Mutex
	m  map[string]*verticalProposal
}

func newProposalStore() *proposalStore {
	return &proposalStore{m: map[string]*verticalProposal{}}
}

func (s *proposalStore) put(p *verticalProposal, now time.Time) {
	p.expiresAt = now.Add(verticalProposalTTL)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.m[p.id] = p
}

func (s *proposalStore) get(id string, now time.Time) (*verticalProposal, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.m[id]
	if !ok || !now.Before(p.expiresAt) {
		if ok {
			delete(s.m, id)
		}
		return nil, false
	}
	return p, true
}

func (s *proposalStore) sweep(now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, p := range s.m {
		if !now.Before(p.expiresAt) {
			delete(s.m, id)
		}
	}
}

func (s *proposalStore) len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.m)
}
```

- [ ] **Step 5: Run → PASS.** `go test ./services/ -run TestProposalStore -v`.

- [ ] **Step 6: Commit.**
```bash
git add services/prophet_vertical_constants.go services/prophet_vertical_proposals.go services/prophet_vertical_proposals_test.go
git commit -m "feat(prophet-vertical): in-memory TTL proposal store + knobs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `VerticalProposer.Propose`

**Files:** Modify `services/prophet_vertical_proposals.go`, `services/prophet_vertical_proposals_test.go`

Reuses Phase-1 `pickVerticalStrikes(chain map[string]*interfaces.OptionContract, dir VerticalDirection, longTarget, widthTarget float64)` and `verticalDebitLimit(longMid, shortMid, longBA, shortBA, width, bufferFrac float64)`. `longTarget` = the underlying spot (ATM long leg). The proposer depends on injectable fetchers so it's testable.

- [ ] **Step 1: Failing test** (append to `services/prophet_vertical_proposals_test.go`):

```go
// fakes for the proposer
type fakeChainSource struct {
	chain map[string]*interfaces.OptionContract
	spot  float64
	err   error
}

func (f *fakeChainSource) ChainMap(_ context.Context, underlying string, exp time.Time) (map[string]*interfaces.OptionContract, error) {
	return f.chain, f.err
}
func (f *fakeChainSource) Spot(_ context.Context, underlying string) (float64, error) { return f.spot, f.err }

type fakeOpenGuard struct{ err error }

func (f *fakeOpenGuard) CheckOptionsOpen(_ AgentSource, _ string, _ string, _ *interfaces.OptionsQuote, _ time.Time) error {
	return f.err
}

func twoLegChain() map[string]*interfaces.OptionContract {
	return map[string]*interfaces.OptionContract{
		"NVDA250620C00130000": {Symbol: "NVDA250620C00130000", StrikePrice: 130, ContractType: "call", Bid: 6.0, Ask: 6.4, ImpliedVolatility: 0.45},
		"NVDA250620C00140000": {Symbol: "NVDA250620C00140000", StrikePrice: 140, ContractType: "call", Bid: 2.0, Ask: 2.4, ImpliedVolatility: 0.42},
	}
}

func TestProposer_Propose_StoresAndCards(t *testing.T) {
	now := time.Date(2026, 6, 18, 15, 0, 0, 0, time.UTC)
	exp := time.Date(2026, 6, 20, 0, 0, 0, 0, time.UTC)
	src := &fakeChainSource{chain: twoLegChain(), spot: 130}
	p := NewVerticalProposer(src, &fakeOpenGuard{}, newProposalStore())

	id, card, err := p.Propose(context.Background(), "NVDA", CallDebit, exp, 10.0, now)
	if err != nil {
		t.Fatal(err)
	}
	if id == "" || card.NetDebit <= 0 || card.MaxLossUSD <= 0 {
		t.Fatalf("bad card: id=%q card=%+v", id, card)
	}
	// stored, and within TTL retrievable
	if _, ok := p.store.get(id, now.Add(time.Minute)); !ok {
		t.Fatal("proposal not stored")
	}
}

func TestProposer_Propose_RejectsNonPositiveDebit(t *testing.T) {
	now := time.Date(2026, 6, 18, 15, 0, 0, 0, time.UTC)
	// invert quotes so long is cheaper than short → non-positive debit
	chain := twoLegChain()
	chain["NVDA250620C00130000"].Bid, chain["NVDA250620C00130000"].Ask = 1.0, 1.2
	chain["NVDA250620C00140000"].Bid, chain["NVDA250620C00140000"].Ask = 6.0, 6.4
	p := NewVerticalProposer(&fakeChainSource{chain: chain, spot: 130}, &fakeOpenGuard{}, newProposalStore())
	if _, _, err := p.Propose(context.Background(), "NVDA", CallDebit, time.Now(), 10.0, now); err == nil {
		t.Fatal("want non-positive-debit rejection, got nil")
	}
	if p.store.len() != 0 {
		t.Fatal("rejected propose must store nothing")
	}
}
```

Add `"context"` to the test imports.

- [ ] **Step 2: Run → FAIL** (`NewVerticalProposer` undefined): `go test ./services/ -run TestProposer_Propose -v`.

- [ ] **Step 3: Implement** (append to `services/prophet_vertical_proposals.go`; add imports `context`, `fmt`, `math`, `github.com/google/uuid` if used — otherwise build an id from `now.UnixNano()`):

```go
// chainSource supplies the option chain (as a symbol-keyed map) and the
// underlying spot used as the ATM long-leg target. Implemented in production by
// an adapter over the trading/data service.
type chainSource interface {
	ChainMap(ctx context.Context, underlying string, expiration time.Time) (map[string]*interfaces.OptionContract, error)
	Spot(ctx context.Context, underlying string) (float64, error)
}

// openGuard is the per-leg dry-run guard check (CheckOptionsOpen subset).
type openGuard interface {
	CheckOptionsOpen(agent AgentSource, underlying, symbol string, q *interfaces.OptionsQuote, now time.Time) error
}

// VerticalCard is the entry decision card (instructional approximation).
type VerticalCard struct {
	ProposalID    string  `json:"proposal_id"`
	Underlying    string  `json:"underlying"`
	Direction     string  `json:"direction"`
	Expiration    string  `json:"expiration"`
	DTE           int     `json:"dte"`
	LongSymbol    string  `json:"long_symbol"`
	ShortSymbol   string  `json:"short_symbol"`
	LongStrike    float64 `json:"long_strike"`
	ShortStrike   float64 `json:"short_strike"`
	Width         float64 `json:"width"`
	NetDebit      float64 `json:"net_debit"`       // per-contract
	MaxLossUSD    float64 `json:"max_loss_usd"`    // = net_debit * 100 * contracts
	Breakeven     float64 `json:"breakeven"`
	MaxProfitUSD  float64 `json:"max_profit_usd"`
	LongIV        float64 `json:"long_iv"`
	ShortIV       float64 `json:"short_iv"`
}

type VerticalProposer struct {
	src   chainSource
	guard openGuard
	store *proposalStore
}

func NewVerticalProposer(src chainSource, guard openGuard, store *proposalStore) *VerticalProposer {
	return &VerticalProposer{src: src, guard: guard, store: store}
}

func (p *VerticalProposer) Propose(ctx context.Context, underlying string, dir VerticalDirection, expiration time.Time, targetWidth float64, now time.Time) (string, VerticalCard, error) {
	p.store.sweep(now)
	chain, err := p.src.ChainMap(ctx, underlying, expiration)
	if err != nil {
		return "", VerticalCard{}, fmt.Errorf("propose: chain unavailable: %w", err)
	}
	spot, err := p.src.Spot(ctx, underlying)
	if err != nil || spot <= 0 {
		return "", VerticalCard{}, fmt.Errorf("propose: spot unavailable: %w", err)
	}
	long, short, ok := pickVerticalStrikes(chain, dir, spot, targetWidth)
	if !ok {
		return "", VerticalCard{}, fmt.Errorf("propose: no liquid %s strikes near %.2f width %.2f", dir, spot, targetWidth)
	}
	// Dry-run guard, both legs.
	for _, leg := range []*interfaces.OptionContract{long, short} {
		q := &interfaces.OptionsQuote{Symbol: leg.Symbol, BidPrice: leg.Bid, AskPrice: leg.Ask, Timestamp: now}
		if err := p.guard.CheckOptionsOpen(AgentMain, underlying, leg.Symbol, q, now); err != nil {
			return "", VerticalCard{}, fmt.Errorf("propose: guard blocked %s: %w", leg.Symbol, err)
		}
	}
	longMid, shortMid := (long.Bid+long.Ask)/2, (short.Bid+short.Ask)/2
	width := math.Abs(long.StrikePrice - short.StrikePrice)
	debit := verticalDebitLimit(longMid, shortMid, long.Ask-long.Bid, short.Ask-short.Bid, width, verticalLimitBufferFrac)
	if debit <= 0 {
		return "", VerticalCard{}, fmt.Errorf("propose: non-positive net debit %.2f at current quotes", debit)
	}
	if debit*100*float64(verticalContracts) > verticalDebitCapUSD {
		return "", VerticalCard{}, fmt.Errorf("propose: debit cap — $%.0f exceeds $%.0f", debit*100, verticalDebitCapUSD)
	}
	id := fmt.Sprintf("vp-%d", now.UnixNano())
	req := PlaceVerticalRequest{
		Underlying: underlying, Expiration: expiration, Direction: dir,
		LongSymbol: long.Symbol, LongStrike: long.StrikePrice,
		ShortSymbol: short.Symbol, ShortStrike: short.StrikePrice,
	}
	p.store.put(&verticalProposal{id: id, req: req, quotedDebit: debit, entryLong: long, entryShort: short}, now)
	card := VerticalCard{
		ProposalID: id, Underlying: underlying, Direction: string(dir),
		Expiration: expiration.Format("2006-01-02"), DTE: verticalDTE(expiration, now),
		LongSymbol: long.Symbol, ShortSymbol: short.Symbol,
		LongStrike: long.StrikePrice, ShortStrike: short.StrikePrice, Width: width,
		NetDebit: debit, MaxLossUSD: debit * 100 * float64(verticalContracts),
		Breakeven:    breakeven(dir, long.StrikePrice, debit),
		MaxProfitUSD: (width - debit) * 100 * float64(verticalContracts),
		LongIV:       long.ImpliedVolatility, ShortIV: short.ImpliedVolatility,
	}
	return id, card, nil
}

// breakeven for a debit vertical: long strike ± net debit (call up, put down).
func breakeven(dir VerticalDirection, longStrike, debit float64) float64 {
	if dir == CallDebit {
		return longStrike + debit
	}
	return longStrike - debit
}
```

> If `CallDebit`/`VerticalBearish` constant names differ, use the actual names from `services/prophet_vertical_structure.go` (Task references them; confirm by grep). `verticalDTE` is in `prophet_vertical_lifecycle.go` (same package).

- [ ] **Step 4: Run → PASS.** `go test ./services/ -run TestProposer_Propose -v`.

- [ ] **Step 5: Commit.**
```bash
git add services/prophet_vertical_proposals.go services/prophet_vertical_proposals_test.go
git commit -m "feat(prophet-vertical): VerticalProposer.Propose — snap+price+card+store (identity contract entry)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `VerticalProposer.ValidateForPlace` (TTL + drift)

**Files:** Modify `services/prophet_vertical_proposals.go`, `services/prophet_vertical_proposals_test.go`

`ValidateForPlace` is the place-side half of the identity contract: it looks up the stored proposal, rejects on TTL/missing, re-prices the **stored** legs, rejects on drift, and returns the stored `PlaceVerticalRequest` + the fresh debit (so the controller can compute the notional for the guards). It never snaps strikes.

- [ ] **Step 1: Failing test** (append):

```go
func TestProposer_ValidateForPlace(t *testing.T) {
	now := time.Date(2026, 6, 18, 15, 0, 0, 0, time.UTC)
	store := newProposalStore()
	src := &fakeChainSource{chain: twoLegChain(), spot: 130}
	p := NewVerticalProposer(src, &fakeOpenGuard{}, store)
	id, card, err := p.Propose(context.Background(), "NVDA", CallDebit, time.Now(), 10.0, now)
	if err != nil {
		t.Fatal(err)
	}

	// happy path: fresh quotes ≈ quoted → returns stored req + fresh debit
	req, fresh, err := p.ValidateForPlace(context.Background(), id, now.Add(time.Minute))
	if err != nil || req.LongSymbol != card.LongSymbol || fresh <= 0 {
		t.Fatalf("validate happy: err=%v req=%+v fresh=%v", err, req, fresh)
	}

	// expired
	if _, _, err := p.ValidateForPlace(context.Background(), id, now.Add(verticalProposalTTL+time.Second)); err == nil {
		t.Fatal("want TTL rejection")
	}

	// drift: re-propose, then move the market beyond tolerance
	id2, _, _ := p.Propose(context.Background(), "NVDA", CallDebit, time.Now(), 10.0, now)
	src.chain["NVDA250620C00130000"].Bid, src.chain["NVDA250620C00130000"].Ask = 12.0, 12.4 // long leg jumps → debit balloons
	if _, _, err := p.ValidateForPlace(context.Background(), id2, now.Add(time.Minute)); err == nil {
		t.Fatal("want debit-drift rejection")
	}
}
```

- [ ] **Step 2: Run → FAIL.** `go test ./services/ -run TestProposer_ValidateForPlace -v`.

- [ ] **Step 3: Implement** (append to `prophet_vertical_proposals.go`):

```go
// ValidateForPlace enforces the place-side identity contract: TTL + debit-drift
// against the STORED legs. Returns the stored request and the fresh per-contract
// debit (for the caller's notional/guard computation). Never snaps strikes.
func (p *VerticalProposer) ValidateForPlace(ctx context.Context, proposalID string, now time.Time) (PlaceVerticalRequest, float64, error) {
	prop, ok := p.store.get(proposalID, now)
	if !ok {
		return PlaceVerticalRequest{}, 0, fmt.Errorf("place: proposal expired or not found — re-propose")
	}
	long, err := p.src.ChainMap(ctx, prop.req.Underlying, prop.req.Expiration)
	if err != nil {
		return PlaceVerticalRequest{}, 0, fmt.Errorf("place: re-price chain unavailable: %w", err)
	}
	lc, okL := long[prop.req.LongSymbol]
	sc, okS := long[prop.req.ShortSymbol]
	if !okL || !okS {
		return PlaceVerticalRequest{}, 0, fmt.Errorf("place: stored legs no longer quoted")
	}
	width := math.Abs(prop.req.LongStrike - prop.req.ShortStrike)
	fresh := verticalDebitLimit((lc.Bid+lc.Ask)/2, (sc.Bid+sc.Ask)/2, lc.Ask-lc.Bid, sc.Ask-sc.Bid, width, verticalLimitBufferFrac)
	if prop.quotedDebit <= 0 { // defensive; propose guarantees >0
		return PlaceVerticalRequest{}, 0, fmt.Errorf("place: invalid quoted debit")
	}
	if math.Abs(fresh-prop.quotedDebit)/prop.quotedDebit > verticalDebitDriftTolerance {
		return PlaceVerticalRequest{}, 0, fmt.Errorf("place: net debit drifted — quoted %.2f, now %.2f (>%.0f%%)", prop.quotedDebit, fresh, verticalDebitDriftTolerance*100)
	}
	return prop.req, fresh, nil
}
```

- [ ] **Step 4: Run → PASS.** `go test ./services/ -run TestProposer -v` (Propose + Validate).

- [ ] **Step 5: Commit.**
```bash
git add services/prophet_vertical_proposals.go services/prophet_vertical_proposals_test.go
git commit -m "feat(prophet-vertical): ValidateForPlace — TTL + debit-drift on stored legs (identity contract exit)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: `executor.ListOpenVerticalsEnriched`

**Files:** Modify `services/prophet_vertical_executor.go`, `services/prophet_vertical_executor_test.go`

Lives on the executor because the valuation helpers (`verticalValue` at `:315`, `verticalDTE`) are unexported in-package. Returns open rows + live value/DTE so the controller (other package) needn't reach internals.

- [ ] **Step 1: Failing test.** Inspect the existing `prophet_vertical_executor_test.go` fakes (the executor is built with a fake ledger + chain in those tests). Add:

```go
func TestExecutor_ListOpenVerticalsEnriched(t *testing.T) {
	// Build an executor with a ledger holding one open row and a chain that
	// quotes both legs (reuse the existing test constructor/fakes in this file).
	// Assert: one EnrichedVertical back, with ID, DTE >= 0, and Value populated
	// when the chain quotes are present.
	// (Fill in using the file's existing openRow/fakeChain helpers.)
}
```

> Implementer: model this on the existing executor tests in the same file (they already construct a `ProphetVerticalExecutor` with fake ledger + chain and seed open rows). Assert the enriched slice length + that `verticalValue`/`verticalDTE` outputs are surfaced.

- [ ] **Step 2: Run → FAIL** (`ListOpenVerticalsEnriched` undefined).

- [ ] **Step 3: Implement** (append to `services/prophet_vertical_executor.go`):

```go
// EnrichedVertical is an open vertical plus live valuation for the list endpoint.
type EnrichedVertical struct {
	Row       *models.DBProphetVerticalSpread `json:"row"`
	Value     float64                         `json:"value"`
	ValueOK   bool                            `json:"value_ok"`
	DTE       int                             `json:"dte"`
}

// ListOpenVerticalsEnriched returns all open verticals with live value + DTE.
// Valuation failures (no quote) yield ValueOK=false rather than dropping the row.
func (e *ProphetVerticalExecutor) ListOpenVerticalsEnriched(ctx context.Context, now time.Time) ([]EnrichedVertical, error) {
	rows, err := e.ledger.ListOpen()
	if err != nil {
		return nil, err
	}
	out := make([]EnrichedVertical, 0, len(rows))
	for _, r := range rows {
		v, ok := e.verticalValue(ctx, r)
		out = append(out, EnrichedVertical{Row: r, Value: v, ValueOK: ok, DTE: verticalDTE(r.Expiration, now)})
	}
	return out, nil
}
```

> Confirm `DBProphetVerticalSpread` has an `Expiration time.Time` field (it should, from Phase 2); if the field name differs, use the actual one. `verticalValue`'s signature is `(ctx, *models.DBProphetVerticalSpread) (float64, bool)`.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit.**
```bash
git add services/prophet_vertical_executor.go services/prophet_vertical_executor_test.go
git commit -m "feat(prophet-vertical): ListOpenVerticalsEnriched — open book with live value + DTE

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: OrderController endpoints + `SetVerticals` + guard parity

**Files:** Modify `controllers/order_controller.go`; Create `controllers/order_controller_vertical_test.go`

The 4 handlers. `PlaceVertical` runs the **same opening guards single-legs get** (`CheckBuy` + `sleeveGuard.EvaluateOpen`) on the net-debit notional before `executor.Place`, then fires an immediate manage-tick.

- [ ] **Step 1: Add fields + setter.** In `controllers/order_controller.go`, add to the `OrderController` struct (after `sleeveGuard`):

```go
	verticalProposer *services.VerticalProposer
	verticalExec     *services.ProphetVerticalExecutor
	enableVerticals  bool
```

And the setter (after `SetSleeveGuard`):

```go
// SetVerticals wires the debit-vertical engine (Phase 3). enabled mirrors
// cfg.EnableProphetDebitVerticals; when false the endpoints reject.
func (oc *OrderController) SetVerticals(proposer *services.VerticalProposer, exec *services.ProphetVerticalExecutor, enabled bool) {
	oc.verticalProposer = proposer
	oc.verticalExec = exec
	oc.enableVerticals = enabled
}
```

- [ ] **Step 2: Failing handler test** (`controllers/order_controller_vertical_test.go`). Model gin setup on the existing controller tests (search the repo for `httptest.NewRecorder` + `gin.CreateTestContext` usage). Headline cases:

```go
package controllers

import (
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestVerticalEndpoints_FlagOffRejects(t *testing.T) {
	gin.SetMode(gin.TestMode)
	oc := &OrderController{} // enableVerticals defaults false
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest("POST", "/options/verticals/propose", nil)
	oc.ProposeVertical(c)
	if w.Code != 403 && w.Code != 404 {
		t.Fatalf("flag off: want reject, got %d", w.Code)
	}
}
```

> Add guard-parity cases once the place handler exists: inject a fake guard whose `CheckBuy` returns an error and assert `PlaceVertical` returns 422 **without** calling the executor; same for a sleeve-guard disarm. Use the proposer/executor fakes from the services tests via small local stubs, or assert at the services layer if controller wiring is awkward — but the guard-before-place ordering MUST be covered.

- [ ] **Step 3: Run → FAIL.**

- [ ] **Step 4: Implement the 4 handlers** (append to `controllers/order_controller.go`). Bind JSON bodies; `propose`/`place`/`close` are POST, `list` is GET.

```go
type proposeVerticalReq struct {
	Underlying  string  `json:"underlying" binding:"required"`
	Direction   string  `json:"direction" binding:"required"` // "call_debit"|"put_debit"
	Expiration  string  `json:"expiration" binding:"required"` // YYYY-MM-DD
	TargetWidth float64 `json:"target_width" binding:"required,gt=0"`
}

func (oc *OrderController) ProposeVertical(c *gin.Context) {
	if !oc.enableVerticals || oc.verticalProposer == nil {
		c.JSON(403, gin.H{"error": "debit verticals disabled"})
		return
	}
	var req proposeVerticalReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	exp, err := time.Parse("2006-01-02", req.Expiration)
	if err != nil {
		c.JSON(400, gin.H{"error": "expiration must be YYYY-MM-DD"})
		return
	}
	dir, err := services.ParseVerticalDirection(req.Direction) // add a tiny exported parser in services (Task 2 file)
	if err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	id, card, err := oc.verticalProposer.Propose(c.Request.Context(), req.Underlying, dir, exp, req.TargetWidth, time.Now())
	if err != nil {
		c.JSON(422, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"proposal_id": id, "card": card})
}

type placeVerticalReq struct {
	ProposalID string `json:"proposal_id" binding:"required"`
}

func (oc *OrderController) PlaceVertical(c *gin.Context) {
	if !oc.enableVerticals || oc.verticalProposer == nil || oc.verticalExec == nil {
		c.JSON(403, gin.H{"error": "debit verticals disabled"})
		return
	}
	var req placeVerticalReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	now := time.Now()
	vreq, freshDebit, err := oc.verticalProposer.ValidateForPlace(c.Request.Context(), req.ProposalID, now)
	if err != nil {
		c.JSON(422, gin.H{"error": err.Error()})
		return
	}
	notional := freshDebit * 100 * float64(services.VerticalContracts())
	// Account-level opening guards — parity with the single-leg path.
	if oc.guard != nil {
		if err := oc.guard.CheckBuy(c.Request.Context(), services.AgentMain, vreq.Underlying, notional); err != nil {
			c.JSON(422, gin.H{"error": err.Error()})
			return
		}
	}
	if oc.sleeveGuard != nil {
		if err := oc.sleeveGuard.EvaluateOpen(c.Request.Context(), notional, now); err != nil {
			c.JSON(422, gin.H{"error": err.Error()})
			return
		}
	}
	id, err := oc.verticalExec.Place(c.Request.Context(), vreq, now)
	if err != nil {
		c.JSON(422, gin.H{"error": err.Error()})
		return
	}
	oc.verticalExec.RunManageTick(c.Request.Context(), time.Now(), &services.VerticalTickResult{}) // immediate reconcile
	c.JSON(200, gin.H{"vertical_id": id})
}

func (oc *OrderController) ListVerticals(c *gin.Context) {
	if !oc.enableVerticals || oc.verticalExec == nil {
		c.JSON(403, gin.H{"error": "debit verticals disabled"})
		return
	}
	rows, err := oc.verticalExec.ListOpenVerticalsEnriched(c.Request.Context(), time.Now())
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"verticals": rows})
}

type closeVerticalReq struct {
	VerticalID string `json:"vertical_id" binding:"required"`
}

func (oc *OrderController) CloseVertical(c *gin.Context) {
	if !oc.enableVerticals || oc.verticalExec == nil {
		c.JSON(403, gin.H{"error": "debit verticals disabled"})
		return
	}
	var req closeVerticalReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	if err := oc.verticalExec.RequestClose(c.Request.Context(), req.VerticalID); err != nil {
		c.JSON(422, gin.H{"error": err.Error()})
		return
	}
	oc.verticalExec.RunManageTick(c.Request.Context(), time.Now(), &services.VerticalTickResult{})
	c.JSON(200, gin.H{"status": "close requested"})
}
```

This requires two tiny exported helpers in `services` (add in the Task 2 file): `func VerticalContracts() int { return verticalContracts }` and `func ParseVerticalDirection(s string) (VerticalDirection, error)` mapping `"call_debit"/"put_debit"` to the Phase-1 constants (`CallDebit`/`PutDebit`). Add them with unit tests in `prophet_vertical_proposals_test.go`.

- [ ] **Step 5: Run → PASS** the controller + services tests: `go test ./controllers/ ./services/ -run 'Vertical' -count=1`.

- [ ] **Step 6: Commit.**
```bash
git add controllers/order_controller.go controllers/order_controller_vertical_test.go services/prophet_vertical_proposals.go services/prophet_vertical_proposals_test.go
git commit -m "feat(prophet-vertical): 4 OrderController endpoints + SetVerticals + place-path guard parity

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

> **RunManageTick concurrency (spec verification item #6):** before committing, read `RunManageTick` / the scheduler. If it is NOT safe to call concurrently with the scheduler's own tick (shared mutable state without a lock), the immediate-tick calls must be removed here and the scheduler given a trigger channel instead — escalate as a DONE_WITH_CONCERNS if unsure rather than risk a data race.

---

## Task 6: `main.go` wiring + routes + final verification

**Files:** Modify `cmd/bot/main.go`

- [ ] **Step 1: Lift construction out of the flag-block.** Replace the `if cfg.EnableProphetDebitVerticals && tradingService != nil { … }` block (`main.go:443-460`) so the ledger/executor/store/proposer are built **unconditionally** (they are inert when unused), the scheduler is started **only** when the flag is on, and the controller is wired in all cases:

```go
	if tradingService != nil {
		verticalLedger := services.NewProphetVerticalLedger(storageService)
		verticalExecutor := services.NewProphetVerticalExecutor( /* same args as today */ )
		verticalProposer := services.NewVerticalProposer(
			services.NewChainSourceAdapter(tradingService), // adapter: ChainMap + Spot over the trading/data service
			tradeGuard, // *TradeGuard satisfies openGuard via CheckOptionsOpen
			services.NewProposalStore0(), // exported ctor, or move newProposalStore→exported
		)
		orderController.SetVerticals(verticalProposer, verticalExecutor, cfg.EnableProphetDebitVerticals)
		if cfg.EnableProphetDebitVerticals {
			verticalScheduler := services.NewProphetVerticalScheduler(verticalExecutor, services.VerticalTickInterval(), services.VerticalIdleInterval(), verticalMarketOpen, logger)
			go verticalScheduler.Start(ctx) // same start call as today
		}
	}
```

> Resolve the exact `NewProphetVerticalExecutor` args, the scheduler `Start` call, and `verticalMarketOpen` by reading the current `:443-460`. Add the small constructors: export `newProposalStore` (rename to `NewProposalStore` or add a thin exported wrapper) and write `NewChainSourceAdapter(tradingService)` implementing `chainSource` — `ChainMap` calls `GetOptionsChain` and converts `[]→map` keyed by `Symbol`; `Spot` calls the existing underlying-quote path (grep how single-leg options fetch the underlying mark, e.g. `GetQuote`). `*TradeGuard` already has `CheckOptionsOpen`, so it satisfies `openGuard` directly.

- [ ] **Step 2: Register the 4 routes.** After `main.go:660` (`api.GET("/options/chain/:symbol", …)`):

```go
		api.POST("/options/verticals/propose", orderController.ProposeVertical)
		api.POST("/options/verticals/place", orderController.PlaceVertical)
		api.GET("/options/verticals", orderController.ListVerticals)
		api.POST("/options/verticals/close", orderController.CloseVertical)
```

- [ ] **Step 3: Build + vet + full vertical/controller tests.**
```bash
go build ./...                       # whole repo, incl. cmd/bot
go vet ./services/ ./controllers/
go test ./services/ ./controllers/ -count=1
```
Expected: build exit 0; vet silent; tests `ok`.

- [ ] **Step 4: Commit.**
```bash
git add cmd/bot/main.go services/prophet_vertical_proposals.go
git commit -m "feat(prophet-vertical): wire Phase-3a engine into main.go + register 4 routes (flag-gated)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Done criteria (3a)

- `go build ./...`, `go vet ./services/ ./controllers/`, `go test ./services/ ./controllers/ -count=1` all green.
- With the flag OFF: all 4 endpoints 403; no behavior change. With it ON: propose→place enforces TTL + drift + the single-leg account guards (`CheckBuy` + `sleeveGuard.EvaluateOpen`) before `executor.Place`; `place` never re-snaps; list/close work; place/close fire an immediate manage-tick.
- The identity contract and guard-parity tests pass.
- **Next:** Phase 3b (Node) — 4 inline `mcp-server.js` tools proxying these endpoints + `ALL_TOOLS` + harness flag-gating. Then a live paper smoke test. Squash-merge 3a to local `main` after review.
