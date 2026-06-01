# Defensive-Prophet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a flag-gated, default-OFF Go backend executor that buys triggered, defined-risk QQQ put-debit-spreads as a capped correction hedge, persists + manages their lifecycle mechanically, and feeds Foundation B's daily segment-P&L series for ballast-track grading.

**Architecture:** A new `ProphetHedgeExecutor` modeled on `TurtleExecutor` (services/turtle_executor.go): a once-daily `RunHeartbeat` that arms off the existing regime signal, manages open spreads (harvest/roll/expire/ITM-short), and opens new spreads via the existing `PlaceMultiLegOrder` plumbing through the options guard. Spreads persist in a dedicated `DBProphetHedgeSpread` table (multi-leg doesn't fit single-symbol `managed_positions`, exactly like Harvest's condor table). All decision logic is pure functions tested in isolation; the executor is tested against mocks.

**Tech Stack:** Go, GORM (SQLite), logrus; Alpaca multi-leg options (`mleg`); existing `RegimeGateService`, `AlpacaOptionsDataService`, `TradeGuard`, `SegmentPnLWriter`.

**Spec:** `docs/superpowers/specs/2026-06-01-defensive-prophet-design.md` (decisions D-DP1…D-DP19).

**Scope boundary:** This plan ships the executor + persistence + the D-DP9 segment-writer integration so the daily data starts accruing, plus the synthetic-stress-payoff pure function (D-DP13). The *grading consumption* (Foundation B 2b/2c: QQQ-benchmark fetch, book-β calibration, the graduation gate) is explicitly **deferred** — it runs after ~a quarter of `DBSegmentPnL` accrues, per the spec §7 and `foundation-measurement-lifecycle-status`. The conditional `selectStructure` v2, the LLM layer, the long-vol sleeve, and SPY are deferred seams (spec §10).

---

## File Structure

**New files:**
- `models/prophet_hedge_models.go` — `DBProphetHedgeSpread`, `DBProphetHedgeSession`.
- `services/prophet_hedge_ledger.go` — `ProphetHedgeLedger` façade (mirrors `TurtleLedger`).
- `services/prophet_hedge_structure.go` — pure structuring: `SpreadProfile`, `selectStructure`, `pickPutStrikes`, `sizeSpread`, `marketableLimit`, `syntheticStressPayoff`.
- `services/prophet_hedge_lifecycle.go` — pure decision predicates: `deriveArm`, `shouldHarvest`, `shouldRoll`, `shouldExpire`, `shouldCloseITMShort`.
- `services/prophet_hedge_executor.go` — `ProphetHedgeExecutor`, `RunHeartbeat`, reconcile/manage/open.
- `services/prophet_hedge_scheduler.go` — `ProphetHedgeScheduler` (mirrors `TurtleScheduler`).
- Test files alongside each (`*_test.go`).

**Modified files:**
- `config/config.go` — add hedge flag + params to `Config`.
- `database/storage.go` — `AutoMigrate` the two new models + add 6 storage methods.
- `services/segment_pnl_writer.go` — D-DP9: include `prophet-defensive` in the daily-mark loop + realized special-case.
- `cmd/bot/main.go` — flag-gated construction + scheduler start; register status endpoint.

**Constants (define once in `prophet_hedge_executor.go`):**
```go
const (
	hedgeStrategyTag       = "prophet-defensive"
	hedgeArmThreshold      = 50      // paper; live pre-registered = 35 (D-DP2/D-DP14)
	hedgeMaxConcurrent     = 3       // D-DP6
	hedgeDebitCapPct       = 0.01    // ≤1% portfolio net debit per spread (D-DP6)
	hedgeLongPctOTM        = 0.05    // long put ~5% OTM (D-DP4)
	hedgeShortPctOTM       = 0.15    // short put ~15% OTM (D-DP4)
	hedgeDTEMin            = 45      // D-DP4
	hedgeDTEMax            = 60      // D-DP4
	hedgeHarvestFrac       = 0.60    // close at ≥60% of max payoff (D-DP5)
	hedgeRollDTE           = 21      // roll/expire threshold while armed (D-DP5)
	hedgeITMShortDTE       = 7       // assignment-defense window (D-DP T2.4)
	hedgeWindowStartMin    = 17*60   // 17:00 ET beat window (mirror Turtle)
	hedgeWindowEndMin      = 17*60 + 10
)
```

---

## Phase A — Scaffolding & persistence

### Task 1: Config flag + params

**Files:**
- Modify: `config/config.go` (the `Config` struct + the loader near the regime-gate block, ~line 41-126)

- [ ] **Step 1: Write the failing test**

Add to `config/config_test.go`:
```go
func TestLoadConfig_ProphetDefensiveDefaultsOff(t *testing.T) {
	t.Setenv("ENABLE_PROPHET_DEFENSIVE", "")
	cfg := Load()
	if cfg.EnableProphetDefensive {
		t.Fatal("EnableProphetDefensive must default to false")
	}
}

func TestLoadConfig_ProphetDefensiveOn(t *testing.T) {
	t.Setenv("ENABLE_PROPHET_DEFENSIVE", "true")
	cfg := Load()
	if !cfg.EnableProphetDefensive {
		t.Fatal("ENABLE_PROPHET_DEFENSIVE=true must set the flag")
	}
}
```
(If `Load` isn't the constructor name, match the existing one used in `config_test.go`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./config/ -run ProphetDefensive -v`
Expected: FAIL — `cfg.EnableProphetDefensive` undefined.

- [ ] **Step 3: Add the field + loader line**

In the `Config` struct, beside `EnableRegimeGate`:
```go
	// Defensive-Prophet hedge (flag-gated rollout, default OFF). When false the
	// executor/scheduler is never constructed in cmd/bot (mirrors the regime-gate
	// observe-before-enable pattern).
	EnableProphetDefensive bool
```
In the loader, beside the regime defaults (keep the comment on its own line — inline `#` in `.env` may not be stripped, silently yielding false; see `capital-allocation-reconciled`):
```go
		EnableProphetDefensive: getEnvOrDefault("ENABLE_PROPHET_DEFENSIVE", "false") == "true",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./config/ -run ProphetDefensive -v`
Expected: PASS (both).

- [ ] **Step 5: Commit**

```bash
git add config/config.go config/config_test.go
git commit -m "feat(defensive-prophet): config flag ENABLE_PROPHET_DEFENSIVE (default OFF)"
```

---

### Task 2: Persistence models + AutoMigrate

**Files:**
- Create: `models/prophet_hedge_models.go`
- Modify: `database/storage.go:42-55` (AutoMigrate list)

- [ ] **Step 1: Write the failing test**

Create `database/storage_prophet_hedge_test.go`:
```go
package database

import (
	"testing"
	"time"

	"prophet-trader/models"
)

func TestProphetHedgeSpread_SaveAndListOpen(t *testing.T) {
	s, err := NewLocalStorage(":memory:")
	if err != nil {
		t.Fatalf("storage: %v", err)
	}
	open := &models.DBProphetHedgeSpread{
		SpreadID: "s1", Underlying: "QQQ", Status: "open",
		LongPutSymbol: "QQQ260101P00475000", ShortPutSymbol: "QQQ260101P00425000",
		Contracts: 1, Expiration: time.Now().Add(45 * 24 * time.Hour),
	}
	closed := &models.DBProphetHedgeSpread{SpreadID: "s2", Underlying: "QQQ", Status: "closed"}
	if err := s.SaveProphetHedgeSpread(open); err != nil {
		t.Fatalf("save open: %v", err)
	}
	if err := s.SaveProphetHedgeSpread(closed); err != nil {
		t.Fatalf("save closed: %v", err)
	}
	got, err := s.ListOpenProphetHedgeSpreads()
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 1 || got[0].SpreadID != "s1" {
		t.Fatalf("want only the open spread, got %d rows", len(got))
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./database/ -run ProphetHedge -v`
Expected: FAIL — `DBProphetHedgeSpread` / `SaveProphetHedgeSpread` undefined.

- [ ] **Step 3: Create the models**

`models/prophet_hedge_models.go`:
```go
package models

import (
	"time"

	"gorm.io/gorm"
)

// DBProphetHedgeSpread is one defined-risk QQQ put-debit-spread opened by the
// defensive-Prophet hedge. Dedicated table (multi-leg doesn't fit the
// single-symbol managed_positions model — same reason Harvest uses its own
// condor table). Closed rows are retained for audit; the stored strikes +
// debit let the (deferred) grader recompute the synthetic stress-payoff
// (D-DP13) from QQQ history without a separate daily series.
type DBProphetHedgeSpread struct {
	gorm.Model
	SpreadID   string    `gorm:"uniqueIndex"`
	Underlying string    `gorm:"index"` // "QQQ"
	Expiration time.Time

	LongPutSymbol  string
	LongPutStrike  float64
	ShortPutSymbol string
	ShortPutStrike float64

	Contracts           int
	NetDebitPerContract float64 // per-share net debit (long mid − short mid)
	TotalDebit          float64 // NetDebitPerContract * 100 * Contracts (max loss)
	MaxPayoff           float64 // ((longK − shortK) − netDebit) * 100 * Contracts
	RegimeScoreAtEntry  int
	PortfolioValueAtEntry float64

	EntryOrderID string
	CloseOrderID string `gorm:"column:close_order_id"`

	// Status: pending_fill | open | closing | closed | failed
	Status      string `gorm:"index"`
	CloseReason string  // harvest | roll | expire | itm_short | reconciled
	RealizedPnL float64 `gorm:"column:realized_pnl"`
	OpenedAt    time.Time
	ClosedAt    *time.Time
}

// DBProphetHedgeSession is the singleton per-day run state, mirroring
// DBTurtleSession. Queried by hardcoded SessionID = "singleton".
type DBProphetHedgeSession struct {
	gorm.Model
	SessionID         string `gorm:"uniqueIndex"`
	LastHeartbeatDate string // ISO date (YYYY-MM-DD); "" on first run
}

func (DBProphetHedgeSpread) TableName() string  { return "prophet_hedge_spreads" }
func (DBProphetHedgeSession) TableName() string { return "prophet_hedge_session" }
```

- [ ] **Step 4: Register AutoMigrate + add storage methods**

In `database/storage.go`, append to the `AutoMigrate(...)` list (after `&models.DBTurtleSession{},`):
```go
		&models.DBProphetHedgeSpread{},
		&models.DBProphetHedgeSession{},
```
Add storage methods (near the Turtle ledger methods; match the file's existing style):
```go
// ── Defensive-Prophet hedge storage ────────────────────────────────

func (s *LocalStorage) SaveProphetHedgeSpread(e *models.DBProphetHedgeSpread) error {
	return s.db.Save(e).Error
}

// ListOpenProphetHedgeSpreads returns spreads still in a live state
// (pending_fill, open, closing) — the set the executor reconciles/manages.
func (s *LocalStorage) ListOpenProphetHedgeSpreads() ([]*models.DBProphetHedgeSpread, error) {
	var out []*models.DBProphetHedgeSpread
	err := s.db.Where("status IN ?", []string{"pending_fill", "open", "closing"}).Find(&out).Error
	return out, err
}

func (s *LocalStorage) GetProphetHedgeSpreadByID(id uint) (*models.DBProphetHedgeSpread, error) {
	var e models.DBProphetHedgeSpread
	if err := s.db.First(&e, id).Error; err != nil {
		return nil, err
	}
	return &e, nil
}

func (s *LocalStorage) GetProphetHedgeSession() (*models.DBProphetHedgeSession, error) {
	var sess models.DBProphetHedgeSession
	err := s.db.Where("session_id = ?", "singleton").First(&sess).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil // first run
		}
		return nil, err
	}
	return &sess, nil
}

func (s *LocalStorage) SaveProphetHedgeSession(sess *models.DBProphetHedgeSession) error {
	if sess.SessionID == "" {
		sess.SessionID = "singleton"
	}
	return s.db.Save(sess).Error
}

// GetProphetHedgeClosedPnL sums RealizedPnL of spreads CLOSED within [start,end)
// — the realized half the segment writer needs (D-DP9), analogous to
// GetHarvestClosedPnL.
func (s *LocalStorage) GetProphetHedgeClosedPnL(start, end time.Time) (float64, error) {
	var total float64
	err := s.db.Model(&models.DBProphetHedgeSpread{}).
		Where("status = ? AND closed_at >= ? AND closed_at < ?", "closed", start, end).
		Select("COALESCE(SUM(realized_pnl), 0)").Scan(&total).Error
	return total, err
}
```
(Confirm `errors` and `gorm` are already imported in storage.go — they are, used by sibling methods.)

- [ ] **Step 5: Run test to verify it passes**

Run: `go test ./database/ -run ProphetHedge -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add models/prophet_hedge_models.go database/storage.go database/storage_prophet_hedge_test.go
git commit -m "feat(defensive-prophet): hedge spread/session models + storage + AutoMigrate"
```

---

### Task 3: Ledger façade

**Files:**
- Create: `services/prophet_hedge_ledger.go`
- Test: `services/prophet_hedge_ledger_test.go`

- [ ] **Step 1: Write the failing test**

```go
package services

import (
	"testing"

	"prophet-trader/models"
)

type fakeHedgeStore struct {
	spreads map[string]*models.DBProphetHedgeSpread
	session *models.DBProphetHedgeSession
}

func newFakeHedgeStore() *fakeHedgeStore {
	return &fakeHedgeStore{spreads: map[string]*models.DBProphetHedgeSpread{}}
}
func (f *fakeHedgeStore) SaveProphetHedgeSpread(e *models.DBProphetHedgeSpread) error {
	f.spreads[e.SpreadID] = e
	return nil
}
func (f *fakeHedgeStore) ListOpenProphetHedgeSpreads() ([]*models.DBProphetHedgeSpread, error) {
	var out []*models.DBProphetHedgeSpread
	for _, s := range f.spreads {
		if s.Status == "pending_fill" || s.Status == "open" || s.Status == "closing" {
			out = append(out, s)
		}
	}
	return out, nil
}
func (f *fakeHedgeStore) GetProphetHedgeSpreadByID(id uint) (*models.DBProphetHedgeSpread, error) {
	return nil, nil
}
func (f *fakeHedgeStore) GetProphetHedgeSession() (*models.DBProphetHedgeSession, error) {
	return f.session, nil
}
func (f *fakeHedgeStore) SaveProphetHedgeSession(s *models.DBProphetHedgeSession) error {
	f.session = s
	return nil
}

func TestHedgeLedger_SessionRoundTrip(t *testing.T) {
	l := NewProphetHedgeLedger(newFakeHedgeStore())
	got, err := l.Session()
	if err != nil || got != nil {
		t.Fatalf("first-run session should be (nil,nil), got (%v,%v)", got, err)
	}
	if err := l.SaveSession(&models.DBProphetHedgeSession{LastHeartbeatDate: "2026-06-01"}); err != nil {
		t.Fatalf("save: %v", err)
	}
	got, _ = l.Session()
	if got == nil || got.LastHeartbeatDate != "2026-06-01" {
		t.Fatalf("session not persisted")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/ -run HedgeLedger -v`
Expected: FAIL — `NewProphetHedgeLedger` undefined.

- [ ] **Step 3: Implement the façade**

`services/prophet_hedge_ledger.go`:
```go
package services

import "prophet-trader/models"

// hedgeLedgerStore is the storage subset the ledger needs. Implemented by
// *database.LocalStorage; tests substitute an in-memory fake.
type hedgeLedgerStore interface {
	SaveProphetHedgeSpread(e *models.DBProphetHedgeSpread) error
	ListOpenProphetHedgeSpreads() ([]*models.DBProphetHedgeSpread, error)
	GetProphetHedgeSpreadByID(id uint) (*models.DBProphetHedgeSpread, error)
	GetProphetHedgeSession() (*models.DBProphetHedgeSession, error)
	SaveProphetHedgeSession(s *models.DBProphetHedgeSession) error
}

// ProphetHedgeLedger is a thin, stateless façade over the hedge storage methods.
type ProphetHedgeLedger struct{ store hedgeLedgerStore }

func NewProphetHedgeLedger(store hedgeLedgerStore) *ProphetHedgeLedger {
	return &ProphetHedgeLedger{store: store}
}

func (l *ProphetHedgeLedger) Save(e *models.DBProphetHedgeSpread) error {
	return l.store.SaveProphetHedgeSpread(e)
}
func (l *ProphetHedgeLedger) ListOpen() ([]*models.DBProphetHedgeSpread, error) {
	return l.store.ListOpenProphetHedgeSpreads()
}
func (l *ProphetHedgeLedger) Session() (*models.DBProphetHedgeSession, error) {
	return l.store.GetProphetHedgeSession()
}
func (l *ProphetHedgeLedger) SaveSession(s *models.DBProphetHedgeSession) error {
	return l.store.SaveProphetHedgeSession(s)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./services/ -run HedgeLedger -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/prophet_hedge_ledger.go services/prophet_hedge_ledger_test.go
git commit -m "feat(defensive-prophet): hedge ledger façade"
```

---

## Phase B — Pure decision functions (TDD)

### Task 4: `deriveArm` (D-DP1 correctness pin)

**Files:**
- Create: `services/prophet_hedge_lifecycle.go`
- Test: `services/prophet_hedge_lifecycle_test.go`

- [ ] **Step 1: Write the failing test**

```go
package services

import "testing"

func TestDeriveArm(t *testing.T) {
	cases := []struct {
		name   string
		status RegimeGateStatus
		want   bool
	}{
		{"armed below threshold", RegimeGateStatus{Tier: "DEFENSIVE", Score: 30}, true},
		{"armed lower-normal", RegimeGateStatus{Tier: "NORMAL", Score: 49}, true},
		{"disarmed at threshold", RegimeGateStatus{Tier: "NORMAL", Score: 50}, false},
		{"disarmed green", RegimeGateStatus{Tier: "GREEN", Score: 80}, false},
		{"UNKNOWN never arms even with score 0", RegimeGateStatus{Tier: "UNKNOWN", Score: 0}, false},
		{"stale never arms", RegimeGateStatus{Tier: "RED", Score: 10, IsStale: true}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got, _ := deriveArm(c.status); got != c.want {
				t.Fatalf("deriveArm(%+v) = %v, want %v", c.status, got, c.want)
			}
		})
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/ -run DeriveArm -v`
Expected: FAIL — `deriveArm` undefined.

- [ ] **Step 3: Implement**

`services/prophet_hedge_lifecycle.go`:
```go
package services

import "prophet-trader/models"

// deriveArm decides whether the hedge may OPEN new spreads this beat.
// CRITICAL (D-DP1): RegimeGateService.GetStatus() returns Score=0 / Tier=UNKNOWN
// when the regime file is missing or unparseable, and IsStale past the freshness
// window. A naive Score<threshold test would arm on blind data (0 < 50). So a
// valid, fresh tier is required. UNKNOWN/stale ⇒ NOT armed (don't open on blind
// data) — but the caller must NOT force-close existing spreads on this signal.
func deriveArm(s RegimeGateStatus) (armed bool, reason string) {
	if s.Tier == "UNKNOWN" {
		return false, "regime tier UNKNOWN (missing/unparseable) — not arming"
	}
	if s.IsStale {
		return false, "regime data stale — not arming"
	}
	if s.Score >= hedgeArmThreshold {
		return false, "regime score >= arm threshold (disarmed)"
	}
	return true, ""
}
```
(`hedgeArmThreshold` is defined in Task 11's constant block; if implementing this task first, add the const here and remove the duplicate when Task 11 lands. To avoid that, define the const block from the executor file now — see Task 11 note.)

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./services/ -run DeriveArm -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/prophet_hedge_lifecycle.go services/prophet_hedge_lifecycle_test.go
git commit -m "feat(defensive-prophet): deriveArm with UNKNOWN/stale fail-safe (D-DP1)"
```

---

### Task 5: `SpreadProfile` + `selectStructure` (D-DP4 fixed v1 + seam)

**Files:**
- Create: `services/prophet_hedge_structure.go`
- Test: `services/prophet_hedge_structure_test.go`

- [ ] **Step 1: Write the failing test**

```go
package services

import "testing"

func TestSelectStructure_FixedV1(t *testing.T) {
	// v1 ignores regime/iv and always returns the fixed tail-targeted profile.
	p := selectStructure(RegimeGateStatus{Score: 10}, 0.0)
	if p.LongPctOTM != hedgeLongPctOTM || p.ShortPctOTM != hedgeShortPctOTM {
		t.Fatalf("v1 must return fixed OTM %.2f/%.2f, got %.2f/%.2f",
			hedgeLongPctOTM, hedgeShortPctOTM, p.LongPctOTM, p.ShortPctOTM)
	}
	if p.DTEMin != hedgeDTEMin || p.DTEMax != hedgeDTEMax {
		t.Fatalf("v1 must return fixed DTE band")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/ -run SelectStructure -v`
Expected: FAIL — `selectStructure`/`SpreadProfile` undefined.

- [ ] **Step 3: Implement**

In `services/prophet_hedge_structure.go`:
```go
package services

// SpreadProfile is the structural recipe for a put-debit-spread: how far OTM
// each leg sits and the acceptable DTE band. The single choke point for
// structure selection — the deferred v2 (D-DP4) makes selectStructure return a
// regime/IV-conditional profile with zero changes to the executor.
type SpreadProfile struct {
	LongPctOTM  float64 // long put strike target = spot * (1 - LongPctOTM)
	ShortPctOTM float64 // short put strike target = spot * (1 - ShortPctOTM)
	DTEMin      int
	DTEMax      int
}

// selectStructure returns the spread recipe. v1 (D-DP4) ignores regime and iv
// and always returns the fixed tail-targeted profile; the parameters exist so
// the v2 conditional policy is a drop-in.
func selectStructure(_ RegimeGateStatus, _ float64) SpreadProfile {
	return SpreadProfile{
		LongPctOTM:  hedgeLongPctOTM,
		ShortPctOTM: hedgeShortPctOTM,
		DTEMin:      hedgeDTEMin,
		DTEMax:      hedgeDTEMax,
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./services/ -run SelectStructure -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/prophet_hedge_structure.go services/prophet_hedge_structure_test.go
git commit -m "feat(defensive-prophet): SpreadProfile + selectStructure fixed-v1 seam (D-DP4)"
```

---

### Task 6: `pickPutStrikes` (strike selection from a chain)

**Files:**
- Modify: `services/prophet_hedge_structure.go`
- Test: `services/prophet_hedge_structure_test.go`

`GetOptionChain` returns `map[string]*interfaces.OptionContract` keyed by symbol with `StrikePrice`, `ContractType` ("put"/"call"), `ExpirationDate`, `DTE` — but NOT bid/ask (those come from `GetOptionSnapshot` per symbol). So selection is pure; pricing is I/O done by the executor (Task 14).

- [ ] **Step 1: Write the failing test**

```go
func TestPickPutStrikes(t *testing.T) {
	spot := 100.0
	chain := map[string]*interfaces.OptionContract{
		"P80":  {Symbol: "P80", ContractType: "put", StrikePrice: 80},
		"P85":  {Symbol: "P85", ContractType: "put", StrikePrice: 85},
		"P90":  {Symbol: "P90", ContractType: "put", StrikePrice: 90},
		"P95":  {Symbol: "P95", ContractType: "put", StrikePrice: 95},
		"C95":  {Symbol: "C95", ContractType: "call", StrikePrice: 95}, // ignored
	}
	// long target = 100*(1-.05)=95 ; short target = 100*(1-.15)=85
	long, short, ok := pickPutStrikes(chain, spot, SpreadProfile{LongPctOTM: 0.05, ShortPctOTM: 0.15})
	if !ok {
		t.Fatal("expected ok")
	}
	if long.Symbol != "P95" || short.Symbol != "P85" {
		t.Fatalf("got long=%s short=%s, want P95/P85", long.Symbol, short.Symbol)
	}
}

func TestPickPutStrikes_DegenerateChain(t *testing.T) {
	// Only one put → cannot form a two-leg spread.
	chain := map[string]*interfaces.OptionContract{
		"P95": {Symbol: "P95", ContractType: "put", StrikePrice: 95},
	}
	if _, _, ok := pickPutStrikes(chain, 100, SpreadProfile{LongPctOTM: 0.05, ShortPctOTM: 0.15}); ok {
		t.Fatal("expected ok=false on degenerate chain")
	}
}
```
(Add `"prophet-trader/interfaces"` to the test imports.)

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/ -run PickPutStrikes -v`
Expected: FAIL — `pickPutStrikes` undefined.

- [ ] **Step 3: Implement**

Append to `services/prophet_hedge_structure.go` (add `"math"` + `"prophet-trader/interfaces"` to imports):
```go
// pickPutStrikes selects the long and short put legs from a chain by nearest
// listed strike to the profile's % OTM targets. Returns ok=false if the chain
// lacks two distinct puts straddling the targets (degenerate chain → caller
// skips this beat, never half-builds). Pure: no I/O, no pricing.
func pickPutStrikes(chain map[string]*interfaces.OptionContract, spot float64, p SpreadProfile) (long, short *interfaces.OptionContract, ok bool) {
	longTarget := spot * (1 - p.LongPctOTM)
	shortTarget := spot * (1 - p.ShortPctOTM)
	long = nearestPut(chain, longTarget)
	short = nearestPut(chain, shortTarget)
	if long == nil || short == nil {
		return nil, nil, false
	}
	if long.StrikePrice <= short.StrikePrice {
		// must be a genuine debit spread: long strike strictly above short strike
		return nil, nil, false
	}
	return long, short, true
}

func nearestPut(chain map[string]*interfaces.OptionContract, target float64) *interfaces.OptionContract {
	var best *interfaces.OptionContract
	bestDist := math.MaxFloat64
	for _, c := range chain {
		if c.ContractType != "put" {
			continue
		}
		if d := math.Abs(c.StrikePrice - target); d < bestDist {
			bestDist = d
			best = c
		}
	}
	return best
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./services/ -run PickPutStrikes -v`
Expected: PASS (both).

- [ ] **Step 5: Commit**

```bash
git add services/prophet_hedge_structure.go services/prophet_hedge_structure_test.go
git commit -m "feat(defensive-prophet): pickPutStrikes strike selection (degenerate-chain safe)"
```

---

### Task 7: `sizeSpread` (D-DP6 cap + D-DP16 zero-contract)

**Files:**
- Modify: `services/prophet_hedge_structure.go`
- Test: `services/prophet_hedge_structure_test.go`

- [ ] **Step 1: Write the failing test**

```go
func TestSizeSpread(t *testing.T) {
	// portfolio 100k, cap 1% = $1000 budget. debit per contract = $800 (=$8/sh*100).
	if n := sizeSpread(100_000, 8.0); n != 1 {
		t.Fatalf("want 1 contract, got %d", n)
	}
	// debit $1500/contract exceeds the $1000 cap → 0 contracts (unaffordable).
	if n := sizeSpread(100_000, 15.0); n != 0 {
		t.Fatalf("want 0 (unaffordable), got %d", n)
	}
	// budget fits 2 contracts ($400 each = $800 ≤ $1000).
	if n := sizeSpread(100_000, 4.0); n != 2 {
		t.Fatalf("want 2 contracts, got %d", n)
	}
	// non-positive inputs → 0.
	if n := sizeSpread(0, 8.0); n != 0 {
		t.Fatalf("want 0 on zero portfolio")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/ -run SizeSpread -v`
Expected: FAIL — `sizeSpread` undefined.

- [ ] **Step 3: Implement**

```go
// sizeSpread returns the contract count whose total net debit fits the
// per-spread cap (hedgeDebitCapPct of portfolio). debitPerShare is the net
// debit per share (long mid − short mid); ×100 = per-contract cost. Returns 0
// when even ONE contract exceeds the cap — the executor treats 0 as an
// explicit, grade-visible "armed but unaffordable" skip (D-DP16), never a
// silent no-op.
func sizeSpread(portfolio, debitPerShare float64) int {
	if portfolio <= 0 || debitPerShare <= 0 {
		return 0
	}
	budget := portfolio * hedgeDebitCapPct
	perContract := debitPerShare * 100
	n := int(budget / perContract)
	if n < 0 {
		n = 0
	}
	return n
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./services/ -run SizeSpread -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/prophet_hedge_structure.go services/prophet_hedge_structure_test.go
git commit -m "feat(defensive-prophet): sizeSpread debit cap + zero-contract case (D-DP6/D-DP16)"
```

---

### Task 8: `marketableLimit` (D-DP T2.2)

**Files:**
- Modify: `services/prophet_hedge_structure.go`
- Test: `services/prophet_hedge_structure_test.go`

- [ ] **Step 1: Write the failing test**

```go
func TestMarketableLimit(t *testing.T) {
	// long mid 6.00, short mid 1.00 → net debit mid = 5.00. width = (longAsk-longBid)+(shortAsk-shortBid).
	// buffer = 25% of total width. longBA=0.40, shortBA=0.20 → width=0.60 → buffer=0.15 → limit=5.15.
	got := marketableLimit(6.00, 1.00, 0.40, 0.20, 0.25)
	if diff := got - 5.15; diff > 1e-9 || diff < -1e-9 {
		t.Fatalf("want 5.15, got %.4f", got)
	}
	// intrinsic ceiling: never pay above (longStrike-shortStrike). Caller passes
	// the ceiling; here verify the cap clamps. width huge → clamp to ceiling 10.
	if got := marketableLimitCapped(6.00, 1.00, 100, 100, 0.25, 10.0); got != 10.0 {
		t.Fatalf("want clamp to 10.0, got %.4f", got)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/ -run MarketableLimit -v`
Expected: FAIL — undefined.

- [ ] **Step 3: Implement**

```go
// marketableLimit computes a net-debit limit price that crosses partway into the
// spread to actually fill in a fast move (D-DP T2.2): net mid debit + a fraction
// of the combined bid/ask width. longMid/shortMid are per-share mids;
// longBA/shortBA are the per-leg bid/ask widths; bufferFrac is the fraction of
// total width to add.
func marketableLimit(longMid, shortMid, longBA, shortBA, bufferFrac float64) float64 {
	netMid := longMid - shortMid
	width := longBA + shortBA
	return netMid + bufferFrac*width
}

// marketableLimitCapped clamps the marketable limit to the intrinsic ceiling
// (long strike − short strike per share) so we never pay above the spread's
// maximum possible value.
func marketableLimitCapped(longMid, shortMid, longBA, shortBA, bufferFrac, intrinsicCeiling float64) float64 {
	lim := marketableLimit(longMid, shortMid, longBA, shortBA, bufferFrac)
	if lim > intrinsicCeiling {
		return intrinsicCeiling
	}
	return lim
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./services/ -run MarketableLimit -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/prophet_hedge_structure.go services/prophet_hedge_structure_test.go
git commit -m "feat(defensive-prophet): marketable-limit pricing with intrinsic ceiling (T2.2)"
```

---

### Task 9: Lifecycle predicates (D-DP5 + D-DP T2.4)

**Files:**
- Modify: `services/prophet_hedge_lifecycle.go`
- Test: `services/prophet_hedge_lifecycle_test.go`

- [ ] **Step 1: Write the failing test**

```go
func TestLifecyclePredicates(t *testing.T) {
	now := time.Date(2026, 6, 1, 17, 0, 0, 0, time.UTC)
	exp := now.Add(40 * 24 * time.Hour) // DTE 40
	near := now.Add(5 * 24 * time.Hour) // DTE 5
	sp := &models.DBProphetHedgeSpread{
		Expiration: exp, MaxPayoff: 1000, ShortPutStrike: 425,
	}

	// harvest: current value ≥ 60% of max payoff
	if !shouldHarvest(sp, 600) {
		t.Fatal("600 ≥ 60% of 1000 → harvest")
	}
	if shouldHarvest(sp, 599) {
		t.Fatal("599 < 60% → hold")
	}
	// roll: DTE ≤ 21 and armed
	spNear := &models.DBProphetHedgeSpread{Expiration: near, ShortPutStrike: 425}
	if !shouldRoll(spNear, now, true) {
		t.Fatal("DTE 5 & armed → roll")
	}
	if shouldRoll(spNear, now, false) {
		t.Fatal("DTE 5 & disarmed → not roll (expire path)")
	}
	// expire: DTE ≤ 21 and disarmed
	if !shouldExpire(spNear, now, false) {
		t.Fatal("DTE 5 & disarmed → expire")
	}
	if shouldExpire(spNear, now, true) {
		t.Fatal("DTE 5 & armed → not expire (roll path)")
	}
	// ITM-short assignment defense: DTE ≤ 7 and QQQ ≤ short strike
	if !shouldCloseITMShort(spNear, now, 420) {
		t.Fatal("DTE 5 & spot 420 ≤ short 425 → close")
	}
	if shouldCloseITMShort(spNear, now, 430) {
		t.Fatal("spot 430 > short 425 → no assignment risk")
	}
	if shouldCloseITMShort(sp, now, 420) {
		t.Fatal("DTE 40 not near expiry → not ITM-short rule")
	}
}
```
(Add `"time"` and `"prophet-trader/models"` to the test imports if not present.)

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/ -run LifecyclePredicates -v`
Expected: FAIL — predicates undefined.

- [ ] **Step 3: Implement**

Append to `services/prophet_hedge_lifecycle.go` (add `"time"` + `"prophet-trader/models"`):
```go
func hedgeDTE(sp *models.DBProphetHedgeSpread, now time.Time) int {
	return int(sp.Expiration.Sub(now).Hours() / 24)
}

// shouldHarvest: close to bank the spike when the spread's current market value
// reaches hedgeHarvestFrac of its max payoff (D-DP5).
func shouldHarvest(sp *models.DBProphetHedgeSpread, currentValue float64) bool {
	if sp.MaxPayoff <= 0 {
		return false
	}
	return currentValue >= hedgeHarvestFrac*sp.MaxPayoff
}

// shouldRoll: at/under the roll DTE floor AND still armed → close + reopen.
func shouldRoll(sp *models.DBProphetHedgeSpread, now time.Time, armed bool) bool {
	return armed && hedgeDTE(sp, now) <= hedgeRollDTE
}

// shouldExpire: at/under the roll DTE floor AND disarmed → let it expire / close.
func shouldExpire(sp *models.DBProphetHedgeSpread, now time.Time, armed bool) bool {
	return !armed && hedgeDTE(sp, now) <= hedgeRollDTE
}

// shouldCloseITMShort: assignment defense (D-DP T2.4). The short put is the
// lower/more-OTM strike, so the harvest rule preempts most cases; this covers
// the residual (overnight gap, slow disarmed grind to expiry). Close if near
// expiry AND spot is at/below the short strike (short leg ITM, early-assignment
// risk on American-style QQQ options).
func shouldCloseITMShort(sp *models.DBProphetHedgeSpread, now time.Time, spot float64) bool {
	return hedgeDTE(sp, now) <= hedgeITMShortDTE && spot <= sp.ShortPutStrike
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./services/ -run LifecyclePredicates -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/prophet_hedge_lifecycle.go services/prophet_hedge_lifecycle_test.go
git commit -m "feat(defensive-prophet): harvest/roll/expire/ITM-short predicates (D-DP5/T2.4)"
```

---

### Task 10: `syntheticStressPayoff` (D-DP13 — calm-quarter gradability)

**Files:**
- Modify: `services/prophet_hedge_structure.go`
- Test: `services/prophet_hedge_structure_test.go`

- [ ] **Step 1: Write the failing test**

```go
func TestSyntheticStressPayoff(t *testing.T) {
	// spot 100, long put 95, short put 85, debit 3.00/sh, 2 contracts.
	// Per-share terminal-intrinsic payoff at shocked spot S:
	//   max(0,95-S) - max(0,85-S) - 3 , then *100*contracts.
	sp := &models.DBProphetHedgeSpread{
		LongPutStrike: 95, ShortPutStrike: 85, NetDebitPerContract: 3.0, Contracts: 2,
	}
	// −10% shock → S=90: (95-90)=5 ; (85-90)→0 ; 5-0-3 = 2 /sh → *100*2 = 400
	if got := syntheticStressPayoff(sp, 100, 0.10); got != 400 {
		t.Fatalf("-10%% want 400, got %.2f", got)
	}
	// −20% shock → S=80: (95-80)=15 ; (85-80)=5 ; 15-5-3 = 7 /sh → *100*2 = 1400 (capped at width-debit)
	if got := syntheticStressPayoff(sp, 100, 0.20); got != 1400 {
		t.Fatalf("-20%% want 1400, got %.2f", got)
	}
	// no shock (0%) → S=100: both puts OTM → -3/sh → *200 = -600 (full debit loss)
	if got := syntheticStressPayoff(sp, 100, 0.0); got != -600 {
		t.Fatalf("0%% want -600, got %.2f", got)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/ -run SyntheticStressPayoff -v`
Expected: FAIL — undefined.

- [ ] **Step 3: Implement**

```go
// syntheticStressPayoff (D-DP13) returns the spread's terminal-intrinsic P&L if
// QQQ were `shockFrac` lower at expiry — a conservative, model-light payoff-
// capacity measure (no greeks/IV) so the hedge is gradable even in a calm
// quarter with zero real drawdown days. Stored strikes + debit let the deferred
// grader recompute this from QQQ history without a separate daily series.
func syntheticStressPayoff(sp *models.DBProphetHedgeSpread, spot, shockFrac float64) float64 {
	shocked := spot * (1 - shockFrac)
	longIntrinsic := sp.LongPutStrike - shocked
	if longIntrinsic < 0 {
		longIntrinsic = 0
	}
	shortIntrinsic := sp.ShortPutStrike - shocked
	if shortIntrinsic < 0 {
		shortIntrinsic = 0
	}
	perShare := longIntrinsic - shortIntrinsic - sp.NetDebitPerContract
	return perShare * 100 * float64(sp.Contracts)
}
```
(Requires `"prophet-trader/models"` — already imported via Task 6/9 in this package; ensure the structure file imports it.)

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./services/ -run SyntheticStressPayoff -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/prophet_hedge_structure.go services/prophet_hedge_structure_test.go
git commit -m "feat(defensive-prophet): syntheticStressPayoff terminal-intrinsic (D-DP13)"
```

---

## Phase C — Executor (TDD against mocks)

### Task 11: Executor skeleton + interfaces + arm/session scaffolding

**Files:**
- Create: `services/prophet_hedge_executor.go`
- Test: `services/prophet_hedge_executor_test.go`

**Note on constants:** put the `const (...)` block from the File Structure section at the top of this file. If Tasks 4–10 were implemented first and added `hedgeArmThreshold` etc. locally, move them all here now and delete duplicates so the package compiles.

- [ ] **Step 1: Write the failing test**

```go
package services

import (
	"context"
	"testing"
	"time"

	"prophet-trader/interfaces"
	"prophet-trader/models"
)

// --- mocks ---
type stubRegime struct{ st RegimeGateStatus }
func (s stubRegime) GetStatus() RegimeGateStatus { return s.st }

type stubChain struct {
	chain map[string]*interfaces.OptionContract
	snaps map[string]*interfaces.OptionContract
}
func (s stubChain) GetOptionChain(_ context.Context, _ string, _ time.Time) (map[string]*interfaces.OptionContract, error) {
	return s.chain, nil
}
func (s stubChain) GetOptionSnapshot(_ context.Context, sym string) (*interfaces.OptionContract, error) {
	return s.snaps[sym], nil
}

type placedMleg struct{ order MultiLegOrder }
type stubMleg struct {
	placed []placedMleg
	orders map[string]*interfaces.Order
	nextID int
}
func (s *stubMleg) PlaceMultiLegOrder(_ context.Context, o MultiLegOrder) (string, error) {
	s.nextID++
	s.placed = append(s.placed, placedMleg{order: o})
	return "mleg-ord", nil
}
func (s *stubMleg) GetOrder(_ context.Context, id string) (*interfaces.Order, error) {
	return s.orders[id], nil
}

type stubAcct struct{ pv float64; bars map[string]*interfaces.Bar }
func (s stubAcct) GetAccount(_ context.Context) (*interfaces.Account, error) {
	return &interfaces.Account{PortfolioValue: s.pv}, nil
}
func (s stubAcct) GetLatestBar(_ context.Context, sym string) (*interfaces.Bar, error) {
	return s.bars[sym], nil
}

func TestRunHeartbeat_OutOfWindowSkips(t *testing.T) {
	led := NewProphetHedgeLedger(newFakeHedgeStore())
	ex := NewProphetHedgeExecutor(led, stubRegime{}, stubChain{}, &stubMleg{}, stubAcct{}, nil, nil)
	// 09:00 ET is outside the 17:00-17:10 window.
	now := time.Date(2026, 6, 1, 13, 0, 0, 0, time.UTC) // 09:00 ET
	res, err := ex.RunHeartbeat(context.Background(), now)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if res.Skipped == "" {
		t.Fatal("expected out-of-window skip")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/ -run RunHeartbeat_OutOfWindow -v`
Expected: FAIL — `NewProphetHedgeExecutor` undefined.

- [ ] **Step 3: Implement skeleton**

`services/prophet_hedge_executor.go` (constants block + interfaces + struct + RunHeartbeat shell):
```go
package services

import (
	"context"
	"fmt"
	"io"
	"time"

	"prophet-trader/interfaces"
	"prophet-trader/models"

	"github.com/sirupsen/logrus"
)

const ( /* the const block from File Structure */ )

type hedgeRegimeFetcher interface{ GetStatus() RegimeGateStatus }
type hedgeChainFetcher interface {
	GetOptionChain(ctx context.Context, underlying string, exp time.Time) (map[string]*interfaces.OptionContract, error)
	GetOptionSnapshot(ctx context.Context, optionSymbol string) (*interfaces.OptionContract, error)
}
type hedgeMlegTrader interface {
	PlaceMultiLegOrder(ctx context.Context, order MultiLegOrder) (string, error)
	GetOrder(ctx context.Context, orderID string) (*interfaces.Order, error)
}
type hedgeAccountFetcher interface {
	GetAccount(ctx context.Context) (*interfaces.Account, error)
	GetLatestBar(ctx context.Context, symbol string) (*interfaces.Bar, error)
}
// hedgeGuard is the options-through-guard subset; nil-guard is allowed (skips the check).
type hedgeGuard interface {
	CheckOptionsOpen(agent AgentSource, underlying, symbol string, quote *interfaces.OptionsQuote, now time.Time) error
}

// HedgeResult is the per-beat outcome (cached by the scheduler / status endpoint).
type HedgeResult struct {
	Date      string   `json:"date"`
	Armed     bool     `json:"armed"`
	ArmReason string   `json:"arm_reason,omitempty"`
	OpenCount int      `json:"open_count"`
	Opened    []string `json:"opened,omitempty"`
	Closed    []string `json:"closed,omitempty"`
	Skips     []string `json:"skips,omitempty"`
	Errors    []string `json:"errors,omitempty"`
	Skipped   string   `json:"skipped,omitempty"`
}

type ProphetHedgeExecutor struct {
	ledger *ProphetHedgeLedger
	regime hedgeRegimeFetcher
	chain  hedgeChainFetcher
	trader hedgeMlegTrader
	acct   hedgeAccountFetcher
	guard  hedgeGuard
	logger *logrus.Logger
}

func NewProphetHedgeExecutor(ledger *ProphetHedgeLedger, regime hedgeRegimeFetcher, chain hedgeChainFetcher, trader hedgeMlegTrader, acct hedgeAccountFetcher, guard hedgeGuard, logger *logrus.Logger) *ProphetHedgeExecutor {
	if logger == nil {
		logger = logrus.New()
		logger.SetOutput(io.Discard)
	}
	return &ProphetHedgeExecutor{ledger, regime, chain, trader, acct, guard, logger}
}

func (e *ProphetHedgeExecutor) preloopCheck(now time.Time, session *models.DBProphetHedgeSession) string {
	local := now.In(nyLoc)
	mins := local.Hour()*60 + local.Minute()
	if mins < hedgeWindowStartMin || mins > hedgeWindowEndMin {
		return fmt.Sprintf("out-of-window: %02d:%02d ET (runs 17:00-17:10)", local.Hour(), local.Minute())
	}
	if session != nil && session.LastHeartbeatDate == local.Format("2006-01-02") {
		return fmt.Sprintf("duplicate heartbeat for %s — skipping", session.LastHeartbeatDate)
	}
	return ""
}

func (e *ProphetHedgeExecutor) RunHeartbeat(ctx context.Context, now time.Time) (*HedgeResult, error) {
	res := &HedgeResult{Date: now.In(nyLoc).Format("2006-01-02")}
	session, err := e.ledger.Session()
	if err != nil {
		res.Errors = append(res.Errors, fmt.Sprintf("load session: %v", err))
		return res, nil
	}
	if reason := e.preloopCheck(now, session); reason != "" {
		res.Skipped = reason
		return res, nil
	}
	if session == nil {
		session = &models.DBProphetHedgeSession{SessionID: "singleton"}
	}

	armed, armReason := deriveArm(e.regime.GetStatus())
	res.Armed, res.ArmReason = armed, armReason

	open, err := e.ledger.ListOpen()
	if err != nil {
		res.Errors = append(res.Errors, fmt.Sprintf("list open: %v", err))
		return res, nil
	}
	// Task 12: reconcile pending fills. Task 13: manage open. Task 14: open new.
	e.reconcile(ctx, open, now, res)
	e.manageOpen(ctx, open, now, armed, res)
	if armed && len(res.Errors) == 0 {
		e.openNew(ctx, open, now, res)
	}

	session.LastHeartbeatDate = res.Date
	if err := e.ledger.SaveSession(session); err != nil {
		res.Errors = append(res.Errors, fmt.Sprintf("save session: %v", err))
	}
	if fresh, err := e.ledger.ListOpen(); err == nil {
		res.OpenCount = len(fresh)
	}
	return res, nil
}

// Stubs filled in Tasks 12-14 (define empty bodies now so the package compiles).
func (e *ProphetHedgeExecutor) reconcile(ctx context.Context, open []*models.DBProphetHedgeSpread, now time.Time, res *HedgeResult) {}
func (e *ProphetHedgeExecutor) manageOpen(ctx context.Context, open []*models.DBProphetHedgeSpread, now time.Time, armed bool, res *HedgeResult) {}
func (e *ProphetHedgeExecutor) openNew(ctx context.Context, open []*models.DBProphetHedgeSpread, now time.Time, res *HedgeResult) {}
```
(Verify `interfaces.Account` has `PortfolioValue`, `interfaces.Bar` has `Close`, and `interfaces.OptionsQuote` exists — all used by Turtle/guard. `nyLoc` is package-scope in `penny_universe_service.go`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./services/ -run RunHeartbeat_OutOfWindow -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/prophet_hedge_executor.go services/prophet_hedge_executor_test.go
git commit -m "feat(defensive-prophet): executor skeleton — preloop, arm, session"
```

---

### Task 12: `reconcile` — pending fills, partial=N spreads, leg-out defense (D-DP15)

**Files:**
- Modify: `services/prophet_hedge_executor.go`
- Test: `services/prophet_hedge_executor_test.go`

- [ ] **Step 1: Write the failing test**

```go
func TestReconcile_FilledTransitionsToOpen(t *testing.T) {
	store := newFakeHedgeStore()
	led := NewProphetHedgeLedger(store)
	avg := 5.0
	mleg := &stubMleg{orders: map[string]*interfaces.Order{
		"o1": {OrderID: "o1", Status: "filled", FilledQty: 2, FilledAvgPrice: &avg},
	}}
	store.spreads["s1"] = &models.DBProphetHedgeSpread{
		SpreadID: "s1", Status: "pending_fill", EntryOrderID: "o1", Contracts: 2,
		LongPutStrike: 95, ShortPutStrike: 85,
	}
	ex := NewProphetHedgeExecutor(led, stubRegime{}, stubChain{}, mleg, stubAcct{}, nil, nil)
	res := &HedgeResult{}
	ex.reconcile(context.Background(), mustOpen(t, led), time.Now(), res)
	if store.spreads["s1"].Status != "open" {
		t.Fatalf("want open, got %s", store.spreads["s1"].Status)
	}
}

func TestReconcile_NeverPersistsSingleLeg(t *testing.T) {
	// Safety-critical (D-DP15): a simulated leg-out must NOT leave an open spread;
	// it transitions to failed (orphan cleanup is logged), never a naked leg.
	store := newFakeHedgeStore()
	led := NewProphetHedgeLedger(store)
	mleg := &stubMleg{orders: map[string]*interfaces.Order{
		// Broker reports a leg-out via a sentinel status the executor treats as fatal.
		"o1": {OrderID: "o1", Status: "canceled", FilledQty: 0},
	}}
	store.spreads["s1"] = &models.DBProphetHedgeSpread{SpreadID: "s1", Status: "pending_fill", EntryOrderID: "o1"}
	ex := NewProphetHedgeExecutor(led, stubRegime{}, stubChain{}, mleg, stubAcct{}, nil, nil)
	ex.reconcile(context.Background(), mustOpen(t, led), time.Now(), &HedgeResult{})
	if s := store.spreads["s1"].Status; s == "open" {
		t.Fatalf("a non-filled combo must never become open (got %s)", s)
	}
}

func mustOpen(t *testing.T, l *ProphetHedgeLedger) []*models.DBProphetHedgeSpread {
	t.Helper()
	o, err := l.ListOpen()
	if err != nil {
		t.Fatalf("listopen: %v", err)
	}
	return o
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/ -run Reconcile -v`
Expected: FAIL — reconcile is a no-op stub.

- [ ] **Step 3: Implement `reconcile`**

Replace the stub:
```go
// reconcile transitions pending_fill spreads by broker order state. mleg combos
// are ATOMIC — "filled"/"partially_filled" means N COMPLETE spreads filled
// (FilledQty = number of complete combos), never a half-spread (D-DP15;
// documented atomic contract, alpaca_trading.go:734). canceled/expired/rejected
// → failed (no position). The ledger can never hold a single-leg position.
func (e *ProphetHedgeExecutor) reconcile(ctx context.Context, open []*models.DBProphetHedgeSpread, now time.Time, res *HedgeResult) {
	for _, sp := range open {
		if sp.Status != "pending_fill" {
			continue
		}
		if sp.EntryOrderID == "" {
			res.Errors = append(res.Errors, fmt.Sprintf("reconcile %s: empty EntryOrderID", sp.SpreadID))
			continue
		}
		ord, err := e.trader.GetOrder(ctx, sp.EntryOrderID)
		if err != nil {
			res.Errors = append(res.Errors, fmt.Sprintf("reconcile %s: GetOrder: %v", sp.SpreadID, err))
			continue
		}
		switch ord.Status {
		case "filled", "partially_filled":
			if ord.FilledAvgPrice == nil || ord.FilledQty < 1 {
				res.Errors = append(res.Errors, fmt.Sprintf("reconcile %s: %s with nil/0 fill — leaving pending", sp.SpreadID, ord.Status))
				continue
			}
			sp.Status = "open"
			sp.Contracts = int(ord.FilledQty) // complete combos actually filled
			sp.NetDebitPerContract = *ord.FilledAvgPrice
			sp.TotalDebit = *ord.FilledAvgPrice * 100 * float64(sp.Contracts)
			sp.MaxPayoff = ((sp.LongPutStrike - sp.ShortPutStrike) - *ord.FilledAvgPrice) * 100 * float64(sp.Contracts)
			sp.OpenedAt = now
			if err := e.ledger.Save(sp); err != nil {
				res.Errors = append(res.Errors, fmt.Sprintf("reconcile %s: save open: %v", sp.SpreadID, err))
			}
		case "canceled", "expired", "rejected":
			sp.Status = "failed"
			sp.CloseReason = "reconciled"
			t := now
			sp.ClosedAt = &t
			if err := e.ledger.Save(sp); err != nil {
				res.Errors = append(res.Errors, fmt.Sprintf("reconcile %s: save failed: %v", sp.SpreadID, err))
			}
		default:
			// new/accepted/pending_new — still working; leave pending_fill.
		}
	}
}
```
(Leg-out cleanup note: if a future broker integration surfaces a true single-leg fill, add an orphan market-close via `PlaceOptionsOrder` here and set status=failed. The atomic contract means this branch is currently unreachable; the test above guards the invariant.)

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./services/ -run Reconcile -v`
Expected: PASS (both).

- [ ] **Step 5: Commit**

```bash
git add services/prophet_hedge_executor.go services/prophet_hedge_executor_test.go
git commit -m "feat(defensive-prophet): reconcile pending fills; never persist single-leg (D-DP15)"
```

---

### Task 13: `manageOpen` — harvest/roll/expire/ITM-short

**Files:**
- Modify: `services/prophet_hedge_executor.go`
- Test: `services/prophet_hedge_executor_test.go`

Closing uses a reverse `mleg` (long→sell_to_close, short→buy_to_close). Current spread value comes from leg snapshots: `value = (longMid − shortMid) × 100 × contracts`. Helper `closeSpread(reason)` places the reverse combo, sets status=`closing`, `CloseReason`, `CloseOrderID`.

- [ ] **Step 1: Write the failing test**

```go
func TestManageOpen_HarvestClosesAtTarget(t *testing.T) {
	store := newFakeHedgeStore()
	led := NewProphetHedgeLedger(store)
	mleg := &stubMleg{}
	// long mid 9.00, short mid 1.00 → value/contract = 8.00*100 = 800; maxPayoff 1000 → 80% ≥ 60% → harvest
	snaps := map[string]*interfaces.OptionContract{
		"L": {Symbol: "L", Bid: 8.9, Ask: 9.1},
		"S": {Symbol: "S", Bid: 0.9, Ask: 1.1},
	}
	store.spreads["s1"] = &models.DBProphetHedgeSpread{
		SpreadID: "s1", Status: "open", Contracts: 1, MaxPayoff: 1000,
		LongPutSymbol: "L", ShortPutSymbol: "S", LongPutStrike: 95, ShortPutStrike: 85,
		Expiration: time.Now().Add(40 * 24 * time.Hour),
	}
	ex := NewProphetHedgeExecutor(led, stubRegime{}, stubChain{snaps: snaps}, mleg, stubAcct{}, nil, nil)
	res := &HedgeResult{}
	ex.manageOpen(context.Background(), mustOpen(t, led), time.Now(), true, res)
	if store.spreads["s1"].Status != "closing" || store.spreads["s1"].CloseReason != "harvest" {
		t.Fatalf("want closing/harvest, got %s/%s", store.spreads["s1"].Status, store.spreads["s1"].CloseReason)
	}
	if len(mleg.placed) != 1 {
		t.Fatalf("expected one reverse combo placed")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/ -run ManageOpen -v`
Expected: FAIL — manageOpen is a no-op.

- [ ] **Step 3: Implement**

```go
func (e *ProphetHedgeExecutor) spreadValue(ctx context.Context, sp *models.DBProphetHedgeSpread) (float64, bool) {
	long, err := e.chain.GetOptionSnapshot(ctx, sp.LongPutSymbol)
	if err != nil || long == nil {
		return 0, false
	}
	short, err := e.chain.GetOptionSnapshot(ctx, sp.ShortPutSymbol)
	if err != nil || short == nil {
		return 0, false
	}
	longMid := (long.Bid + long.Ask) / 2
	shortMid := (short.Bid + short.Ask) / 2
	return (longMid - shortMid) * 100 * float64(sp.Contracts), true
}

func (e *ProphetHedgeExecutor) manageOpen(ctx context.Context, open []*models.DBProphetHedgeSpread, now time.Time, armed bool, res *HedgeResult) {
	for _, sp := range open {
		if sp.Status != "open" {
			continue // pending_fill handled by reconcile; closing already in flight
		}
		var spot float64
		if bar, err := e.acct.GetLatestBar(ctx, sp.Underlying); err == nil && bar != nil {
			spot = bar.Close
		}
		value, valued := e.spreadValue(ctx, sp)

		switch {
		case valued && shouldHarvest(sp, value):
			e.closeSpread(ctx, sp, "harvest", now, res)
		case spot > 0 && shouldCloseITMShort(sp, now, spot):
			e.closeSpread(ctx, sp, "itm_short", now, res)
		case shouldRoll(sp, now, armed):
			e.closeSpread(ctx, sp, "roll", now, res) // openNew places the replacement this beat
		case shouldExpire(sp, now, armed):
			e.closeSpread(ctx, sp, "expire", now, res)
		}
	}
}

func (e *ProphetHedgeExecutor) closeSpread(ctx context.Context, sp *models.DBProphetHedgeSpread, reason string, now time.Time, res *HedgeResult) {
	order := MultiLegOrder{
		Underlying:  sp.Underlying,
		Contracts:   sp.Contracts,
		TimeInForce: "day",
		Strategy:    hedgeStrategyTag,
		Legs: []MultiLegOrderLeg{
			{Symbol: sp.LongPutSymbol, Side: "sell", PositionIntent: "sell_to_close"},
			{Symbol: sp.ShortPutSymbol, Side: "buy", PositionIntent: "buy_to_close"},
		},
		// LimitPrice 0 → market close in PlaceMultiLegOrder; v1 closes at market to
		// guarantee exit (a marketable-limit close is a tuning refinement).
	}
	id, err := e.trader.PlaceMultiLegOrder(ctx, order)
	if err != nil {
		res.Errors = append(res.Errors, fmt.Sprintf("close %s (%s): %v", sp.SpreadID, reason, err))
		return
	}
	sp.Status = "closing"
	sp.CloseReason = reason
	sp.CloseOrderID = id
	if err := e.ledger.Save(sp); err != nil {
		res.Errors = append(res.Errors, fmt.Sprintf("close %s: save: %v", sp.SpreadID, err))
		return
	}
	res.Closed = append(res.Closed, sp.SpreadID)
}
```
(Note: a follow-up beat reconciles `closing`→`closed` + stamps `RealizedPnL` + `ClosedAt` from the close-order fill. Add a `closing`-state branch to `reconcile` in this task: on close-order `filled`, set status=`closed`, `ClosedAt=now`, `RealizedPnL` = close proceeds − `TotalDebit`. Include a test `TestReconcile_ClosingToClosed`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./services/ -run "ManageOpen|Reconcile" -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/prophet_hedge_executor.go services/prophet_hedge_executor_test.go
git commit -m "feat(defensive-prophet): manageOpen harvest/roll/expire/ITM-short + closing reconcile"
```

---

### Task 14: `openNew` — armed open with caps, guard, pricing, persist (D-DP16/D-DP17)

**Files:**
- Modify: `services/prophet_hedge_executor.go`
- Test: `services/prophet_hedge_executor_test.go`

Counting rule (D-DP17): the concurrency cap counts spreads in `pending_fill`/`open` only; a spread in `closing` (incl. a roll's close placed this beat) is **exempt**, so a roll's replacement can open without breaching `hedgeMaxConcurrent`.

- [ ] **Step 1: Write the failing tests**

```go
func TestOpenNew_ArmedPlacesSpread(t *testing.T) {
	store := newFakeHedgeStore()
	led := NewProphetHedgeLedger(store)
	mleg := &stubMleg{}
	exp := time.Now().Add(50 * 24 * time.Hour)
	chain := map[string]*interfaces.OptionContract{
		"QQQ_P475": {Symbol: "QQQ_P475", ContractType: "put", StrikePrice: 475, ExpirationDate: exp},
		"QQQ_P425": {Symbol: "QQQ_P425", ContractType: "put", StrikePrice: 425, ExpirationDate: exp},
	}
	snaps := map[string]*interfaces.OptionContract{
		"QQQ_P475": {Symbol: "QQQ_P475", Bid: 6.0, Ask: 6.2},
		"QQQ_P425": {Symbol: "QQQ_P425", Bid: 1.0, Ask: 1.2},
	}
	acct := stubAcct{pv: 100_000, bars: map[string]*interfaces.Bar{"QQQ": {Close: 500}}}
	ex := NewProphetHedgeExecutor(led, stubRegime{st: RegimeGateStatus{Tier: "DEFENSIVE", Score: 30}},
		stubChain{chain: chain, snaps: snaps}, mleg, acct, nil, nil)
	res := &HedgeResult{Armed: true}
	ex.openNew(context.Background(), nil, time.Now(), res)
	if len(mleg.placed) != 1 {
		t.Fatalf("expected one spread opened, got %d (skips=%v errs=%v)", len(mleg.placed), res.Skips, res.Errors)
	}
	o := mleg.placed[0].order
	if o.Strategy != hedgeStrategyTag || len(o.Legs) != 2 {
		t.Fatalf("order mis-structured: %+v", o)
	}
	if o.Legs[0].PositionIntent != "buy_to_open" || o.Legs[1].PositionIntent != "sell_to_open" {
		t.Fatalf("leg intents wrong: %+v", o.Legs)
	}
}

func TestOpenNew_UnaffordableEmitsGradeVisibleSkip(t *testing.T) {
	store := newFakeHedgeStore()
	led := NewProphetHedgeLedger(store)
	mleg := &stubMleg{}
	exp := time.Now().Add(50 * 24 * time.Hour)
	chain := map[string]*interfaces.OptionContract{
		"QQQ_P475": {Symbol: "QQQ_P475", ContractType: "put", StrikePrice: 475, ExpirationDate: exp},
		"QQQ_P425": {Symbol: "QQQ_P425", ContractType: "put", StrikePrice: 425, ExpirationDate: exp},
	}
	// net debit 15/sh → $1500/contract > 1% of 100k ($1000) → 0 contracts.
	snaps := map[string]*interfaces.OptionContract{
		"QQQ_P475": {Bid: 16.0, Ask: 16.0},
		"QQQ_P425": {Bid: 1.0, Ask: 1.0},
	}
	acct := stubAcct{pv: 100_000, bars: map[string]*interfaces.Bar{"QQQ": {Close: 500}}}
	ex := NewProphetHedgeExecutor(led, stubRegime{st: RegimeGateStatus{Tier: "DEFENSIVE", Score: 30}},
		stubChain{chain: chain, snaps: snaps}, mleg, acct, nil, nil)
	res := &HedgeResult{Armed: true}
	ex.openNew(context.Background(), nil, time.Now(), res)
	if len(mleg.placed) != 0 {
		t.Fatal("must not place when unaffordable")
	}
	found := false
	for _, s := range res.Skips {
		if contains(s, "unaffordable") {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected a grade-visible 'unaffordable' skip, got %v", res.Skips)
	}
}

func contains(s, sub string) bool { return len(s) >= len(sub) && (stringIndex(s, sub) >= 0) }
func stringIndex(s, sub string) int { return strings.Index(s, sub) } // add "strings" import
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/ -run OpenNew -v`
Expected: FAIL — openNew is a no-op.

- [ ] **Step 3: Implement**

```go
// liveOpenCount counts spreads that occupy a concurrency slot: pending_fill and
// open. A spread in "closing" (incl. a roll's close placed this beat) is exempt
// so its replacement can open without breaching the cap (D-DP17).
func liveOpenCount(open []*models.DBProphetHedgeSpread) int {
	n := 0
	for _, sp := range open {
		if sp.Status == "pending_fill" || sp.Status == "open" {
			n++
		}
	}
	return n
}

func (e *ProphetHedgeExecutor) openNew(ctx context.Context, open []*models.DBProphetHedgeSpread, now time.Time, res *HedgeResult) {
	if liveOpenCount(open) >= hedgeMaxConcurrent {
		res.Skips = append(res.Skips, fmt.Sprintf("concurrency cap (%d)", hedgeMaxConcurrent))
		return
	}
	acct, err := e.acct.GetAccount(ctx)
	if err != nil {
		res.Errors = append(res.Errors, fmt.Sprintf("openNew: account: %v", err))
		return
	}
	bar, err := e.acct.GetLatestBar(ctx, "QQQ")
	if err != nil || bar == nil || bar.Close <= 0 {
		res.Errors = append(res.Errors, "openNew: QQQ spot unavailable")
		return
	}
	spot := bar.Close
	status := e.regime.GetStatus()
	profile := selectStructure(status, 0.0)

	exp, ok := e.pickExpiry(ctx, profile, now)
	if !ok {
		res.Skips = append(res.Skips, "no monthly expiry in DTE band")
		return
	}
	chain, err := e.chain.GetOptionChain(ctx, "QQQ", exp)
	if err != nil {
		res.Errors = append(res.Errors, fmt.Sprintf("openNew: chain: %v", err))
		return
	}
	long, short, ok := pickPutStrikes(chain, spot, profile)
	if !ok {
		res.Skips = append(res.Skips, "no valid strike pair (degenerate chain)")
		return
	}
	longSnap, err1 := e.chain.GetOptionSnapshot(ctx, long.Symbol)
	shortSnap, err2 := e.chain.GetOptionSnapshot(ctx, short.Symbol)
	if err1 != nil || err2 != nil || longSnap == nil || shortSnap == nil {
		res.Errors = append(res.Errors, "openNew: leg snapshot unavailable")
		return
	}
	longMid := (longSnap.Bid + longSnap.Ask) / 2
	shortMid := (shortSnap.Bid + shortSnap.Ask) / 2
	debitPerShare := longMid - shortMid

	contracts := sizeSpread(acct.PortfolioValue, debitPerShare)
	if contracts < 1 {
		// D-DP16: loud, grade-visible — NOT a silent no-op.
		res.Skips = append(res.Skips, fmt.Sprintf("armed but unaffordable: 1 contract debit $%.0f > %.1f%% cap", debitPerShare*100, hedgeDebitCapPct*100))
		return
	}

	if e.guard != nil {
		q := &interfaces.OptionsQuote{Bid: longSnap.Bid, Ask: longSnap.Ask} // construct per trade_guard_test.go pattern
		if err := e.guard.CheckOptionsOpen(AgentProphet, "QQQ", long.Symbol, q, now); err != nil {
			res.Skips = append(res.Skips, fmt.Sprintf("guard: %v", err))
			return
		}
	}

	ceiling := long.StrikePrice - short.StrikePrice
	limit := marketableLimitCapped(longMid, shortMid, longSnap.Ask-longSnap.Bid, shortSnap.Ask-shortSnap.Bid, 0.25, ceiling)

	order := MultiLegOrder{
		Underlying: "QQQ", Contracts: contracts, TimeInForce: "day", Strategy: hedgeStrategyTag,
		LimitPrice: limit,
		Legs: []MultiLegOrderLeg{
			{Symbol: long.Symbol, Side: "buy", PositionIntent: "buy_to_open"},
			{Symbol: short.Symbol, Side: "sell", PositionIntent: "sell_to_open"},
		},
	}
	id, err := e.trader.PlaceMultiLegOrder(ctx, order)
	if err != nil {
		res.Errors = append(res.Errors, fmt.Sprintf("openNew: place: %v", err))
		return
	}
	sp := &models.DBProphetHedgeSpread{
		SpreadID:   fmt.Sprintf("hedge-%d", now.UnixNano()),
		Underlying: "QQQ", Expiration: exp,
		LongPutSymbol: long.Symbol, LongPutStrike: long.StrikePrice,
		ShortPutSymbol: short.Symbol, ShortPutStrike: short.StrikePrice,
		Contracts: contracts, NetDebitPerContract: debitPerShare,
		TotalDebit: debitPerShare * 100 * float64(contracts),
		RegimeScoreAtEntry: status.Score, PortfolioValueAtEntry: acct.PortfolioValue,
		EntryOrderID: id, Status: "pending_fill",
	}
	if err := e.ledger.Save(sp); err != nil {
		res.Errors = append(res.Errors, fmt.Sprintf("openNew: save: %v", err))
		return
	}
	res.Opened = append(res.Opened, sp.SpreadID)
}

// pickExpiry returns the nearest contract expiration whose DTE is in
// [profile.DTEMin, profile.DTEMax]; if none, the nearest ≥ DTEMin (never below).
// Derives candidate expirations from a chain fetch at the DTEMin target date.
func (e *ProphetHedgeExecutor) pickExpiry(ctx context.Context, p SpreadProfile, now time.Time) (time.Time, bool) {
	// Query a chain near the mid of the band; Alpaca returns the listed monthly.
	probe := now.Add(time.Duration((p.DTEMin+p.DTEMax)/2) * 24 * time.Hour)
	chain, err := e.chain.GetOptionChain(ctx, "QQQ", probe)
	if err != nil || len(chain) == 0 {
		return time.Time{}, false
	}
	var best time.Time
	bestDTE := -1
	for _, c := range chain {
		dte := int(c.ExpirationDate.Sub(now).Hours() / 24)
		if dte >= p.DTEMin && dte <= p.DTEMax {
			if bestDTE == -1 || dte < bestDTE {
				bestDTE, best = dte, c.ExpirationDate
			}
		}
	}
	if bestDTE == -1 {
		return time.Time{}, false
	}
	return best, true
}
```
(Add `"strings"` to imports. Confirm `AgentProphet` exists in the `AgentSource` enum — if the existing tag for Prophet differs, use it. Confirm `interfaces.OptionsQuote` field names from `trade_guard_test.go` and match them.)

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./services/ -run OpenNew -v`
Expected: PASS (both).

- [ ] **Step 5: Commit**

```bash
git add services/prophet_hedge_executor.go services/prophet_hedge_executor_test.go
git commit -m "feat(defensive-prophet): openNew — caps, guard, marketable-limit, unaffordable skip (D-DP16/17)"
```

---

## Phase D — Integration

### Task 15: Scheduler + cmd wiring (flag-gated, default OFF)

**Files:**
- Create: `services/prophet_hedge_scheduler.go`
- Modify: `cmd/bot/main.go` (near the Turtle scheduler block, ~line 466-494; the wiring vars ~648; status endpoint ~805)
- Test: `services/prophet_hedge_scheduler_test.go`

The scheduler mirrors `TurtleScheduler` exactly and reuses the package-scope `nextFireTime` (weekday 17:00 ET). The executor's `preloopCheck` enforces the 17:00–17:10 window.

- [ ] **Step 1: Write the failing test**

```go
func TestHedgeScheduler_CachesLastResult(t *testing.T) {
	led := NewProphetHedgeLedger(newFakeHedgeStore())
	ex := NewProphetHedgeExecutor(led, stubRegime{}, stubChain{}, &stubMleg{}, stubAcct{}, nil, nil)
	s := NewProphetHedgeScheduler(ex, nil)
	if s.LastResult() != nil {
		t.Fatal("no result before first run")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/ -run HedgeScheduler -v`
Expected: FAIL — `NewProphetHedgeScheduler` undefined.

- [ ] **Step 3: Implement scheduler (mirror `services/turtle_scheduler.go`)**

`services/prophet_hedge_scheduler.go`: copy `TurtleScheduler` verbatim, renaming `TurtleScheduler`→`ProphetHedgeScheduler`, `*TurtleExecutor`→`*ProphetHedgeExecutor`, `*HeartbeatResult`→`*HedgeResult`, log prefix `turtle-scheduler`→`hedge-scheduler`. Reuse the existing package-scope `nextFireTime` (do not redeclare it).

- [ ] **Step 3b: Holiday-gate the beat (spec §9, review T3.5)**

`nextFireTime` is weekday-only — it would fire on market holidays. The beat fails *safe* (a holiday means no fresh `regime_gate.json` → `deriveArm` returns not-armed on stale data; the market is closed so any order rejects), but the spec requires an explicit gate. Add a holiday skip to the executor's `preloopCheck` so the beat no-ops on a holiday regardless of the scheduler.

First locate the trading-calendar source: `git grep -il "holiday\|trading.?calendar\|marketHoliday" -- '*.go'`. If a Go market-calendar helper exists, call it. If only the Node side has one (per `holiday-aware-phase-project`), add a static Go list in `prophet_hedge_executor.go` modeled on Harvest's `fomc2026Dates` (documented, "verify quarterly"):
```go
// usMarketHolidays2026 — NYSE full closures (verify quarterly; source nyse.com).
var usMarketHolidays2026 = map[string]bool{
	"2026-01-01": true, "2026-01-19": true, "2026-02-16": true, "2026-04-03": true,
	"2026-05-25": true, "2026-06-19": true, "2026-07-03": true, "2026-09-07": true,
	"2026-11-26": true, "2026-12-25": true,
}
```
Add to `preloopCheck`, before the window check:
```go
	if usMarketHolidays2026[local.Format("2006-01-02")] {
		return fmt.Sprintf("market holiday %s — skipping", local.Format("2006-01-02"))
	}
```
Test: add `TestRunHeartbeat_HolidaySkips` asserting `res.Skipped` is non-empty when `now` is `2026-12-25` 17:00 ET. (DTE roll/expire math stays calendar-day based — options DTE is calendar days, so no holiday adjustment is needed there.)

- [ ] **Step 4: Wire into `cmd/bot/main.go`**

After the Turtle block, add (gated by the config flag, default OFF):
```go
	if cfg.EnableProphetDefensive && tradingService != nil {
		hedgeLedger := services.NewProphetHedgeLedger(storageService)
		hedgeExecutor := services.NewProphetHedgeExecutor(
			hedgeLedger,
			regimeGateService,    // already constructed for Turtle
			optionsDataService,   // *AlpacaOptionsDataService
			tradingService,       // satisfies PlaceMultiLegOrder + GetOrder
			tradingService,       // GetAccount + GetLatestBar (via the data service if separate)
			tradeGuard,           // CheckOptionsOpen
			logger,
		)
		hedgeScheduler := services.NewProphetHedgeScheduler(hedgeExecutor, logger)
		go hedgeScheduler.Start(ctx)
		logger.Info("Defensive-Prophet hedge scheduler started (ENABLE_PROPHET_DEFENSIVE=true)")
	}
```
(Resolve the concrete deps to the real constructed services — `GetLatestBar` lives on the data service; if `tradingService` doesn't expose it, pass the bar/market-data service and widen `hedgeAccountFetcher` accordingly. Confirm each interface is satisfied by `go build`.)

- [ ] **Step 5: Build + test**

Run: `go build ./... && go test ./services/ -run HedgeScheduler -v`
Expected: build OK, PASS.

- [ ] **Step 6: Commit**

```bash
git add services/prophet_hedge_scheduler.go services/prophet_hedge_scheduler_test.go cmd/bot/main.go
git commit -m "feat(defensive-prophet): scheduler + flag-gated cmd wiring (default OFF)"
```

---

### Task 16: Segment-writer integration (D-DP9)

**Files:**
- Modify: `services/segment_pnl_writer.go` (`WriteDailyMarks`, ~line 62-124)
- Test: `services/segment_pnl_writer_test.go`

Two changes (D-DP9): (1) ensure `prophet-defensive` is in the per-day strategy loop even though it never writes `managed_positions`; (2) add its realized P&L from `GetProphetHedgeClosedPnL` (analogous to the existing `harvest` special-case). The writer's store interface must gain `GetProphetHedgeClosedPnL`.

- [ ] **Step 1: Write the failing test**

Add a test asserting that after `WriteDailyMarks`, a `DBSegmentPnL` row exists for `prophet-defensive` even with zero managed positions, and that its `RealizedPnL` equals the summed closed-spread P&L for the day. (Mirror the existing writer tests' fake-storage setup; add `GetProphetHedgeClosedPnL` to the fake.)

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/ -run SegmentWriter -v`
Expected: FAIL — `prophet-defensive` row missing.

- [ ] **Step 3: Implement**

In `WriteDailyMarks`, after building `strategies`, union in the hedge tag:
```go
	// D-DP9: defensive-Prophet never writes managed_positions, so it won't appear
	// in ListManagedStrategies(). Include it explicitly so its daily series is
	// continuous from day one (a 0/0 row on flat days).
	if !containsString(strategies, "prophet-defensive") {
		strategies = append(strategies, "prophet-defensive")
	}
```
In the realized-sum section, beside the harvest special-case:
```go
	if strat == "prophet-defensive" {
		if h, herr := w.storage.GetProphetHedgeClosedPnL(dayStart, dayEnd); herr == nil {
			realized += h
		}
	}
```
Add `GetProphetHedgeClosedPnL(start, end time.Time) (float64, error)` to the writer's storage interface and a small `containsString` helper (or reuse an existing one).

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./services/ -run SegmentWriter -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/segment_pnl_writer.go services/segment_pnl_writer_test.go
git commit -m "feat(defensive-prophet): segment-writer marks prophet-defensive daily + realized (D-DP9)"
```

---

### Task 17: Full-suite green + status endpoint (optional) + observe notes

**Files:**
- Modify: `cmd/bot/main.go` (optional `/api/v1/prophet-defensive/status` mirroring the turtle status endpoint) + a controller if added.

- [ ] **Step 1: Run the whole tree**

Run: `go build ./... && go vet ./... && go test ./...`
Expected: build OK, vet clean, all packages PASS. (Note the pre-existing flaky `TestAggregator_Composite` in penny — unrelated; see `turtle-v2-broaden-basket-project`.)

- [ ] **Step 2: (Optional) status endpoint**

If a status read is wanted, add a `ProphetHedgeController.HandleGetStatus` returning `scheduler.LastResult()` and register it under the flag, mirroring `turtleController` (main.go ~805). Skip if YAGNI.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(defensive-prophet): full-suite green + optional status endpoint"
```

- [ ] **Step 4: Observe-then-tune (post-merge, NOT in this plan)**

Activation needs a Go rebuild from local main with `ENABLE_PROPHET_DEFENSIVE=true` (`claude-commits-must-reach-local-main`). On paper, run the **tuning window** (free to adjust arm/structure/sizing/harvest/roll), then freeze config for the **graded window** (D-DP14). Grading consumption (QQQ benchmark in 2b, book-β calibration, the 2c ballast gate) is deferred until the `DBSegmentPnL` series accrues ~a quarter.

---

## Deferred (NOT in this plan — see spec §10 + foundation-measurement-lifecycle-status)

- **Grading consumption:** QQQ benchmark fetch in Foundation B 2b; one-time book-β-to-QQQ calibration from `Holdings_*.csv`; the 2c ballast graduation gate. Build after the daily series accrues.
- **Conditional `selectStructure` v2** (regime/IV-aware) — the seam exists (Task 5).
- **LLM catalyst-acceleration layer** (accelerate-only, never veto) — only if the daily mechanical trigger demonstrably lags catalysts.
- **Long-vol ETF sleeve** (VIXM/VXZ) and **SPY** second underlying.
- **Multi-leg options friction model** in `apply-friction` — owned by this build per spec §7/D-DP18, but lands with the grading work (no closed spreads to friction-adjust until the series exists).
