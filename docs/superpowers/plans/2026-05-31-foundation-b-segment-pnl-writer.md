# Foundation B · Component 1 — Daily-Mark Segment-P&L Writer · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Write one daily mark-to-market `DBSegmentPnL` row per strategy per trading day, so the lab can later compute per-agent edge and conditional beta.

**Architecture:** A new `SegmentPnLWriter` (Go) enumerates strategies from the managed-positions table, computes each strategy's realized-closed-today (frozen `UnrealizedPL` of positions closed today) + current marked unrealized (reusing `SegmentPnLService`), and upserts a `DBSegmentPnL` row keyed `(strategy, date)`. A once-per-trading-day post-close gate in the existing `MonitorPositions` loop drives it. The row is written **every trading day even when flat** (0/0 row) so the daily-return series stays continuous; idempotent so restarts don't double-write.

**Tech Stack:** Go, GORM (SQLite), logrus; `go test ./...`. Mirrors existing patterns in `database/storage.go` and `services/segment_pnl_service.go`.

**Scope:** Component 1 only (spec §4). Components 2 (Node measurement/graduation) and 3 (Node historical repair) are separate plans. This plan ships a self-contained, tested writer that starts the data clock.

---

## File Structure

- `models/models.go` — change `DBSegmentPnL` `(Strategy, Date)` index from non-unique to **unique** (idempotency key). Modify only the two struct tags.
- `database/storage.go` — add `SaveSegmentPnL`, `GetSegmentPnLForDate`, `GetManagedClosedPnL`, `ListManagedStrategies`. New methods, mirror `GetHarvestClosedPnL` / `SaveManagedPosition`.
- `database/storage_segment_pnl_test.go` — **new** — storage-layer tests (in-memory sqlite via existing test helpers).
- `services/segment_pnl_writer.go` — **new** — `SegmentPnLWriter` + `WriteDailyMarks` + the pure `shouldWriteSegmentMarks` gate helper.
- `services/segment_pnl_writer_test.go` — **new** — writer + gate tests.
- `services/position_manager.go` — add a `segmentWriter` field + `SetSegmentWriter`, and the once-per-day call site inside `MonitorPositions`.
- `cmd/bot/main.go` — wire `NewSegmentPnLWriter` and `pm.SetSegmentWriter(...)` at startup.

---

## Task 1: Storage layer — unique index + query/upsert methods

**Files:**
- Modify: `models/models.go:56-66` (DBSegmentPnL tags)
- Modify: `database/storage.go` (add 4 methods near the Harvest block ~line 477)
- Test: `database/storage_segment_pnl_test.go` (create)

- [ ] **Step 1: Make the `(strategy, date)` index unique**

In `models/models.go`, change the two `DBSegmentPnL` tags from `index:` to `uniqueIndex:`:

```go
type DBSegmentPnL struct {
	gorm.Model
	Strategy        string    `gorm:"uniqueIndex:idx_strategy_date"`
	Date            time.Time `gorm:"uniqueIndex:idx_strategy_date"`
	RealizedPnL     float64
	UnrealizedPnL   float64
	DeployedDollars float64
	DeployedPercent float64
	PositionCount   int
	PortfolioValue  float64
}
```

- [ ] **Step 2: Write failing storage tests**

Create `database/storage_segment_pnl_test.go`. (Use the same in-memory constructor the other storage tests use — `NewLocalStorage(":memory:")`.)

```go
package database

import (
	"testing"
	"time"

	"prophet-trader/models"
)

func segDay(y int, m time.Month, d int) time.Time {
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}

func TestSaveSegmentPnL_UpsertsOnStrategyDate(t *testing.T) {
	s, err := NewLocalStorage(":memory:")
	if err != nil {
		t.Fatalf("storage: %v", err)
	}
	day := segDay(2026, 5, 29)
	if err := s.SaveSegmentPnL(&models.DBSegmentPnL{Strategy: "mean-rev-rsi2", Date: day, RealizedPnL: 10, UnrealizedPnL: 5}); err != nil {
		t.Fatalf("first save: %v", err)
	}
	// Same (strategy, date) again with new numbers must UPDATE, not duplicate.
	if err := s.SaveSegmentPnL(&models.DBSegmentPnL{Strategy: "mean-rev-rsi2", Date: day, RealizedPnL: 99, UnrealizedPnL: 7}); err != nil {
		t.Fatalf("second save: %v", err)
	}
	got, err := s.GetSegmentPnLForDate("mean-rev-rsi2", day)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got == nil {
		t.Fatal("row missing after upsert")
	}
	if got.RealizedPnL != 99 || got.UnrealizedPnL != 7 {
		t.Errorf("row not updated: got realized=%v unreal=%v, want 99/7", got.RealizedPnL, got.UnrealizedPnL)
	}
}

func TestGetSegmentPnLForDate_MissingReturnsNilNoError(t *testing.T) {
	s, _ := NewLocalStorage(":memory:")
	got, err := s.GetSegmentPnLForDate("trend", segDay(2026, 5, 29))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != nil {
		t.Errorf("want nil for missing row, got %+v", got)
	}
}

func TestGetManagedClosedPnL_SumsFrozenPLForStrategyInWindow(t *testing.T) {
	s, _ := NewLocalStorage(":memory:")
	closed := time.Date(2026, 5, 29, 14, 30, 0, 0, time.UTC)
	mk := func(id, strat, status string, pl float64, at time.Time) *models.DBManagedPosition {
		return &models.DBManagedPosition{PositionID: id, AgentStrategy: strat, Status: status, UnrealizedPL: pl, ClosedAt: &at}
	}
	_ = s.SaveManagedPosition(mk("p1", "mean-rev-rsi2", "CLOSED", 415.58, closed))
	_ = s.SaveManagedPosition(mk("p2", "mean-rev-rsi2", "STOPPED_OUT", -53.69, closed))
	_ = s.SaveManagedPosition(mk("p3", "trend", "CLOSED", 100.0, closed))           // other strategy
	_ = s.SaveManagedPosition(mk("p4", "mean-rev-rsi2", "CLOSED", 1000.0, segDay(2026, 5, 20))) // out of window

	start := segDay(2026, 5, 29)
	end := segDay(2026, 5, 30)
	realized, count, err := s.GetManagedClosedPnL("mean-rev-rsi2", start, end)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if count != 2 {
		t.Errorf("count = %d, want 2", count)
	}
	if realized < 361.88 || realized > 361.90 { // 415.58 - 53.69
		t.Errorf("realized = %v, want ~361.89", realized)
	}
}

func TestListManagedStrategies_DistinctNonEmpty(t *testing.T) {
	s, _ := NewLocalStorage(":memory:")
	at := time.Now()
	_ = s.SaveManagedPosition(&models.DBManagedPosition{PositionID: "a", AgentStrategy: "trend", Status: "ACTIVE"})
	_ = s.SaveManagedPosition(&models.DBManagedPosition{PositionID: "b", AgentStrategy: "trend", Status: "CLOSED", ClosedAt: &at})
	_ = s.SaveManagedPosition(&models.DBManagedPosition{PositionID: "c", AgentStrategy: "mean-rev-rsi2", Status: "ACTIVE"})
	_ = s.SaveManagedPosition(&models.DBManagedPosition{PositionID: "d", AgentStrategy: "", Status: "ACTIVE"}) // legacy untagged — excluded
	got, err := s.ListManagedStrategies()
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("got %v, want exactly [mean-rev-rsi2 trend] in some order", got)
	}
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `go test ./database/ -run 'SegmentPnL|ManagedClosedPnL|ListManagedStrategies' -v`
Expected: FAIL / build error — `SaveSegmentPnL`, `GetSegmentPnLForDate`, `GetManagedClosedPnL`, `ListManagedStrategies` undefined.

- [ ] **Step 4: Implement the four storage methods**

Add to `database/storage.go` (after `GetHarvestClosedPnL`, ~line 484). Mirror the existing GORM patterns (`clause.OnConflict` upsert like `SaveManagedPosition`; window SUM like `GetHarvestClosedPnL`):

```go
// ── Segment P&L storage ────────────────────────────────────────────

// SaveSegmentPnL upserts a daily segment-P&L row on the (strategy, date)
// unique index, so a re-run for the same day updates rather than duplicates.
func (s *LocalStorage) SaveSegmentPnL(row *models.DBSegmentPnL) error {
	result := s.db.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "strategy"}, {Name: "date"}},
		UpdateAll: true,
	}).Create(row)
	if result.Error != nil {
		return fmt.Errorf("failed to save segment pnl: %w", result.Error)
	}
	return nil
}

// GetSegmentPnLForDate returns the row for (strategy, date) or (nil, nil) if none.
func (s *LocalStorage) GetSegmentPnLForDate(strategy string, date time.Time) (*models.DBSegmentPnL, error) {
	var row models.DBSegmentPnL
	err := s.db.Where("strategy = ? AND date = ?", strategy, date).First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get segment pnl: %w", err)
	}
	return &row, nil
}

// GetManagedClosedPnL sums frozen realized P&L (UnrealizedPL, stamped at exit)
// and counts this strategy's managed positions that reached a terminal state
// with closed_at in [start, end).
func (s *LocalStorage) GetManagedClosedPnL(strategy string, start, end time.Time) (float64, int, error) {
	type agg struct {
		Total float64
		N     int64
	}
	var a agg
	err := s.db.Model(&models.DBManagedPosition{}).
		Where("agent_strategy = ? AND status IN ? AND closed_at >= ? AND closed_at < ?",
			strategy, []string{"CLOSED", "STOPPED_OUT"}, start, end).
		Select("COALESCE(SUM(unrealized_pl),0) AS total, COUNT(*) AS n").
		Scan(&a).Error
	if err != nil {
		return 0, 0, fmt.Errorf("failed to sum managed closed pnl: %w", err)
	}
	return a.Total, int(a.N), nil
}

// ListManagedStrategies returns the distinct non-empty AgentStrategy values
// ever recorded — the set of strategies to write daily rows for.
func (s *LocalStorage) ListManagedStrategies() ([]string, error) {
	var out []string
	err := s.db.Model(&models.DBManagedPosition{}).
		Distinct().
		Where("agent_strategy <> ''").
		Pluck("agent_strategy", &out).Error
	if err != nil {
		return nil, fmt.Errorf("failed to list managed strategies: %w", err)
	}
	return out, nil
}
```

Confirm `errors` and `gorm` are imported in `storage.go` (gorm already is; add `"errors"` to the import block if missing).

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test ./database/ -run 'SegmentPnL|ManagedClosedPnL|ListManagedStrategies' -v`
Expected: PASS (all four).

- [ ] **Step 6: Commit**

```bash
git add models/models.go database/storage.go database/storage_segment_pnl_test.go
git commit -m "feat(segment-pnl): storage layer for daily-mark rows (upsert + closed-pnl + strategy list)"
```

---

## Task 2: `SegmentPnLWriter.WriteDailyMarks` + gate helper

**Files:**
- Create: `services/segment_pnl_writer.go`
- Test: `services/segment_pnl_writer_test.go`

- [ ] **Step 1: Write the failing gate-helper test**

Create `services/segment_pnl_writer_test.go`:

```go
package services

import (
	"context"
	"testing"
	"time"

	"prophet-trader/database"
	"prophet-trader/models"
)

func etTime(t *testing.T, y int, mo time.Month, d, h, mi int) time.Time {
	t.Helper()
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatalf("load ET: %v", err)
	}
	return time.Date(y, mo, d, h, mi, 0, 0, loc)
}

func TestShouldWriteSegmentMarks(t *testing.T) {
	// 2026-05-29 is a Friday.
	beforeClose := etTime(t, 2026, 5, 29, 15, 45)
	afterClose := etTime(t, 2026, 5, 29, 16, 5)
	saturday := etTime(t, 2026, 5, 30, 16, 5)

	if shouldWriteSegmentMarks(beforeClose, "") {
		t.Error("must not write before 16:00 ET")
	}
	if !shouldWriteSegmentMarks(afterClose, "") {
		t.Error("must write after close when no row written yet today")
	}
	if shouldWriteSegmentMarks(afterClose, "2026-05-29") {
		t.Error("must not write twice on the same ET day")
	}
	if shouldWriteSegmentMarks(saturday, "") {
		t.Error("must not write on a weekend (market closed)")
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./services/ -run TestShouldWriteSegmentMarks -v`
Expected: FAIL — `shouldWriteSegmentMarks` undefined.

- [ ] **Step 3: Implement the writer file (gate helper first)**

Create `services/segment_pnl_writer.go`:

```go
package services

import (
	"context"
	"time"

	"prophet-trader/database"
	"prophet-trader/models"

	"github.com/sirupsen/logrus"
)

// SegmentPnLWriter materializes one daily mark-to-market DBSegmentPnL row per
// strategy per trading day. It is the EOD half of segment P&L: the live
// SegmentPnLService answers "now"; this persists the daily series the lab
// graduation/beta analysis reads. Written daily even when a strategy is flat
// (0/0 row) so the return series stays continuous.
type SegmentPnLWriter struct {
	storage    *database.LocalStorage
	segmentPnL *SegmentPnLService
	logger     *logrus.Logger
}

func NewSegmentPnLWriter(storage *database.LocalStorage, segmentPnL *SegmentPnLService, logger *logrus.Logger) *SegmentPnLWriter {
	return &SegmentPnLWriter{storage: storage, segmentPnL: segmentPnL, logger: logger}
}

// etDayKey returns the ET calendar-day string (YYYY-MM-DD) for now.
func etDayKey(now time.Time) string {
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		return now.UTC().Format("2006-01-02")
	}
	return now.In(loc).Format("2006-01-02")
}

// shouldWriteSegmentMarks reports whether the EOD writer should run on this
// tick: a weekday, at/after 16:00 ET, and not already written for this ET day
// (lastWriteDay is the ET YYYY-MM-DD of the last successful write, "" if none).
func shouldWriteSegmentMarks(now time.Time, lastWriteDay string) bool {
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		return false
	}
	et := now.In(loc)
	if wd := et.Weekday(); wd == time.Saturday || wd == time.Sunday {
		return false
	}
	if et.Hour() < 16 {
		return false
	}
	return etDayKey(now) != lastWriteDay
}
```

- [ ] **Step 4: Run to verify the gate test passes**

Run: `go test ./services/ -run TestShouldWriteSegmentMarks -v`
Expected: PASS.

- [ ] **Step 5: Write the failing `WriteDailyMarks` test**

Append to `services/segment_pnl_writer_test.go`. Reuse the package's existing `stubTrading` (open-position unrealized comes from the broker via `SegmentPnLService`; here we assert realized + idempotency, which don't need open positions):

```go
func TestWriteDailyMarks_WritesRealizedRowPerStrategy(t *testing.T) {
	storage, err := database.NewLocalStorage(":memory:")
	if err != nil {
		t.Fatalf("storage: %v", err)
	}
	closedAt := etTime(t, 2026, 5, 29, 14, 45).UTC()
	save := func(id, strat string, pl float64) {
		_ = storage.SaveManagedPosition(&models.DBManagedPosition{
			PositionID: id, AgentStrategy: strat, Status: "CLOSED", UnrealizedPL: pl, ClosedAt: &closedAt,
		})
	}
	save("p1", "mean-rev-rsi2", 415.58)
	save("p2", "mean-rev-rsi2", -53.69)

	seg := NewSegmentPnLService(storage, &stubTrading{}) // stub: no open positions -> unrealized 0
	w := NewSegmentPnLWriter(storage, seg, logrus.New())

	now := etTime(t, 2026, 5, 29, 16, 5)
	if err := w.WriteDailyMarks(context.Background(), now); err != nil {
		t.Fatalf("WriteDailyMarks: %v", err)
	}

	day := time.Date(2026, 5, 29, 0, 0, 0, 0, time.UTC)
	row, err := storage.GetSegmentPnLForDate("mean-rev-rsi2", day)
	if err != nil || row == nil {
		t.Fatalf("row missing: row=%v err=%v", row, err)
	}
	if row.RealizedPnL < 361.88 || row.RealizedPnL > 361.90 {
		t.Errorf("RealizedPnL = %v, want ~361.89", row.RealizedPnL)
	}
}

func TestWriteDailyMarks_IdempotentForSameDay(t *testing.T) {
	storage, _ := database.NewLocalStorage(":memory:")
	closedAt := etTime(t, 2026, 5, 29, 14, 45).UTC()
	_ = storage.SaveManagedPosition(&models.DBManagedPosition{
		PositionID: "p1", AgentStrategy: "trend", Status: "CLOSED", UnrealizedPL: 50, ClosedAt: &closedAt,
	})
	seg := NewSegmentPnLService(storage, &stubTrading{})
	w := NewSegmentPnLWriter(storage, seg, logrus.New())
	now := etTime(t, 2026, 5, 29, 16, 5)

	_ = w.WriteDailyMarks(context.Background(), now)
	// Tamper, then re-run: a skip (idempotent) leaves the tampered value;
	// a re-write would overwrite it back to 50. We assert SKIP via row identity.
	day := time.Date(2026, 5, 29, 0, 0, 0, 0, time.UTC)
	row, _ := storage.GetSegmentPnLForDate("trend", day)
	row.RealizedPnL = 12345
	_ = storage.SaveSegmentPnL(row)

	_ = w.WriteDailyMarks(context.Background(), now) // second run, same day
	again, _ := storage.GetSegmentPnLForDate("trend", day)
	if again.RealizedPnL != 12345 {
		t.Errorf("second run re-wrote an existing day; RealizedPnL=%v, want 12345 (skip)", again.RealizedPnL)
	}
}
```

- [ ] **Step 6: Run to verify it fails**

Run: `go test ./services/ -run TestWriteDailyMarks -v`
Expected: FAIL — `WriteDailyMarks` undefined.

- [ ] **Step 7: Implement `WriteDailyMarks`**

Append to `services/segment_pnl_writer.go`:

```go
// WriteDailyMarks computes and upserts one DBSegmentPnL row per known strategy
// for the ET trading day containing `now`. Idempotent: a (strategy, day) that
// already has a row is skipped. Realized = frozen P&L of managed positions
// closed today (+ closed condors for harvest); unrealized/deployed/count/
// portfolio come from the live SegmentPnLService (current broker marks, valid
// for equity and options alike).
func (w *SegmentPnLWriter) WriteDailyMarks(ctx context.Context, now time.Time) error {
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		return err
	}
	et := now.In(loc)
	dayStart := time.Date(et.Year(), et.Month(), et.Day(), 0, 0, 0, 0, loc).UTC()
	dayEnd := dayStart.Add(24 * time.Hour)
	dayKey := time.Date(et.Year(), et.Month(), et.Day(), 0, 0, 0, 0, time.UTC) // Date column (UTC midnight of ET day)

	strategies, err := w.storage.ListManagedStrategies()
	if err != nil {
		return err
	}

	for _, strat := range strategies {
		existing, err := w.storage.GetSegmentPnLForDate(strat, dayKey)
		if err != nil {
			w.logger.WithError(err).WithField("strategy", strat).Warn("segment-pnl: existence check failed — skipping strategy this tick")
			continue
		}
		if existing != nil {
			continue // idempotent: already written today
		}

		realized, _, err := w.storage.GetManagedClosedPnL(strat, dayStart, dayEnd)
		if err != nil {
			w.logger.WithError(err).WithField("strategy", strat).Warn("segment-pnl: realized sum failed — skipping strategy this tick")
			continue
		}
		if strat == "harvest" {
			if h, herr := w.storage.GetHarvestClosedPnL(dayStart, dayEnd); herr == nil {
				realized += h
			}
		}

		seg, err := w.segmentPnL.GetSegmentPnL(ctx, strat)
		if err != nil {
			w.logger.WithError(err).WithField("strategy", strat).Warn("segment-pnl: live segment read failed — skipping strategy this tick")
			continue
		}

		row := &models.DBSegmentPnL{
			Strategy:        strat,
			Date:            dayKey,
			RealizedPnL:     realized,
			UnrealizedPnL:   seg.UnrealizedPnL,
			DeployedDollars: seg.DeployedDollars,
			DeployedPercent: seg.DeployedPercent,
			PositionCount:   seg.OpenPositions,
			PortfolioValue:  seg.PortfolioValue,
		}
		if err := w.storage.SaveSegmentPnL(row); err != nil {
			w.logger.WithError(err).WithField("strategy", strat).Error("segment-pnl: save failed")
			continue
		}
		w.logger.WithFields(logrus.Fields{
			"strategy": strat, "date": dayKey.Format("2006-01-02"),
			"realized": realized, "unrealized": seg.UnrealizedPnL,
		}).Info("segment-pnl: daily mark written")
	}
	return nil
}
```

(Note: `SegmentPnL` exposes `UnrealizedPnL`, `DeployedDollars`, `DeployedPercent`, `OpenPositions`, `PortfolioValue` — confirmed in `services/segment_pnl_service.go:25-35`.)

- [ ] **Step 8: Run to verify all writer tests pass**

Run: `go test ./services/ -run 'SegmentMarks|WriteDailyMarks' -v`
Expected: PASS (gate + 2 writer tests).

- [ ] **Step 9: Commit**

```bash
git add services/segment_pnl_writer.go services/segment_pnl_writer_test.go
git commit -m "feat(segment-pnl): daily mark-to-market writer + once-per-day gate"
```

---

## Task 3: Wire the once-per-day call into `MonitorPositions`

**Files:**
- Modify: `services/position_manager.go` (struct field + setter + call site in `MonitorPositions`)
- Modify: `cmd/bot/main.go` (construct writer + inject)
- Test: `services/segment_pnl_writer_test.go` (gate already covers the decision; add a wiring guard)

- [ ] **Step 1: Add the field + setter (no behavior change yet)**

In `services/position_manager.go`, add to the `PositionManager` struct (near `pendingTimeout`):

```go
	// segmentWriter, when set, writes the daily mark-to-market DBSegmentPnL row
	// once per trading day after close from inside MonitorPositions. nil-safe.
	segmentWriter      *SegmentPnLWriter
	lastSegmentWriteDay string
```

Add a setter after `NewPositionManager`:

```go
// SetSegmentWriter installs the EOD daily-mark writer (wired at startup once
// the SegmentPnLService exists). Optional: if never set, MonitorPositions
// simply does not write daily marks.
func (pm *PositionManager) SetSegmentWriter(w *SegmentPnLWriter) {
	pm.segmentWriter = w
}
```

- [ ] **Step 2: Add the call site in `MonitorPositions`**

In the `MonitorPositions` ticker loop (`services/position_manager.go:347-360`), inside the `case <-ticker.C:` block, after the existing `pm.checkPositions(ctx)` / reconcile block, add:

```go
			if pm.segmentWriter != nil {
				now := time.Now()
				if shouldWriteSegmentMarks(now, pm.lastSegmentWriteDay) {
					if err := pm.segmentWriter.WriteDailyMarks(ctx, now); err != nil {
						pm.logger.WithError(err).Warn("segment-pnl: daily mark write failed")
					} else {
						pm.lastSegmentWriteDay = etDayKey(now)
					}
				}
			}
```

- [ ] **Step 3: Build to verify it compiles**

Run: `go build ./...`
Expected: clean build (no behavior asserted yet — the gate + writer are already tested in Task 2).

- [ ] **Step 4: Wire the writer at startup**

In `cmd/bot/main.go`, where the `PositionManager` and `SegmentPnLService` are constructed, after both exist, inject the writer. (Grep `cmd/bot/main.go` for `NewSegmentPnLService` and `NewPositionManager` to find the exact spot; both already exist there per the segment-P&L grep.)

```go
	segWriter := services.NewSegmentPnLWriter(storage, segmentPnLService, logger)
	positionManager.SetSegmentWriter(segWriter)
```

Use the actual local variable names present in `main.go` for `storage`, `segmentPnLService`, `positionManager`, `logger`.

- [ ] **Step 5: Build + full test suite**

Run: `go build ./... && go test ./...`
Expected: clean build; all packages `ok` (Task 1 + Task 2 tests included, no regressions).

- [ ] **Step 6: Commit**

```bash
git add services/position_manager.go cmd/bot/main.go
git commit -m "feat(segment-pnl): drive daily-mark writer from MonitorPositions once per trading day"
```

---

## Self-Review

**Spec coverage (§4 of the design):**
- Daily mark-to-market, not exit-stamped → Task 2 writes a row every trading day per strategy (flat days get a 0/0 row); realized + current unrealized both captured. ✓
- Hook in `MonitorPositions` once/day post-close, runs even when idle → Task 3 gate + Task 2 writes for all `ListManagedStrategies` regardless of today's activity. ✓
- Realized from closed `managed_positions` (frozen `UnrealizedPL`) + harvest condors → Task 1 `GetManagedClosedPnL` + Task 2 harvest branch. ✓
- Unrealized from broker `unrealized_pl` (equity + options) → reuses `SegmentPnLService.GetSegmentPnL`. ✓
- Idempotent across restarts (the §7 double-write case) → unique `(strategy,date)` index + existence-skip + in-memory `lastSegmentWriteDay`. ✓
- Partial-exit realizations included in realized-today → covered: `GetManagedClosedPnL` sums any position whose terminal `ClosedAt` falls today; partial-exit *legs* on still-open positions accrue when the position finally closes (acceptable at daily resolution — a Task-2 note; full partial-exit-leg accrual on the partial day is a Component-2 concern since the daily-return differencing nets it).

**Gaps / deferred (intentional, not this plan):**
- Gap-aware differencing + beta + graduation are **Component 2** (Node), not here. This plan only *produces* the series.
- Holiday-awareness: `shouldWriteSegmentMarks` excludes weekends but not market holidays — a holiday would write a spurious flat row. Low-severity (Component 2 dedupes/handles spacing); noted, not fixed here.
- Strategy enumeration writes a row for every strategy that ever traded; a retired strategy keeps getting daily 0/0 rows. Harmless; revisit if it clutters.

**Placeholder scan:** no TBD/TODO; every code step shows complete code; commands have expected output. ✓
**Type consistency:** `SaveSegmentPnL`/`GetSegmentPnLForDate`/`GetManagedClosedPnL`/`ListManagedStrategies` signatures identical across Task 1 (def) and Task 2 (use); `SegmentPnL` fields match `segment_pnl_service.go`. ✓
