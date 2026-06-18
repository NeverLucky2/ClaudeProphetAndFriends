# Prophet Options Stop-Monitor — Ownership Scoping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `ProphetOptionsStopMonitor` flatten a long option only when it is positively attributable to Prophet's `v2-options` single-leg strategy and is not the long leg of a spread — so it stops breaking manual spreads (and never breaks Prophet's own verticals or DefensiveProphet's hedges).

**Architecture:** Two pure predicate gates compose into a new scoping function. **Gate A** (`attributedToProphetSingleLeg`) reads the broker order list the monitor already fetches each tick and requires a `v2-options`-tagged executed buy with no other-tagged buy for the contract. **Gate C** (`hasPairedShort`) uses an extended OCC parser to skip any long that has a same-`(underlying,expiration,type)` short in the account. `EvaluateTick` is reordered to fetch orders first, then scopes. The change is strictly more conservative (it only ever skips positions the old monitor flattened), so it ships with no feature flag.

**Tech Stack:** Go, `package services`; `logrus`; existing `interfaces.Order` / `interfaces.OptionsPosition` / `interfaces.ParseStrategyFromClientOrderID`; `go test`.

**Spec:** `docs/superpowers/specs/2026-06-17-prophet-options-stop-ownership-scoping-design.md`

---

## File Structure

- `services/occ.go` — **modify**: add pure `ParseOCC` (underlying + expiration + type), reusing `IsOptionSymbol`.
- `services/occ_test.go` — **modify**: add `TestParseOCC`.
- `services/prophet_options_stop_monitor.go` — **modify**: add `isExecutedBuy`, `attributedToProphetSingleLeg`, `hasPairedShort`, `scopeEligibleLongs`; reorder `EvaluateTick` (orders-first) to call `scopeEligibleLongs`; delete the old `prophetPositions`.
- `services/prophet_options_stop_monitor_test.go` — **modify**: add `v2OptionsFilledBuy` helper + `ordersErr` field; replace the scoping test; seed a `v2-options` buy in the 9 flatten-expecting tests; add the new skip/Gate-C/error integration tests.
- `services/prophet_vertical_constants.go` — **modify**: correct the stale stop-monitor-exclusion comment (lines 9-11).

All work happens in the worktree `.claude/worktrees/prophet-options-stop-ownership-scoping` (branch `prophet-options-stop-ownership-scoping`). Run all commands from that directory.

---

## Task 1: `ParseOCC` — full OCC symbol parser

**Files:**
- Modify: `services/occ.go`
- Test: `services/occ_test.go`

- [ ] **Step 1: Write the failing test**

Add to `services/occ_test.go`:

```go
func TestParseOCC(t *testing.T) {
	cases := []struct {
		in    string
		under string
		exp   string
		typ   byte
		ok    bool
	}{
		{"TSLA251219C00400000", "TSLA", "251219", 'C', true},
		{"NVDA250620P00130000", "NVDA", "250620", 'P', true},
		{"SPY250620C00500000", "SPY", "250620", 'C', true},
		{"QQQ", "", "", 0, false},    // bare ticker
		{"", "", "", 0, false},       // empty
		{"NVDA_C", "", "", 0, false}, // toy / non-OCC
	}
	for _, c := range cases {
		under, exp, typ, ok := ParseOCC(c.in)
		if ok != c.ok || under != c.under || exp != c.exp || typ != c.typ {
			t.Errorf("ParseOCC(%q) = (%q,%q,%q,%v), want (%q,%q,%q,%v)",
				c.in, under, exp, string(typ), ok, c.under, c.exp, string(c.typ), c.ok)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/ -run TestParseOCC -v`
Expected: FAIL — `undefined: ParseOCC`.

- [ ] **Step 3: Write minimal implementation**

Add to `services/occ.go`:

```go
// ParseOCC splits an OCC option symbol (ROOT + YYMMDD + C/P + 8-digit strike)
// into its parts. ok is false for non-option symbols; it delegates the format
// check to IsOptionSymbol so the two stay in lockstep. The strike tail is not
// returned (Gate C does not need it).
func ParseOCC(symbol string) (underlying, expiration string, optType byte, ok bool) {
	if !IsOptionSymbol(symbol) {
		return "", "", 0, false
	}
	root := ParseOCCUnderlying(symbol)
	rest := symbol[len(root):] // root is ASCII, so byte-len == rune-count
	return root, rest[0:6], rest[6], true
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./services/ -run 'TestParseOCC|TestParseOCCUnderlying|TestIsOptionSymbol' -v`
Expected: PASS (all three).

- [ ] **Step 5: Commit**

```bash
git add services/occ.go services/occ_test.go
git commit -m "feat(occ): ParseOCC — underlying+expiration+type, reusing IsOptionSymbol

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Gate A — `isExecutedBuy` + `attributedToProphetSingleLeg`

**Files:**
- Modify: `services/prophet_options_stop_monitor.go`
- Test: `services/prophet_options_stop_monitor_test.go`

- [ ] **Step 1: Write the failing test**

Add to `services/prophet_options_stop_monitor_test.go`:

```go
func TestAttributedToProphetSingleLeg(t *testing.T) {
	sym := "NVDA250620C00130000"
	buy := func(tag, status string, qty float64) *interfaces.Order {
		return &interfaces.Order{Symbol: sym, Side: "buy", Status: status, FilledQty: qty, ClientOrderID: tag}
	}
	cases := []struct {
		name   string
		orders []*interfaces.Order
		want   bool
	}{
		{"lone v2-options filled buy (qty)", []*interfaces.Order{buy("v2-options:a", "filled", 1)}, true},
		{"v2-options filled-status, qty unset", []*interfaces.Order{buy("v2-options:a", "filled", 0)}, true},
		{"v2-options + manual (untagged) buy", []*interfaces.Order{buy("v2-options:a", "filled", 1), buy("manual-uuid", "filled", 1)}, false},
		{"only v2-vertical buy", []*interfaces.Order{buy("v2-vertical:a", "filled", 1)}, false},
		{"only prophet-defensive buy", []*interfaces.Order{buy("prophet-defensive:a", "filled", 1)}, false},
		{"no buys", []*interfaces.Order{}, false},
		{"v2-options SELL only (no buy)", []*interfaces.Order{{Symbol: sym, Side: "sell", Status: "filled", FilledQty: 1, ClientOrderID: "v2-options:a"}}, false},
		{"unfilled v2-options buy (working)", []*interfaces.Order{buy("v2-options:a", "new", 0)}, false},
		{"different symbol v2-options buy", []*interfaces.Order{{Symbol: "AAPL250620C00200000", Side: "buy", Status: "filled", FilledQty: 1, ClientOrderID: "v2-options:a"}}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := attributedToProphetSingleLeg(sym, c.orders); got != c.want {
				t.Fatalf("got %v, want %v", got, c.want)
			}
		})
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/ -run TestAttributedToProphetSingleLeg -v`
Expected: FAIL — `undefined: attributedToProphetSingleLeg`.

- [ ] **Step 3: Write minimal implementation**

Add to `services/prophet_options_stop_monitor.go` (near the other free functions, e.g. after `lossFraction`):

```go
// isExecutedBuy reports whether o is a buy that actually acquired contracts:
// any positive filled qty, or a filled/partially_filled status (real broker
// fills always carry both; some fixtures set only the status). Working/unfilled
// buys do not count.
func isExecutedBuy(o *interfaces.Order) bool {
	if o.Side != "buy" {
		return false
	}
	return o.FilledQty > 0 || o.Status == "filled" || o.Status == "partially_filled"
}

// attributedToProphetSingleLeg reports whether symbol is positively attributable
// to Prophet's v2-options single-leg strategy: among executed buys for the exact
// OCC contract, at least one is tagged v2-options and none is tagged anything
// else. Fails closed when no executed buy is found (aged out / sells only) and
// when any other-tagged buy contaminates ownership (manual, v2-vertical,
// prophet-defensive, …). Prophet single-leg never buys-to-close, so a v2-options
// buy is always an open.
func attributedToProphetSingleLeg(symbol string, orders []*interfaces.Order) bool {
	sawV2Options := false
	for _, o := range orders {
		if o.Symbol != symbol || !isExecutedBuy(o) {
			continue
		}
		if interfaces.ParseStrategyFromClientOrderID(o.ClientOrderID) == prophetStrategyID {
			sawV2Options = true
		} else {
			return false
		}
	}
	return sawV2Options
}
```

(`prophetStrategyID == "v2-options"` is already defined at the top of this file.)

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./services/ -run TestAttributedToProphetSingleLeg -v`
Expected: PASS (all sub-cases).

- [ ] **Step 5: Commit**

```bash
git add services/prophet_options_stop_monitor.go services/prophet_options_stop_monitor_test.go
git commit -m "feat(prophet-stop): Gate A — v2-options order-tag attribution predicate

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Gate C — `hasPairedShort`

**Files:**
- Modify: `services/prophet_options_stop_monitor.go`
- Test: `services/prophet_options_stop_monitor_test.go`

- [ ] **Step 1: Write the failing test**

Add to `services/prophet_options_stop_monitor_test.go`:

```go
func TestHasPairedShort(t *testing.T) {
	longCall := "NVDA250620C00130000"
	shortCallSameClass := &interfaces.OptionsPosition{Symbol: "NVDA250620C00140000", Side: "short"}
	shortPutSameExp := &interfaces.OptionsPosition{Symbol: "NVDA250620P00120000", Side: "short"} // opposite type
	shortCallOtherExp := &interfaces.OptionsPosition{Symbol: "NVDA250718C00140000", Side: "short"}
	longSelf := &interfaces.OptionsPosition{Symbol: longCall, Side: "long"}

	cases := []struct {
		name string
		all  []*interfaces.OptionsPosition
		want bool
	}{
		{"same underlying+exp+type short", []*interfaces.OptionsPosition{longSelf, shortCallSameClass}, true},
		{"opposite type short", []*interfaces.OptionsPosition{longSelf, shortPutSameExp}, false},
		{"same type other expiration", []*interfaces.OptionsPosition{longSelf, shortCallOtherExp}, false},
		{"no short", []*interfaces.OptionsPosition{longSelf}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := hasPairedShort(longCall, c.all); got != c.want {
				t.Fatalf("got %v, want %v", got, c.want)
			}
		})
	}
	// Unparseable long symbol contributes no pairing.
	if hasPairedShort("NVDA_C", []*interfaces.OptionsPosition{{Symbol: "NVDA_C", Side: "short"}}) {
		t.Fatal("unparseable long symbol must not match")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/ -run TestHasPairedShort -v`
Expected: FAIL — `undefined: hasPairedShort`.

- [ ] **Step 3: Write minimal implementation**

Add to `services/prophet_options_stop_monitor.go`:

```go
// hasPairedShort reports whether the account holds a short option leg on the
// same (underlying, expiration, option-type) as longSymbol — i.e. longSymbol is
// the long leg of a vertical/spread. Only a positively-parsed, positively-
// matched short returns true; an unparseable symbol on either side contributes
// no pairing (Gate C must add a skip only on a positively found pair, never on
// uncertainty).
func hasPairedShort(longSymbol string, all []*interfaces.OptionsPosition) bool {
	lu, le, lt, ok := ParseOCC(longSymbol)
	if !ok {
		return false
	}
	for _, p := range all {
		if p.Side != "short" {
			continue
		}
		if su, se, st, ok := ParseOCC(p.Symbol); ok && su == lu && se == le && st == lt {
			return true
		}
	}
	return false
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./services/ -run TestHasPairedShort -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/prophet_options_stop_monitor.go services/prophet_options_stop_monitor_test.go
git commit -m "feat(prophet-stop): Gate C — structural paired-short backstop predicate

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: `scopeEligibleLongs` scoping function (composes A + C)

**Files:**
- Modify: `services/prophet_options_stop_monitor.go`
- Test: `services/prophet_options_stop_monitor_test.go`

- [ ] **Step 1: Write the failing test**

Add the shared helper and the unit test to `services/prophet_options_stop_monitor_test.go`:

```go
// v2OptionsFilledBuy is a stale, filled v2-options opening buy for sym — it
// satisfies Gate A attribution without tripping the cool-off (timestamp far in
// the past relative to the tests' "now").
func v2OptionsFilledBuy(sym string) *interfaces.Order {
	return &interfaces.Order{
		ID: "open-" + sym, Symbol: sym, Side: "buy", Status: "filled", FilledQty: 10,
		ClientOrderID: "v2-options:open-" + sym,
		SubmittedAt:   time.Date(2026, 5, 1, 14, 0, 0, 0, time.UTC),
	}
}

func TestMonitor_ScopeEligibleLongs(t *testing.T) {
	attributed := "NVDA250620C00130000"
	all := []*interfaces.OptionsPosition{
		longPos(attributed, 1, 5, 2, 500, -300),                                      // v2-options long → eligible
		{Symbol: "SPY250620C00500000", Qty: -10, Side: "short", CostBasis: -500},     // short → never eligible
		longPos("AMZN250620C00200000", 1, 5, 2, 500, -300),                           // long but unattributed (no order)
	}
	orders := []*interfaces.Order{v2OptionsFilledBuy(attributed)}
	m := newTestMonitor(&fakeOptPositions{}, &fakeQuoter{}, &recordingFlattener{})

	got := m.scopeEligibleLongs(all, orders)
	if len(got) != 1 || got[0].Symbol != attributed {
		t.Fatalf("got %v, want only [%s]", symsOf(got), attributed)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/ -run TestMonitor_ScopeEligibleLongs -v`
Expected: FAIL — `undefined: m.scopeEligibleLongs`.

- [ ] **Step 3: Write minimal implementation**

Add to `services/prophet_options_stop_monitor.go` (this does NOT yet replace `prophetPositions` — wiring happens in Task 5):

```go
// scopeEligibleLongs returns the long single-leg positions the monitor may
// flatten: those positively attributed to Prophet's v2-options strategy
// (Gate A) that are not the long leg of a spread (Gate C). Shorts are never
// eligible. A long dropped while already past the stop threshold is logged once
// (skipped_unowned, naming the gate) so the monitor visibly declines a
// non-Prophet / spread leg and a systemic attribution failure stays observable.
func (m *ProphetOptionsStopMonitor) scopeEligibleLongs(all []*interfaces.OptionsPosition, orders []*interfaces.Order) []*interfaces.OptionsPosition {
	var out []*interfaces.OptionsPosition
	for _, p := range all {
		if p.Side != "long" {
			continue
		}
		gate := ""
		switch {
		case !attributedToProphetSingleLeg(p.Symbol, orders):
			gate = "A:attribution"
		case hasPairedShort(p.Symbol, all):
			gate = "C:paired-short"
		}
		if gate != "" {
			if frac, ok := lossFraction(p); ok && frac >= m.cfg.StopPct {
				m.logger.WithFields(logrus.Fields{
					"symbol": p.Symbol, "gate": gate, "loss_fraction": frac,
				}).Warn("prophet_options_stop_skipped_unowned")
			}
			continue
		}
		out = append(out, p)
	}
	return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./services/ -run TestMonitor_ScopeEligibleLongs -v`
Expected: PASS.

- [ ] **Step 5: Run the whole package to confirm no regressions yet**

Run: `go test ./services/ -run TestMonitor -count=1`
Expected: PASS (old `prophetPositions` + `TestMonitor_Scoping_ExcludesShorts` still intact; new function is additive).

- [ ] **Step 6: Commit**

```bash
git add services/prophet_options_stop_monitor.go services/prophet_options_stop_monitor_test.go
git commit -m "feat(prophet-stop): scopeEligibleLongs — compose Gate A + Gate C + skip log

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Wire `EvaluateTick` (orders-first), migrate tests, delete `prophetPositions`

**Files:**
- Modify: `services/prophet_options_stop_monitor.go`
- Test: `services/prophet_options_stop_monitor_test.go`

- [ ] **Step 1: Add the `ordersErr` test field + new integration tests (these fail first)**

In `services/prophet_options_stop_monitor_test.go`, add `errors` to the import block, add an `ordersErr` field to `recordingFlattener`, and make `ListOrders` return it:

```go
// in the import block:
//   "errors"

// add field to recordingFlattener:
//   ordersErr error

func (f *recordingFlattener) ListOrders(_ context.Context, _ string) ([]*interfaces.Order, error) {
	return f.orders, f.ordersErr
}
```

Then add the integration tests:

```go
func TestMonitor_SkipsUnattributedManualLong(t *testing.T) {
	now := time.Date(2026, 5, 21, 15, 0, 0, 0, time.UTC)
	pos := &fakeOptPositions{positions: []*interfaces.OptionsPosition{
		longPos("NVDA250620C00130000", 1, 5, 2, 500, -300), // down 60%, past stop
	}}
	q := &fakeQuoter{snaps: map[string]*interfaces.OptionContract{"NVDA250620C00130000": snap(1.90, 2.10)}}
	fl := &recordingFlattener{orders: []*interfaces.Order{
		{ID: "manual1", Symbol: "NVDA250620C00130000", Side: "buy", Status: "filled", FilledQty: 1,
			ClientOrderID: "manual-uuid", SubmittedAt: now.Add(-48 * time.Hour)}, // untagged → unattributed
	}}
	m := newTestMonitor(pos, q, fl)
	m.SetBeatObserver(beatObserved(now.Add(-time.Minute)))
	m.EvaluateTick(context.Background(), now)
	if len(fl.placed) != 0 {
		t.Fatalf("manual (unattributed) long must NOT be flattened, got %d placements", len(fl.placed))
	}
}

func TestMonitor_SkipsVerticalLeg(t *testing.T) {
	now := time.Date(2026, 5, 21, 15, 0, 0, 0, time.UTC)
	longSym, shortSym := "NVDA250620C00130000", "NVDA250620C00140000"
	pos := &fakeOptPositions{positions: []*interfaces.OptionsPosition{
		longPos(longSym, 1, 5, 2, 500, -300),
		{Symbol: shortSym, Qty: -1, Side: "short", CostBasis: -200},
	}}
	q := &fakeQuoter{snaps: map[string]*interfaces.OptionContract{longSym: snap(1.90, 2.10)}}
	fl := &recordingFlattener{orders: []*interfaces.Order{
		{ID: "v1", Symbol: longSym, Side: "buy", Status: "filled", FilledQty: 1,
			ClientOrderID: "v2-vertical:abc", SubmittedAt: now.Add(-48 * time.Hour)},
	}}
	m := newTestMonitor(pos, q, fl)
	m.SetBeatObserver(beatObserved(now.Add(-time.Minute)))
	m.EvaluateTick(context.Background(), now)
	if len(fl.placed) != 0 {
		t.Fatalf("vertical long leg must NOT be flattened, got %d placements", len(fl.placed))
	}
}

func TestMonitor_GateC_SkipsAttributedLongWithPairedShort(t *testing.T) {
	now := time.Date(2026, 5, 21, 15, 0, 0, 0, time.UTC)
	longSym, shortSym := "NVDA250620C00130000", "NVDA250620C00140000"
	pos := &fakeOptPositions{positions: []*interfaces.OptionsPosition{
		longPos(longSym, 1, 5, 2, 500, -300),
		{Symbol: shortSym, Qty: -1, Side: "short", CostBasis: -200},
	}}
	q := &fakeQuoter{snaps: map[string]*interfaces.OptionContract{longSym: snap(1.90, 2.10)}}
	fl := &recordingFlattener{orders: []*interfaces.Order{v2OptionsFilledBuy(longSym)}} // Gate A PASSES
	m := newTestMonitor(pos, q, fl)
	m.SetBeatObserver(beatObserved(now.Add(-time.Minute)))
	m.EvaluateTick(context.Background(), now)
	if len(fl.placed) != 0 {
		t.Fatalf("attributed long with a same-class short must be skipped by Gate C, got %d", len(fl.placed))
	}
}

func TestMonitor_GateC_FlattensAttributedLongWithoutPair(t *testing.T) {
	now := time.Date(2026, 5, 21, 15, 0, 0, 0, time.UTC)
	longSym := "NVDA250620C00130000"
	pos := &fakeOptPositions{positions: []*interfaces.OptionsPosition{longPos(longSym, 1, 5, 2, 500, -300)}}
	q := &fakeQuoter{snaps: map[string]*interfaces.OptionContract{longSym: snap(1.90, 2.10)}}
	fl := &recordingFlattener{orders: []*interfaces.Order{v2OptionsFilledBuy(longSym)}}
	m := newTestMonitor(pos, q, fl)
	m.SetBeatObserver(beatObserved(now.Add(-time.Minute)))
	m.EvaluateTick(context.Background(), now)
	if len(fl.placed) != 1 {
		t.Fatalf("attributed long with no paired short must flatten, got %d", len(fl.placed))
	}
}

func TestMonitor_ListOrdersError_SkipsTick(t *testing.T) {
	now := time.Date(2026, 5, 21, 15, 0, 0, 0, time.UTC)
	pos := &fakeOptPositions{positions: []*interfaces.OptionsPosition{
		longPos("NVDA250620C00130000", 1, 5, 2, 500, -300),
	}}
	q := &fakeQuoter{snaps: map[string]*interfaces.OptionContract{"NVDA250620C00130000": snap(1.90, 2.10)}}
	fl := &recordingFlattener{ordersErr: errors.New("boom")}
	m := newTestMonitor(pos, q, fl)
	m.SetBeatObserver(beatObserved(now.Add(-time.Minute)))
	m.EvaluateTick(context.Background(), now)
	if len(fl.placed) != 0 {
		t.Fatalf("ListOrders error must skip the whole tick, got %d placements", len(fl.placed))
	}
}
```

- [ ] **Step 2: Run the new integration tests to verify they fail**

Run: `go test ./services/ -run 'TestMonitor_SkipsUnattributedManualLong|TestMonitor_SkipsVerticalLeg|TestMonitor_GateC|TestMonitor_ListOrdersError' -v`
Expected: the three **skip** tests FAIL red-first — `TestMonitor_SkipsUnattributedManualLong`, `TestMonitor_SkipsVerticalLeg`, `TestMonitor_GateC_SkipsAttributedLongWithPairedShort` — because the old `prophetPositions` flattens every long (1 placement, want 0). The two **guard** tests already PASS against old code and must stay green: `TestMonitor_GateC_FlattensAttributedLongWithoutPair` (old code flattens it too) and `TestMonitor_ListOrdersError_SkipsTick` (old code also skips when `ListOrders` errors, just after fetching positions). They guard the positive-flatten and fail-safe paths against the rewire. (The `ordersErr`/`errors` references compile once the field + import from Step 1 are in.)

- [ ] **Step 3: Rewire `EvaluateTick` and delete `prophetPositions`**

In `services/prophet_options_stop_monitor.go`, **delete** the entire `prophetPositions` method (currently `:123-139`). Then change the top of `EvaluateTick` (currently `:320-329`) from:

```go
	positions, err := m.prophetPositions(ctx)
	if err != nil {
		m.logger.WithError(err).Warn("prophet_options_stop: scoping failed; skipping tick")
		return
	}
	orders, err := m.flattener.ListOrders(ctx, "all")
	if err != nil {
		m.logger.WithError(err).Warn("prophet_options_stop: list orders failed; skipping tick")
		return
	}
```

to (orders first — now load-bearing for attribution):

```go
	orders, err := m.flattener.ListOrders(ctx, "all")
	if err != nil {
		m.logger.WithError(err).Warn("prophet_options_stop: list orders failed; skipping tick")
		return
	}
	all, err := m.positions.ListOptionsPositions(ctx)
	if err != nil {
		m.logger.WithError(err).Warn("prophet_options_stop: scoping failed; skipping tick")
		return
	}
	positions := m.scopeEligibleLongs(all, orders)
```

The rest of `EvaluateTick` (the `for _, p := range positions` loop, cool-off, stuck-exit) is unchanged.

- [ ] **Step 4: Migrate the existing flatten-expecting tests (seed a `v2-options` buy)**

Each of these tests has an underwater long but no `v2-options` opening buy, so Gate A would now skip it. Add `v2OptionsFilledBuy("NVDA_C")` to each one's `recordingFlattener.orders` so the test still exercises its real intent. For tests that build `fl := &recordingFlattener{}`, change to `fl := &recordingFlattener{orders: []*interfaces.Order{v2OptionsFilledBuy("NVDA_C")}}`. For tests that already have an `orders:` slice (the ones with a working `v2-options-stop` sell), **append** `v2OptionsFilledBuy("NVDA_C")` to that slice.

Tests to update (all in `prophet_options_stop_monitor_test.go`):
- `TestMonitor_PlacesRung0OnTrigger` — `fl := &recordingFlattener{}` → seed.
- `TestMonitor_NoDoubleSendWhenWorkingOrderExists` — append to existing `orders`.
- `TestMonitor_EscalatesAfterWindow_CancelConfirmThenWideLimit` — append.
- `TestMonitor_EscalationSizesAgainstRemainingQty` — append.
- `TestMonitor_SanityFloorRestsWhenBidBelowFloor` — append.
- `TestMonitor_CancelNotConfirmed_NoReplacement` — append.
- `TestMonitor_GraceSuppressesUntilBeatObserved` — `fl := &recordingFlattener{}` → seed.
- `TestMonitor_NoBeatObserverMeansGraceOff` — `fl := &recordingFlattener{}` → seed.
- `TestMonitor_MonitorOwnFlattenDoesNotTripCooloff` — append.

> Note: the two cool-off tests (`TestMonitor_CooloffSuppressesWhenLLMActedRecently`, `TestMonitor_CooloffStaleActionDoesNotSuppress`) already seed a `v2-options` filled buy, so they satisfy Gate A as-is — **do not** change them. `TestMonitor_StartTicksWhileOpenAndStops` (no positions) and `TestMonitor_LossFraction` are untouched.

- [ ] **Step 5: Delete the obsolete scoping test**

Remove `TestMonitor_Scoping_ExcludesShorts` (`:80`) — it called the deleted `prophetPositions`; its coverage (shorts excluded) is now in `TestMonitor_ScopeEligibleLongs` from Task 4.

- [ ] **Step 6: Run the full monitor suite**

Run: `go test ./services/ -run 'TestMonitor|TestAttributed|TestHasPairedShort' -count=1 -v`
Expected: PASS — all migrated flatten tests, the new skip/Gate-C/error tests, and the predicates.

- [ ] **Step 7: Commit**

```bash
git add services/prophet_options_stop_monitor.go services/prophet_options_stop_monitor_test.go
git commit -m "feat(prophet-stop): scope EvaluateTick to owned single-legs (Gate A+C); fail-safe orders-first

Replaces prophetPositions (flattened every long) with scopeEligibleLongs.
Fixes the bug that sold the long leg of a manual spread. Migrates flatten
tests to seed a v2-options opening buy; adds skip / Gate-C / ListOrders-error
integration coverage.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Correct the stale comment + final verification

**Files:**
- Modify: `services/prophet_vertical_constants.go`

- [ ] **Step 1: Fix the comment**

In `services/prophet_vertical_constants.go`, replace the lines (`:9-11`):

```go
	verticalStrategyTag = "v2-vertical" // distinct from "v2-options" so the
	// options stop monitor ignores vertical legs (it filters on exactly
	// "v2-options") and broker reconciliation attributes combos correctly.
```

with:

```go
	verticalStrategyTag = "v2-vertical" // distinct from "v2-options" so the
	// options stop monitor never flattens a vertical leg: its scoping requires
	// positive "v2-options" attribution (Gate A in prophet_options_stop_monitor.go)
	// and skips any long whose opening buy is tagged otherwise; the structural
	// paired-short backstop (Gate C) catches the leg too. Broker reconciliation
	// also attributes combos correctly by this tag.
```

- [ ] **Step 2: Build, vet, format, full package test**

Run:
```bash
go build ./services/ ./interfaces/ ./cmd/bot/   # cmd/bot is the wiring site (NewProphetOptionsStopMonitor/Start)
go vet ./services/
gofmt -l services/occ.go services/prophet_options_stop_monitor.go services/prophet_vertical_constants.go
go test ./services/ -count=1
```
Expected: build clean (exit 0, incl. `cmd/bot`); vet silent; `gofmt -l` prints nothing (all formatted); `go test ./services/` → `ok`.

- [ ] **Step 3: Commit**

```bash
git add services/prophet_vertical_constants.go
git commit -m "docs(prophet-vertical): correct stop-monitor exclusion comment to match Gate A+C

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Done criteria

- `go test ./services/ -count=1` passes; `go vet ./services/` and `gofmt -l` clean.
- The monitor flattens only `v2-options`-attributed, non-spread long legs; manual / `v2-vertical` / `prophet-defensive` legs are skipped.
- No new flag, no migration. Deploy = Go rebuild + bot restart.
- Squash-merge the branch to local `main` (one commit per the per-backlog-item convention) after a final review.
