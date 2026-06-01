# Orphan-Position Detector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect broker positions this agent's ledger marked terminal (CLOSED/STOPPED_OUT/FAILED) while the broker still holds the shares ("orphans"), and surface them report-only via an operator log and a per-sandbox `orphans.json` — never placing an order.

**Architecture:** A pure `findOrphans` helper computes the orphan set from the broker positions already read by `reconcileWithBroker` and this PM's managed records. `detectOrphans` (called at the end of `reconcileWithBroker`) dedups via an `orphanAlerted` set, logs newly-detected orphans, and refreshes the report through a nil-safe `OrphanReporter`. Shared-account-safe: a held symbol with no managed record (another agent's position) is never flagged.

**Tech Stack:** Go, logrus, standard `encoding/json`/`os`/`path/filepath`, `go test`.

**Design spec:** `docs/superpowers/specs/2026-06-01-orphan-detector-design.md`

**PRE-REQ:** The WMT close-fix changes already in `services/position_manager.go` + `services/position_manager_close_test.go` are a *separate* backlog item and must be committed BEFORE executing this plan, so orphan-detector commits don't bundle them (both touch `position_manager.go`).

---

## File Structure

- **Create** `services/orphan_reporter.go` — `OrphanAlert` type + `OrphanReporter` (writes `orphans.json`). One responsibility: serializing the current orphan set to disk.
- **Create** `services/orphan_reporter_test.go` — reporter tests.
- **Modify** `services/position_manager.go` — add `findOrphans` + `isTerminalStatus` (pure detection), `orphanAlerted`/`orphanReporter` fields, `SetOrphanReporter`, `detectOrphans`, and the `reconcileWithBroker` hook.
- **Create** `services/position_manager_orphan_test.go` — `findOrphans` logic tests + `detectOrphans` dedup tests.
- **Modify** `cmd/bot/main.go` — wire the `OrphanReporter` with the per-sandbox reports dir.

---

### Task 1: OrphanAlert type + OrphanReporter

**Files:**
- Create: `services/orphan_reporter.go`
- Test: `services/orphan_reporter_test.go`

- [ ] **Step 1: Write the failing tests**

Create `services/orphan_reporter_test.go`:

```go
package services

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestOrphanReporter_WritesJSON(t *testing.T) {
	dir := t.TempDir()
	r := NewOrphanReporter(dir)
	orphans := []OrphanAlert{{Symbol: "UNH", BrokerQty: 13, PositionID: "pos_unh", LedgerStatus: "CLOSED"}}
	if err := r.Report(orphans); err != nil {
		t.Fatalf("Report: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(dir, "orphans.json"))
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var got []OrphanAlert
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(got) != 1 || got[0].Symbol != "UNH" || got[0].BrokerQty != 13 || got[0].LedgerStatus != "CLOSED" {
		t.Errorf("got %+v, want one UNH/13/CLOSED orphan", got)
	}
}

func TestOrphanReporter_EmptySetClearsFile(t *testing.T) {
	dir := t.TempDir()
	r := NewOrphanReporter(dir)
	if err := r.Report(nil); err != nil {
		t.Fatalf("Report: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(dir, "orphans.json"))
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if strings.TrimSpace(string(data)) != "[]" {
		t.Errorf("got %q, want []", string(data))
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./services/ -run TestOrphanReporter -v`
Expected: FAIL — `undefined: OrphanAlert` / `undefined: NewOrphanReporter` (compile error).

- [ ] **Step 3: Write minimal implementation**

Create `services/orphan_reporter.go`:

```go
package services

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"
)

// OrphanAlert describes a broker position whose managed record this agent has
// marked terminal (CLOSED/STOPPED_OUT/FAILED) while the broker still holds the
// shares — a close that never actually flattened the broker side.
type OrphanAlert struct {
	Symbol       string     `json:"symbol"`
	BrokerQty    float64    `json:"broker_qty"`
	PositionID   string     `json:"position_id"`
	LedgerStatus string     `json:"ledger_status"`
	ClosedAt     *time.Time `json:"closed_at,omitempty"`
	DetectedAt   time.Time  `json:"detected_at"`
}

// OrphanReporter persists the current orphan set to <dir>/orphans.json so the
// operator can see it (the Go bot's console logs are not reliably retained). It
// is report-only and never trades.
type OrphanReporter struct {
	dir string
}

func NewOrphanReporter(dir string) *OrphanReporter {
	return &OrphanReporter{dir: dir}
}

// Report overwrites <dir>/orphans.json with the given orphan set. A nil/empty
// set writes an empty JSON array so a resolved orphan clears the file. The
// directory is created if missing.
func (r *OrphanReporter) Report(orphans []OrphanAlert) error {
	if err := os.MkdirAll(r.dir, 0o755); err != nil {
		return err
	}
	if orphans == nil {
		orphans = []OrphanAlert{}
	}
	data, err := json.MarshalIndent(orphans, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(r.dir, "orphans.json"), data, 0o644)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./services/ -run TestOrphanReporter -v`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add services/orphan_reporter.go services/orphan_reporter_test.go
git commit -m "feat(orphan-detector): OrphanAlert type + report-only OrphanReporter"
```

---

### Task 2: findOrphans pure detection helper

**Files:**
- Modify: `services/position_manager.go` (add `findOrphans` + `isTerminalStatus` near the other helpers, e.g. after `cancelBracketOrders`)
- Test: `services/position_manager_orphan_test.go`

- [ ] **Step 1: Write the failing tests**

Create `services/position_manager_orphan_test.go` (imports cover only what Task 2 uses; Task 3 expands the block):

```go
package services

import (
	"testing"

	"prophet-trader/interfaces"
)

func brokerPos(sym string, qty float64) *interfaces.Position {
	return &interfaces.Position{Symbol: sym, Qty: qty, Side: "long"}
}

// Broker holds a symbol whose only managed record is terminal -> orphan.
func TestFindOrphans_TerminalRecordBrokerHolds_Flagged(t *testing.T) {
	managed := []*ManagedPosition{{ID: "pos_unh", Symbol: "UNH", Status: "CLOSED", RemainingQty: 13}}
	broker := []*interfaces.Position{brokerPos("UNH", 13)}
	got := findOrphans(broker, managed)
	if len(got) != 1 {
		t.Fatalf("got %d orphans, want 1: %+v", len(got), got)
	}
	if got[0].Symbol != "UNH" || got[0].BrokerQty != 13 || got[0].PositionID != "pos_unh" || got[0].LedgerStatus != "CLOSED" {
		t.Errorf("orphan = %+v, want UNH/13/pos_unh/CLOSED", got[0])
	}
}

// A held symbol with NO managed record belongs to another agent on the shared
// account and must never be flagged.
func TestFindOrphans_NoRecord_NotFlagged(t *testing.T) {
	managed := []*ManagedPosition{{ID: "pos_unh", Symbol: "UNH", Status: "CLOSED"}}
	broker := []*interfaces.Position{brokerPos("AAPL", 100)}
	if got := findOrphans(broker, managed); len(got) != 0 {
		t.Fatalf("got %+v, want none (AAPL has no record for this agent)", got)
	}
}

// A live (ACTIVE) record is a normal position, not an orphan.
func TestFindOrphans_ActiveRecord_NotFlagged(t *testing.T) {
	managed := []*ManagedPosition{{ID: "pos_wmt", Symbol: "WMT", Status: "ACTIVE", RemainingQty: 42}}
	broker := []*interfaces.Position{brokerPos("WMT", 42)}
	if got := findOrphans(broker, managed); len(got) != 0 {
		t.Fatalf("got %+v, want none (WMT is ACTIVE)", got)
	}
}

// Re-entered after a prior close: a terminal AND a live record for the same
// symbol -> the live record wins, not an orphan.
func TestFindOrphans_TerminalAndActiveCoexist_NotFlagged(t *testing.T) {
	managed := []*ManagedPosition{
		{ID: "pos_old", Symbol: "DE", Status: "CLOSED"},
		{ID: "pos_new", Symbol: "DE", Status: "ACTIVE", RemainingQty: 9},
	}
	broker := []*interfaces.Position{brokerPos("DE", 9)}
	if got := findOrphans(broker, managed); len(got) != 0 {
		t.Fatalf("got %+v, want none (DE has a live record)", got)
	}
}

// Terminal record but the broker is flat -> correctly closed, not an orphan.
func TestFindOrphans_TerminalButBrokerFlat_NotFlagged(t *testing.T) {
	managed := []*ManagedPosition{{ID: "pos_unh", Symbol: "UNH", Status: "CLOSED"}}
	broker := []*interfaces.Position{}
	if got := findOrphans(broker, managed); len(got) != 0 {
		t.Fatalf("got %+v, want none (broker is flat)", got)
	}
}

// A PENDING record (entry not yet filled) is non-terminal -> not an orphan.
func TestFindOrphans_PendingRecord_NotFlagged(t *testing.T) {
	managed := []*ManagedPosition{{ID: "pos_pend", Symbol: "MO", Status: "PENDING", RemainingQty: 70}}
	broker := []*interfaces.Position{brokerPos("MO", 70)}
	if got := findOrphans(broker, managed); len(got) != 0 {
		t.Fatalf("got %+v, want none (MO is PENDING)", got)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./services/ -run TestFindOrphans -v`
Expected: FAIL — `undefined: findOrphans` (compile error).

- [ ] **Step 3: Write minimal implementation**

In `services/position_manager.go`, add after `cancelBracketOrders` (before `// Helper functions`):

```go
// isTerminalStatus reports whether a managed-position status is terminal — the
// position is done from this agent's point of view. Any other status
// (ACTIVE/PARTIAL/PENDING or unknown) is treated as non-terminal/live, so a
// malformed record can never be mistaken for an orphan source.
func isTerminalStatus(status string) bool {
	return status == "CLOSED" || status == "STOPPED_OUT" || status == "FAILED"
}

// findOrphans returns the broker positions this agent considers orphans: the
// broker holds the symbol, this PM has at least one managed record for it, and
// EVERY record for that symbol is terminal (CLOSED/STOPPED_OUT/FAILED). Symbols
// with a non-terminal record (live) or with no record at all (another agent's
// position on the shared broker account) are excluded. Pure — no I/O, no locks.
func findOrphans(brokerPositions []*interfaces.Position, managed []*ManagedPosition) []OrphanAlert {
	hasNonTerminal := make(map[string]bool)
	terminal := make(map[string]*ManagedPosition) // symbol -> a terminal record
	for _, p := range managed {
		if p == nil {
			continue
		}
		if isTerminalStatus(p.Status) {
			if _, seen := terminal[p.Symbol]; !seen {
				terminal[p.Symbol] = p
			}
		} else {
			hasNonTerminal[p.Symbol] = true
		}
	}

	now := time.Now()
	var orphans []OrphanAlert
	for _, bp := range brokerPositions {
		if bp == nil || bp.Qty == 0 {
			continue
		}
		if hasNonTerminal[bp.Symbol] {
			continue // a live record exists — normal position
		}
		rec, ok := terminal[bp.Symbol]
		if !ok {
			continue // no record for this symbol — another agent's position
		}
		orphans = append(orphans, OrphanAlert{
			Symbol:       bp.Symbol,
			BrokerQty:    bp.Qty,
			PositionID:   rec.ID,
			LedgerStatus: rec.Status,
			ClosedAt:     rec.ClosedAt,
			DetectedAt:   now,
		})
	}
	return orphans
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./services/ -run TestFindOrphans -v`
Expected: PASS (all six).

- [ ] **Step 5: Commit**

```bash
git add services/position_manager.go services/position_manager_orphan_test.go
git commit -m "feat(orphan-detector): findOrphans pure detection (shared-account-safe)"
```

---

### Task 3: detectOrphans + dedup + reconcile hook

**Files:**
- Modify: `services/position_manager.go` (struct fields, `NewPositionManager` init, `SetOrphanReporter`, `detectOrphans`, `reconcileWithBroker` hook)
- Test: `services/position_manager_orphan_test.go` (append dedup tests)

- [ ] **Step 1: Write the failing tests**

First, expand the import block of `services/position_manager_orphan_test.go` to add the imports the dedup tests need:

```go
import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"prophet-trader/interfaces"
)
```

Then append to `services/position_manager_orphan_test.go`:

```go
// Across repeated reconcile passes the same orphan is recorded once and no order
// is ever placed; the report file lists it.
func TestDetectOrphans_AlertsOnceAndReports(t *testing.T) {
	dir := t.TempDir()
	trading := &reconcileStubTrading{stubTrading: &stubTrading{}, positions: []*interfaces.Position{{Symbol: "UNH", Qty: 13, Side: "long"}}}
	pm := newReconcilePM(t, trading)
	pm.SetOrphanReporter(NewOrphanReporter(dir))
	injectPosition(pm, &ManagedPosition{ID: "pos_unh", Symbol: "UNH", Status: "CLOSED", RemainingQty: 13})

	if _, err := pm.reconcileWithBroker(context.Background()); err != nil {
		t.Fatalf("pass 1: %v", err)
	}
	if _, err := pm.reconcileWithBroker(context.Background()); err != nil {
		t.Fatalf("pass 2: %v", err)
	}

	if !pm.orphanAlerted["UNH"] {
		t.Error("UNH should be in the alerted set")
	}
	if trading.placeCalls != 0 {
		t.Errorf("placeCalls = %d, want 0 (detection must place no orders)", trading.placeCalls)
	}
	data, err := os.ReadFile(filepath.Join(dir, "orphans.json"))
	if err != nil {
		t.Fatalf("read report: %v", err)
	}
	var got []OrphanAlert
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(got) != 1 || got[0].Symbol != "UNH" {
		t.Fatalf("report = %+v, want one UNH orphan", got)
	}
}

// When the broker no longer holds the symbol the orphan resolves: it leaves the
// alerted set and the report file empties.
func TestDetectOrphans_ResolvesWhenBrokerDropsSymbol(t *testing.T) {
	dir := t.TempDir()
	trading := &reconcileStubTrading{stubTrading: &stubTrading{}, positions: []*interfaces.Position{{Symbol: "UNH", Qty: 13, Side: "long"}}}
	pm := newReconcilePM(t, trading)
	pm.SetOrphanReporter(NewOrphanReporter(dir))
	injectPosition(pm, &ManagedPosition{ID: "pos_unh", Symbol: "UNH", Status: "CLOSED", RemainingQty: 13})

	if _, err := pm.reconcileWithBroker(context.Background()); err != nil {
		t.Fatalf("pass 1: %v", err)
	}
	if !pm.orphanAlerted["UNH"] {
		t.Fatal("UNH should be alerted after pass 1")
	}

	trading.positions = []*interfaces.Position{} // operator flattened UNH
	if _, err := pm.reconcileWithBroker(context.Background()); err != nil {
		t.Fatalf("pass 2: %v", err)
	}
	if pm.orphanAlerted["UNH"] {
		t.Error("UNH should be cleared from the alerted set after resolution")
	}
	data, err := os.ReadFile(filepath.Join(dir, "orphans.json"))
	if err != nil {
		t.Fatalf("read report: %v", err)
	}
	var got []OrphanAlert
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("report = %+v, want empty after resolution", got)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./services/ -run TestDetectOrphans -v`
Expected: FAIL — `pm.orphanAlerted undefined` / `pm.SetOrphanReporter undefined` (compile error).

- [ ] **Step 3a: Add struct fields**

In `services/position_manager.go`, in the `PositionManager` struct, after the `segmentWriter`/`lastSegmentWriteDay` fields, add:

```go
	// orphanAlerted tracks symbols already reported as orphans (broker holds the
	// shares but this agent's ledger marked the position terminal), so the ~60s
	// reconcile pass logs/reports each one once. Guarded by mu.
	orphanAlerted map[string]bool
	// orphanReporter persists the current orphan set to disk. nil-safe: if never
	// installed, detection still logs but writes no file.
	orphanReporter *OrphanReporter
```

- [ ] **Step 3b: Initialize the map in NewPositionManager**

In `NewPositionManager`, in the `pm := &PositionManager{...}` literal, add after `reconcileMissCount: make(map[string]int),`:

```go
		orphanAlerted:      make(map[string]bool),
```

- [ ] **Step 3c: Add the setter**

Add near `SetSegmentWriter`:

```go
// SetOrphanReporter installs the report-only orphan reporter (wired at startup).
// Optional: if never set, detectOrphans still logs but writes no report file.
func (pm *PositionManager) SetOrphanReporter(r *OrphanReporter) {
	pm.orphanReporter = r
}
```

- [ ] **Step 3d: Add detectOrphans**

Add after `findOrphans` (from Task 2):

```go
// detectOrphans is the report-only orphan check. It finds broker positions this
// agent's ledger has marked terminal while the broker still holds them, logs each
// newly-detected one for operator review, and refreshes the orphans report when
// the set changes. It places NO orders. Called from reconcileWithBroker, reusing
// the broker positions already read there.
func (pm *PositionManager) detectOrphans(brokerPositions []*interfaces.Position) {
	pm.mu.Lock()
	managed := make([]*ManagedPosition, 0, len(pm.positions))
	for _, p := range pm.positions {
		managed = append(managed, p)
	}
	pm.mu.Unlock()

	orphans := findOrphans(brokerPositions, managed)

	current := make(map[string]bool, len(orphans))
	for _, o := range orphans {
		current[o.Symbol] = true
	}

	pm.mu.Lock()
	var newly []OrphanAlert
	changed := false
	for _, o := range orphans {
		if !pm.orphanAlerted[o.Symbol] {
			pm.orphanAlerted[o.Symbol] = true
			newly = append(newly, o)
			changed = true
		}
	}
	for sym := range pm.orphanAlerted {
		if !current[sym] {
			delete(pm.orphanAlerted, sym)
			changed = true
		}
	}
	pm.mu.Unlock()

	for _, o := range newly {
		pm.logger.WithFields(logrus.Fields{
			"symbol":                   o.Symbol,
			"broker_qty":               o.BrokerQty,
			"position_id":              o.PositionID,
			"ledger_status":            o.LedgerStatus,
			"operator_review_required": true,
		}).Error("Orphan position detected — ledger marked terminal but broker still holds shares (no order placed)")
	}

	if changed && pm.orphanReporter != nil {
		if err := pm.orphanReporter.Report(orphans); err != nil {
			pm.logger.WithError(err).Warn("Failed to write orphans report")
		}
	}
}
```

- [ ] **Step 3e: Hook into reconcileWithBroker**

In `reconcileWithBroker`, change the lock from deferred to explicit and call `detectOrphans` after releasing it. Replace:

```go
	pm.mu.Lock()
	defer pm.mu.Unlock()

	closed := 0
```

with:

```go
	pm.mu.Lock()
	closed := 0
```

and replace the function's final:

```go
	return closed, nil
}
```

with:

```go
	pm.mu.Unlock()

	// Report-only orphan detection reuses the broker positions read above.
	pm.detectOrphans(brokerPositions)

	return closed, nil
}
```

(There is no early return or panic path inside the loop — `savePositionToDB` errors are logged, not returned — so moving off `defer` is safe.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./services/ -run 'TestDetectOrphans|TestReconcile|TestFindOrphans' -v`
Expected: PASS — both new dedup tests AND all existing `TestReconcile_*` tests (the reconcile hook must not regress phantom-close behavior or place orders).

- [ ] **Step 5: Commit**

```bash
git add services/position_manager.go services/position_manager_orphan_test.go
git commit -m "feat(orphan-detector): detectOrphans dedup + reconcile hook (report-only)"
```

---

### Task 4: Wire the reporter in main.go + full verification

**Files:**
- Modify: `cmd/bot/main.go`

- [ ] **Step 1: Ensure the filepath import**

Confirm `cmd/bot/main.go` imports `"path/filepath"`. If absent, add it to the import block.

Run: `go doc path/filepath >/dev/null 2>&1; grep -n "path/filepath" cmd/bot/main.go || echo "MISSING - add it"`

- [ ] **Step 2: Wire the reporter**

In `cmd/bot/main.go`, immediately after the `positionManager.SetSegmentWriter(...)` line (~line 464), add:

```go
	// Wire the report-only orphan detector's reporter. Detected orphans (ledger
	// marked terminal while the broker still holds the shares) are written to
	// <db-dir>/reports/orphans.json next to this sandbox's database.
	positionManager.SetOrphanReporter(services.NewOrphanReporter(filepath.Join(filepath.Dir(cfg.DatabasePath), "reports")))
```

- [ ] **Step 3: Build and run the full suite**

Run: `go build ./... && go test ./services/ && gofmt -l services/orphan_reporter.go services/position_manager.go services/position_manager_orphan_test.go services/orphan_reporter_test.go cmd/bot/main.go`
Expected: build succeeds, `ok prophet-trader/services`, and `gofmt -l` prints nothing (run `gofmt -w` on any listed file, then re-run).

Run: `go vet ./services/ ./cmd/bot/`
Expected: no output (clean).

- [ ] **Step 4: Commit**

```bash
git add cmd/bot/main.go
git commit -m "feat(orphan-detector): wire OrphanReporter to per-sandbox reports dir"
```

- [ ] **Step 5: Squash to one backlog commit (per workflow preference)**

The four task commits are TDD checkpoints. Squash them into one commit for this backlog item before merging:

```bash
git rebase -i <commit-before-task-1>
# mark Tasks 2-4 commits as 'fixup' (or 'squash') onto Task 1
```

Final message: `feat(orphan-detector): report-only detection of ledger-terminal/broker-held orphans`

---

## Self-Review

**Spec coverage:**
- Placement & data reuse → Task 3 Step 3e (hook in `reconcileWithBroker`, reuses `brokerPositions`). ✓
- Detection rule (shared-account-safe) → Task 2 `findOrphans` + its 6 tests (incl. no-record and PENDING). ✓
- `OrphanAlert` data structure → Task 1. ✓
- Dedup via `orphanAlerted` → Task 3 `detectOrphans` + 2 dedup tests. ✓
- Structured operator log → Task 3 Step 3d. ✓
- Persisted `orphans.json` (current-state, empties on resolution) → Task 1 reporter + Task 4 wiring + resolution test. ✓
- Nil-safe reporter (logs without file when unset) → Task 3 `detectOrphans` `if ... pm.orphanReporter != nil`. ✓
- Auto-close seam, not built → `detectOrphans` returns/uses typed `[]OrphanAlert`; no order path. ✓ (Non-goal honored.)
- On by default, no flag → no flag added anywhere. ✓
- Places no orders → asserted by `placeCalls == 0` in the dedup test + existing reconcile tests. ✓

**Placeholder scan:** No TBD/TODO; all steps contain full code and exact commands. ✓

**Type consistency:** `OrphanAlert` fields (`Symbol`/`BrokerQty`/`PositionID`/`LedgerStatus`/`ClosedAt`/`DetectedAt`) identical across `orphan_reporter.go`, `findOrphans`, and tests. `findOrphans(brokerPositions, managed)`, `detectOrphans(brokerPositions)`, `SetOrphanReporter(*OrphanReporter)`, `NewOrphanReporter(dir)` signatures consistent across tasks. `interfaces.Position` fields `Symbol`/`Qty` match the existing reconcile tests. ✓
