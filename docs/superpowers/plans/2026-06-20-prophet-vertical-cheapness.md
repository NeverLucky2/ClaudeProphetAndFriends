# Prophet Vertical Cheapness (Pure Module) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a pure `assessVerticalCheapness` function that scores a Prophet debit vertical as cheap / fair / rich at entry from two no-history signals — the vertical's vol skew (sell-leg IV vs buy-leg IV) and the long leg's IV-to-realized-vol ratio — emitting a teaching label.

**Architecture:** One new pure function + one result struct in a brand-new file in the existing `services` package, mirroring the pure-function, no-I/O style of `services/prophet_vertical_structure.go` (`verticalEconomics`, `pickVerticalStrikes`). Thresholds are local unexported `const`s in the new file — deliberately NOT added to the in-flight `services/prophet_vertical_constants.go` — so this work adds two files and **edits none**, and therefore cannot collide with the concurrent Phase-3 executor/scheduler churn. Tests live alongside in the same package and reuse the package-level `almostEqual` helper already defined in `prophet_vertical_structure_test.go`.

**Tech Stack:** Go 1.26 (module `prophet-trader`), standard-library `fmt` only, `go test` with the standard `testing` package.

## Global Constraints

- **Add new files only; edit none.** Create exactly `services/prophet_vertical_cheapness.go` and `services/prophet_vertical_cheapness_test.go`. Do not modify `prophet_vertical_constants.go`, `prophet_vertical_proposals.go`, `models/prophet_vertical_models.go`, or any other existing file.
- **Package:** `services` (same package as the files it mirrors).
- **Purity:** no I/O, no clock, no globals, no goroutines. Inputs are `float64` IVs and a `VerticalDirection`; output is a value struct.
- **Reuse the existing type:** use the package's existing `VerticalDirection` type and its `CallDebit` / `PutDebit` constants (defined in `prophet_vertical_structure.go`). Do **not** redeclare them.
- **Do NOT redefine `almostEqual`** — it is already declared at package scope in `prophet_vertical_structure_test.go` (`func almostEqual(a, b, eps float64) bool`). Redeclaring it is a compile error. Use it directly.
- **Vol units:** all implied/realized vols are decimals (`0.30` == 30% vol). `SkewDiff` is in vol points; `IVtoRV` is a dimensionless ratio.
- **Thresholds are local unexported consts** in the new `.go` file, each with a one-line doc comment (pre-registered teaching-toy values for the paper phase).
- **Function is unexported** (`assessVerticalCheapness`), like `pickVerticalStrikes`; the struct `VerticalCheapness` is exported (fields used by a later phase's card/model), like `VerticalStructure`.
- **Commit convention:** conventional commits scoped `feat(prophet-vertical): ...`; end every commit message body with the `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer.

## Out of Scope (deferred — do NOT build here)

These are documented for a future phase and must not appear in this plan's changes:
- The call site (wiring `assessVerticalCheapness` in after `pickVerticalStrikes` in `prophet_vertical_proposals.go`, passing `long.ImpliedVolatility` / `short.ImpliedVolatility` + an injected realized-vol).
- Any new field on `VerticalCard` or `PlaceVerticalRequest`.
- Any new persisted model columns (e.g. `EntrySkewDiff` / `EntryIVtoRV`).
- The dashboard teaching card.

## Decision Semantics (the spec this module implements)

Two signals, combined into one verdict:

**1. Skew** — `SkewDiff = shortIV − longIV` (vol you SELL minus vol you BUY). The short leg is the sold leg in both directions, so this is direction-agnostic in the math. `SkewDiff ≥ 0` means you sell at least as rich a vol as you buy → structurally cheaper vertical.
- `SkewDiff ≥ -skewVolTol` → **favorable** (flat-or-positive skew; the Barclays "flat skew favors call spreads" regime).
- `SkewDiff < -skewVolTol` → **steep** (normal negative skew on the sold side; you sell cheaper vol than you buy → structurally expensive).

**2. VRP (only when realized vol is supplied)** — `IVtoRV = longIV / realizedVol` (are you overpaying for the net-long vega?).
- Available only when `realizedVol > 0` **and** `longIV > 0` (`HasIVtoRV`). Otherwise the read falls back to skew alone.
- `IVtoRV ≤ ivToRvCheapMax` → not overpaying (**cheap-vol**).
- `IVtoRV ≥ ivToRvRichMin` → clearly overpaying (**rich-vol / overpaying**).
- between → neutral.

**Verdict** (evaluated in this order — first match wins):
1. **steep skew** → `rich` (structural skew dominates; even cheap vol can't save it).
2. else **overpaying** (`HasIVtoRV && IVtoRV ≥ ivToRvRichMin`) → `rich` (IV≫RV).
3. else **no RV** (`!HasIVtoRV`) → `cheap` (favorable skew, skew-only read).
4. else **cheap-vol** (`IVtoRV ≤ ivToRvCheapMax`) → `cheap` (favorable skew + IV≤RV).
5. else (favorable skew + neutral VRP) → `fair`.

**Honest limitation (document in the struct doc-comment):** with no historical IV surface this is an *absolute*-threshold read, not a regime-relative one.

**Thresholds (pre-registered):**
- `skewVolTol = 0.01` (1 vol point flat-band tolerance)
- `ivToRvCheapMax = 1.10`
- `ivToRvRichMin = 1.30`

---

### Task 1: Numeric core — struct + SkewDiff + IVtoRV

Build `VerticalCheapness` and the half of `assessVerticalCheapness` that computes the three numeric fields (`SkewDiff`, `HasIVtoRV`, `IVtoRV`). `Label` is left empty (`""`) in this task — it is filled in Task 2. This isolates the arithmetic (independently correct and reviewable) from the verdict logic.

**Files:**
- Create: `services/prophet_vertical_cheapness.go`
- Test: `services/prophet_vertical_cheapness_test.go`

**Interfaces:**
- Consumes: `VerticalDirection`, `CallDebit`, `PutDebit` from `prophet_vertical_structure.go`; `almostEqual(a, b, eps float64) bool` from `prophet_vertical_structure_test.go`.
- Produces:
  - `type VerticalCheapness struct { SkewDiff float64; HasIVtoRV bool; IVtoRV float64; Label string }`
  - `func assessVerticalCheapness(dir VerticalDirection, longIV, shortIV, realizedVol float64) VerticalCheapness`
  - Local consts `skewVolTol = 0.01`, `ivToRvCheapMax = 1.10`, `ivToRvRichMin = 1.30` (declared this task, used in Task 2).

- [ ] **Step 1: Write the failing tests for the numeric fields**

Create `services/prophet_vertical_cheapness_test.go`:

```go
package services

import (
	"strings"
	"testing"
)

func TestAssessVerticalCheapness_SkewDiff_IsShortMinusLong(t *testing.T) {
	// Normal call skew: long (lower strike) richer than short (higher strike).
	c := assessVerticalCheapness(CallDebit, 0.30, 0.25, 0.28)
	if !almostEqual(c.SkewDiff, -0.05, 1e-9) {
		t.Fatalf("SkewDiff = %v, want -0.05", c.SkewDiff)
	}
	// Normal put skew: short (lower strike) richer than long (higher strike).
	p := assessVerticalCheapness(PutDebit, 0.30, 0.36, 0.30)
	if !almostEqual(p.SkewDiff, 0.06, 1e-9) {
		t.Fatalf("SkewDiff = %v, want 0.06", p.SkewDiff)
	}
}

func TestAssessVerticalCheapness_IVtoRV_WhenRealizedVolKnown(t *testing.T) {
	c := assessVerticalCheapness(CallDebit, 0.30, 0.30, 0.25)
	if !c.HasIVtoRV {
		t.Fatal("HasIVtoRV = false, want true when realizedVol > 0 and longIV > 0")
	}
	if !almostEqual(c.IVtoRV, 1.2, 1e-9) { // 0.30 / 0.25
		t.Fatalf("IVtoRV = %v, want 1.2", c.IVtoRV)
	}
}

func TestAssessVerticalCheapness_NoRealizedVol_NoRatio(t *testing.T) {
	c := assessVerticalCheapness(CallDebit, 0.28, 0.30, 0)
	if c.HasIVtoRV {
		t.Fatal("HasIVtoRV = true, want false when realizedVol <= 0")
	}
	if c.IVtoRV != 0 {
		t.Fatalf("IVtoRV = %v, want 0 when ratio unavailable", c.IVtoRV)
	}
}

func TestAssessVerticalCheapness_NonPositiveLongIV_NoRatio(t *testing.T) {
	// realizedVol is known but longIV <= 0, so the ratio is meaningless.
	c := assessVerticalCheapness(CallDebit, 0, 0.30, 0.28)
	if c.HasIVtoRV {
		t.Fatal("HasIVtoRV = true, want false when longIV <= 0")
	}
	if c.IVtoRV != 0 {
		t.Fatalf("IVtoRV = %v, want 0", c.IVtoRV)
	}
}

// _ keeps the strings import live until Task 2's label tests use it.
var _ = strings.HasPrefix
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./services/ -run TestAssessVerticalCheapness -v`
Expected: FAIL — compile error `undefined: assessVerticalCheapness` (the implementation file does not exist yet).

- [ ] **Step 3: Write the minimal implementation (numeric core only)**

Create `services/prophet_vertical_cheapness.go`:

```go
package services

// Prophet debit-vertical "cheapness" teaching constants. Pure, local, and
// intentionally NOT placed in prophet_vertical_constants.go so this module
// never collides with the in-flight executor/scheduler work. Pre-registered,
// paper-phase teaching-toy values.
//
// Vols are decimals (0.30 == 30%). skewVolTol is a vol-point tolerance;
// ivToRv* are dimensionless IV/RV ratios.
const (
	// skewVolTol: SkewDiff at or above -skewVolTol counts as flat-or-favorable
	// (you sell at least as rich a vol as you buy). Below it the skew is steep
	// — you sell cheaper vol than you buy, so the vertical is structurally
	// expensive.
	skewVolTol = 0.01 // 1 vol point
	// ivToRvCheapMax: long-leg IV at or under this multiple of realized vol is
	// "not overpaying" for the net-long vega.
	ivToRvCheapMax = 1.10
	// ivToRvRichMin: long-leg IV at or above this multiple of realized vol is
	// "clearly overpaying" — rich regardless of a favorable skew.
	ivToRvRichMin = 1.30
)

// VerticalCheapness is a teaching read on whether a debit vertical is
// structurally cheap, fair, or rich at entry, judged from two no-history
// signals: the vertical's vol skew (sell-leg IV vs buy-leg IV) and, when a
// realized-vol estimate is supplied, the long leg's IV-to-RV ratio. With no
// historical IV surface this is an ABSOLUTE-threshold read, not a
// regime-relative one — a documented limitation, honest for the paper phase.
type VerticalCheapness struct {
	SkewDiff  float64 // shortLegIV - longLegIV (vol sold minus vol bought)
	HasIVtoRV bool    // true only when realizedVol > 0 AND longIV > 0
	IVtoRV    float64 // longIV / realizedVol; meaningful only when HasIVtoRV
	Label     string  // verdict + reason; filled by the label logic
}

// assessVerticalCheapness scores a debit vertical's entry cheapness. Pure: no
// I/O, no clock. longIV/shortIV are the per-leg implied vols (decimals);
// realizedVol is an optional realized-vol estimate (<=0 means "unknown", and
// the read falls back to skew only). dir is reflected in the teaching label.
func assessVerticalCheapness(dir VerticalDirection, longIV, shortIV, realizedVol float64) VerticalCheapness {
	c := VerticalCheapness{SkewDiff: shortIV - longIV}
	c.HasIVtoRV = realizedVol > 0 && longIV > 0
	if c.HasIVtoRV {
		c.IVtoRV = longIV / realizedVol
	}
	return c
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./services/ -run TestAssessVerticalCheapness -v`
Expected: PASS (4 tests). `dir` is currently an unused parameter — that is legal in Go and is consumed by Task 2's label logic.

- [ ] **Step 5: Commit**

```bash
git add services/prophet_vertical_cheapness.go services/prophet_vertical_cheapness_test.go
git commit -m "feat(prophet-vertical): verticalCheapness numeric core (skew + IV/RV)

Pure assessVerticalCheapness computes SkewDiff (shortIV-longIV), and the
long-leg IV-to-realized-vol ratio when realizedVol and longIV are both
positive. Label logic follows in the next commit. New files only; no edits
to the in-flight Phase-3 files.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Verdict label — cheap / fair / rich

Fill the `Label` field using the decision order from the Decision Semantics section. Add the label and boundary tests.

**Files:**
- Modify: `services/prophet_vertical_cheapness.go` (add `import "fmt"` and the verdict switch inside `assessVerticalCheapness`)
- Test: `services/prophet_vertical_cheapness_test.go` (add label + boundary tests)

**Interfaces:**
- Consumes: everything from Task 1 (the struct, the function, the three consts).
- Produces: the populated `VerticalCheapness.Label`, one of these forms (each prefixed by the verdict word so callers/tests can branch on `strings.HasPrefix`):
  - `"rich: <dir>, steep skew"`
  - `"rich: <dir>, IV>>RV"`
  - `"cheap: <dir>, favorable skew (no RV)"`
  - `"cheap: <dir>, favorable skew, IV<=RV"`
  - `"fair: <dir>, favorable skew, IV~RV"`

  where `<dir>` is `call_debit` or `put_debit`. Labels use ASCII tokens (`IV<=RV`, `IV>>RV`, `IV~RV`) — no multibyte glyphs — for test-assertion and encoding safety.

- [ ] **Step 1: Write the failing label + boundary tests**

Append to `services/prophet_vertical_cheapness_test.go` (and delete the `var _ = strings.HasPrefix` line added in Task 1, since `strings` is now used for real):

```go
func TestAssessVerticalCheapness_CallDebit_NormalSkew_Rich(t *testing.T) {
	// Steep normal call skew (short far cheaper than long) — rich even though
	// IV<=RV, because structural skew dominates.
	c := assessVerticalCheapness(CallDebit, 0.30, 0.25, 0.28)
	if !strings.HasPrefix(c.Label, "rich") {
		t.Fatalf("Label = %q, want rich prefix", c.Label)
	}
	if !strings.Contains(c.Label, "steep skew") {
		t.Fatalf("Label = %q, want 'steep skew' reason", c.Label)
	}
}

func TestAssessVerticalCheapness_CallDebit_FlatSkew_IVleRV_Cheap(t *testing.T) {
	// Flat skew + IV below RV → cheap.
	c := assessVerticalCheapness(CallDebit, 0.28, 0.28, 0.30)
	if !strings.HasPrefix(c.Label, "cheap") {
		t.Fatalf("Label = %q, want cheap prefix", c.Label)
	}
	if !strings.Contains(c.Label, "IV<=RV") {
		t.Fatalf("Label = %q, want 'IV<=RV' reason", c.Label)
	}
}

func TestAssessVerticalCheapness_PutDebit_NormalSkew_Cheap(t *testing.T) {
	// Normal put skew makes the sold (lower-strike) leg richer → favorable.
	c := assessVerticalCheapness(PutDebit, 0.30, 0.36, 0.30)
	if !strings.HasPrefix(c.Label, "cheap") {
		t.Fatalf("Label = %q, want cheap prefix", c.Label)
	}
	if !strings.Contains(c.Label, "put_debit") {
		t.Fatalf("Label = %q, want direction in label", c.Label)
	}
}

func TestAssessVerticalCheapness_NoRV_SkewOnlyLabel(t *testing.T) {
	// Favorable skew, no realized vol → skew-only cheap.
	good := assessVerticalCheapness(CallDebit, 0.28, 0.30, 0)
	if !strings.HasPrefix(good.Label, "cheap") || !strings.Contains(good.Label, "no RV") {
		t.Fatalf("Label = %q, want cheap + 'no RV'", good.Label)
	}
	// Steep skew, no realized vol → still rich (skew alone condemns it).
	bad := assessVerticalCheapness(CallDebit, 0.30, 0.25, 0)
	if !strings.HasPrefix(bad.Label, "rich") {
		t.Fatalf("Label = %q, want rich prefix", bad.Label)
	}
}

func TestAssessVerticalCheapness_IVmuchGreaterThanRV_RichDespiteFlatSkew(t *testing.T) {
	// Flat skew, but long IV far above RV → overpaying → rich.
	c := assessVerticalCheapness(CallDebit, 0.40, 0.40, 0.25) // IVtoRV = 1.6
	if !strings.HasPrefix(c.Label, "rich") {
		t.Fatalf("Label = %q, want rich prefix", c.Label)
	}
	if !strings.Contains(c.Label, "IV>>RV") {
		t.Fatalf("Label = %q, want 'IV>>RV' reason", c.Label)
	}
	if !almostEqual(c.IVtoRV, 1.6, 1e-9) {
		t.Fatalf("IVtoRV = %v, want 1.6", c.IVtoRV)
	}
}

func TestAssessVerticalCheapness_FavorableSkew_NeutralVRP_Fair(t *testing.T) {
	// Flat skew, IVtoRV between cheap and rich cutoffs → fair.
	c := assessVerticalCheapness(CallDebit, 0.33, 0.33, 0.28) // IVtoRV ~= 1.179
	if !strings.HasPrefix(c.Label, "fair") {
		t.Fatalf("Label = %q, want fair prefix", c.Label)
	}
}

func TestAssessVerticalCheapness_Boundaries(t *testing.T) {
	// Skew flat-band: just inside (-0.009) favorable, just outside (-0.011) steep.
	// Margins are ~1e-3, far above float64 noise, so the boundary is exercised
	// without exact-equality fragility.
	inside := assessVerticalCheapness(CallDebit, 0.30, 0.291, 0) // SkewDiff -0.009
	if !strings.HasPrefix(inside.Label, "cheap") {
		t.Fatalf("inside flat band: Label = %q, want cheap", inside.Label)
	}
	outside := assessVerticalCheapness(CallDebit, 0.30, 0.289, 0) // SkewDiff -0.011
	if !strings.HasPrefix(outside.Label, "rich") {
		t.Fatalf("outside flat band: Label = %q, want rich", outside.Label)
	}

	// VRP cutoffs (flat skew so the VRP branch decides):
	cheapVol := assessVerticalCheapness(CallDebit, 0.27, 0.27, 0.25) // IVtoRV 1.08 <= 1.10
	if !strings.HasPrefix(cheapVol.Label, "cheap") {
		t.Fatalf("cheap-vol: Label = %q, want cheap", cheapVol.Label)
	}
	neutralVol := assessVerticalCheapness(CallDebit, 0.285, 0.285, 0.25) // IVtoRV 1.14
	if !strings.HasPrefix(neutralVol.Label, "fair") {
		t.Fatalf("neutral-vol: Label = %q, want fair", neutralVol.Label)
	}
	richVol := assessVerticalCheapness(CallDebit, 0.34, 0.34, 0.25) // IVtoRV 1.36 >= 1.30
	if !strings.HasPrefix(richVol.Label, "rich") {
		t.Fatalf("rich-vol: Label = %q, want rich", richVol.Label)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./services/ -run TestAssessVerticalCheapness -v`
Expected: FAIL — the new label/boundary tests fail because `Label` is still `""` (e.g. `want rich prefix`), while the Task-1 numeric tests still pass.

- [ ] **Step 3: Add the verdict logic**

Edit `services/prophet_vertical_cheapness.go`. Add the import:

```go
import "fmt"
```

Then replace the body of `assessVerticalCheapness` (keep the doc comment) so it ends by populating `Label`:

```go
func assessVerticalCheapness(dir VerticalDirection, longIV, shortIV, realizedVol float64) VerticalCheapness {
	c := VerticalCheapness{SkewDiff: shortIV - longIV}
	c.HasIVtoRV = realizedVol > 0 && longIV > 0
	if c.HasIVtoRV {
		c.IVtoRV = longIV / realizedVol
	}

	favorable := c.SkewDiff >= -skewVolTol
	overpaying := c.HasIVtoRV && c.IVtoRV >= ivToRvRichMin
	cheapVol := c.HasIVtoRV && c.IVtoRV <= ivToRvCheapMax

	switch {
	case !favorable:
		c.Label = fmt.Sprintf("rich: %s, steep skew", dir)
	case overpaying:
		c.Label = fmt.Sprintf("rich: %s, IV>>RV", dir)
	case !c.HasIVtoRV:
		c.Label = fmt.Sprintf("cheap: %s, favorable skew (no RV)", dir)
	case cheapVol:
		c.Label = fmt.Sprintf("cheap: %s, favorable skew, IV<=RV", dir)
	default:
		c.Label = fmt.Sprintf("fair: %s, favorable skew, IV~RV", dir)
	}
	return c
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./services/ -run TestAssessVerticalCheapness -v`
Expected: PASS (all 11 tests).

- [ ] **Step 5: Verify the whole package still builds and is vet-clean**

Run: `go vet ./services/ && go test ./services/`
Expected: `go vet` prints nothing; `go test ./services/` reports `ok prophet-trader/services`. (This confirms the two new files did not break any sibling vertical test in the package.)

- [ ] **Step 6: Commit**

```bash
git add services/prophet_vertical_cheapness.go services/prophet_vertical_cheapness_test.go
git commit -m "feat(prophet-vertical): verticalCheapness verdict label (cheap/fair/rich)

Skew-first decision: steep skew is rich even when IV<=RV; a favorable
(flat-or-positive) skew is rich only if long IV >> realized vol, cheap when
IV<=RV or RV is unknown (skew-only), else fair. ASCII reason tokens; direction
in the teaching label. Absolute thresholds (no IV history) are a documented
paper-phase limitation. Out of scope: call site, card/model fields, dashboard.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage** (against the locked design):
- `VerticalCheapness` struct with `SkewDiff` / `HasIVtoRV` / `IVtoRV` / `Label` — Task 1 (struct) + Task 2 (Label). ✓
- `assessVerticalCheapness(dir, longIV, shortIV, realizedVol)` signature — Task 1. ✓
- `SkewDiff = shortIV − longIV`, direction-agnostic — Task 1, `TestAssessVerticalCheapness_SkewDiff_IsShortMinusLong`. ✓
- `IVtoRV = longIV / realizedVol` when `realizedVol > 0`, else skew-only — Task 1 (`HasIVtoRV`, `NoRealizedVol`) + Task 2 (`NoRV_SkewOnlyLabel`). ✓
- Label cases cheap / rich / fair / skew-only — Task 2 covers all five label forms. ✓
- Threshold-boundary test — Task 2, `TestAssessVerticalCheapness_Boundaries`. ✓
- Six design test scenarios (call normal→rich, call flat+IV≤RV→cheap, put normal→favorable, RV-unknown→skew-only, IV≫RV→rich-despite-flat, boundaries) — all present in Task 2. ✓
- Thresholds as documented local consts, not in `prophet_vertical_constants.go` — Task 1 const block. ✓
- New files only, no edits — Global Constraints + both tasks touch only the two new files. ✓
- Out-of-scope items (call site, card/model fields, dashboard) — listed and excluded. ✓

**2. Placeholder scan:** No `TBD` / "handle edge cases" / "write tests for the above" — every step has concrete code and an exact command with expected output. ✓ (One deliberate, fully-specified refinement beyond the design: `HasIVtoRV` also requires `longIV > 0`, covered by `TestAssessVerticalCheapness_NonPositiveLongIV_NoRatio` and documented in the struct comment.)

**3. Type consistency:** `VerticalCheapness`, `assessVerticalCheapness`, `skewVolTol`, `ivToRvCheapMax`, `ivToRvRichMin`, `SkewDiff`, `HasIVtoRV`, `IVtoRV`, `Label`, `CallDebit`, `PutDebit`, `almostEqual` are spelled identically across both tasks and match the existing `prophet_vertical_structure.go` definitions. The `strings` import is introduced in Task 1 (kept live via `var _`) and made real in Task 2 (the `var _` line is removed). ✓
