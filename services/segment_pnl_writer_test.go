package services

import (
	"context"
	"testing"
	"time"

	"prophet-trader/database"
	"prophet-trader/models"

	"github.com/sirupsen/logrus"
)

func etMoment(t *testing.T, y int, mo time.Month, d, h, mi int) time.Time {
	t.Helper()
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatalf("load ET: %v", err)
	}
	return time.Date(y, mo, d, h, mi, 0, 0, loc)
}

func TestShouldWriteSegmentMarks(t *testing.T) {
	// 2026-05-29 is a Friday.
	beforeClose := etMoment(t, 2026, 5, 29, 15, 45)
	afterClose := etMoment(t, 2026, 5, 29, 16, 5)
	saturday := etMoment(t, 2026, 5, 30, 16, 5)

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

func TestWriteDailyMarks_WritesRealizedRowPerStrategy(t *testing.T) {
	storage, err := database.NewLocalStorage(":memory:")
	if err != nil {
		t.Fatalf("storage: %v", err)
	}
	closedAt := etMoment(t, 2026, 5, 29, 14, 45).UTC()
	save := func(id, strat string, pl float64) {
		_ = storage.SaveManagedPosition(&models.DBManagedPosition{
			PositionID: id, AgentStrategy: strat, Status: "CLOSED", UnrealizedPL: pl, ClosedAt: &closedAt,
		})
	}
	save("p1", "mean-rev-rsi2", 415.58)
	save("p2", "mean-rev-rsi2", -53.69)

	seg := NewSegmentPnLService(storage, &stubTrading{}) // stub: no open positions -> unrealized 0
	w := NewSegmentPnLWriter(storage, seg, logrus.New())

	now := etMoment(t, 2026, 5, 29, 16, 5)
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
	closedAt := etMoment(t, 2026, 5, 29, 14, 45).UTC()
	_ = storage.SaveManagedPosition(&models.DBManagedPosition{
		PositionID: "p1", AgentStrategy: "trend", Status: "CLOSED", UnrealizedPL: 50, ClosedAt: &closedAt,
	})
	seg := NewSegmentPnLService(storage, &stubTrading{})
	w := NewSegmentPnLWriter(storage, seg, logrus.New())
	now := etMoment(t, 2026, 5, 29, 16, 5)

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
