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
	_ = s.SaveManagedPosition(mk("p3", "trend", "CLOSED", 100.0, closed))                       // other strategy
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
		t.Fatalf("got %v, want exactly 2 distinct non-empty strategies", got)
	}
}
