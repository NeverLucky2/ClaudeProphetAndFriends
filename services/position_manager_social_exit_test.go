package services

import (
	"testing"
	"time"
)

func TestEvaluateSocialTimeExit_FiresAt20Min(t *testing.T) {
	pos := &ManagedPosition{
		ID:             "p1",
		Symbol:         "ABCD",
		Side:           "buy",
		RemainingQty:   100,
		Status:         "ACTIVE",
		DominantSignal: "social",
		CreatedAt:      time.Date(2026, 5, 16, 14, 0, 0, 0, time.UTC),
		StopLossOrderID:   "stop-1",
		TakeProfitOrderID: "tp-1",
	}
	now := time.Date(2026, 5, 16, 14, 20, 0, 0, time.UTC)
	marketClose := time.Date(2026, 5, 16, 20, 0, 0, 0, time.UTC)

	if !shouldFireSocialTimeExit(pos, now, marketClose) {
		t.Errorf("expected social time exit to fire at 20 min, got false")
	}
}

func TestEvaluateSocialTimeExit_FiresIfCloseWithin15Min(t *testing.T) {
	pos := &ManagedPosition{
		ID:             "p1",
		Status:         "ACTIVE",
		DominantSignal: "social",
		CreatedAt:      time.Date(2026, 5, 16, 19, 50, 0, 0, time.UTC),
	}
	now := time.Date(2026, 5, 16, 19, 51, 0, 0, time.UTC)
	marketClose := time.Date(2026, 5, 16, 20, 0, 0, 0, time.UTC)

	if !shouldFireSocialTimeExit(pos, now, marketClose) {
		t.Errorf("expected fire when close is within 15 min, got false")
	}
}

func TestEvaluateSocialTimeExit_NoFireForNonSocial(t *testing.T) {
	pos := &ManagedPosition{
		Status:         "ACTIVE",
		DominantSignal: "technical",
		CreatedAt:      time.Date(2026, 5, 16, 14, 0, 0, 0, time.UTC),
	}
	now := time.Date(2026, 5, 16, 15, 0, 0, 0, time.UTC)
	marketClose := time.Date(2026, 5, 16, 20, 0, 0, 0, time.UTC)

	if shouldFireSocialTimeExit(pos, now, marketClose) {
		t.Errorf("expected no fire for technical signal, got true")
	}
}

func TestEvaluateSocialTimeExit_NoFireBefore20Min(t *testing.T) {
	pos := &ManagedPosition{
		Status:         "ACTIVE",
		DominantSignal: "social",
		CreatedAt:      time.Date(2026, 5, 16, 14, 0, 0, 0, time.UTC),
	}
	now := time.Date(2026, 5, 16, 14, 19, 0, 0, time.UTC)
	marketClose := time.Date(2026, 5, 16, 20, 0, 0, 0, time.UTC)

	if shouldFireSocialTimeExit(pos, now, marketClose) {
		t.Errorf("expected no fire before 20 min, got true")
	}
}

func TestEvaluateSocialTimeExit_NoFireWhenClosed(t *testing.T) {
	pos := &ManagedPosition{
		Status:         "CLOSED",
		DominantSignal: "social",
		CreatedAt:      time.Date(2026, 5, 16, 14, 0, 0, 0, time.UTC),
	}
	now := time.Date(2026, 5, 16, 15, 0, 0, 0, time.UTC)
	marketClose := time.Date(2026, 5, 16, 20, 0, 0, 0, time.UTC)

	if shouldFireSocialTimeExit(pos, now, marketClose) {
		t.Errorf("expected no fire on CLOSED position, got true")
	}
}

func TestTodayMarketClose_WeekdayEDTReturns20UTC(t *testing.T) {
	pm := &PositionManager{}
	// 2026-05-15 is a Friday in EDT (UTC-4). 16:00 ET = 20:00 UTC.
	now := time.Date(2026, 5, 15, 12, 0, 0, 0, time.UTC)
	got := pm.todayMarketClose(now)
	want := time.Date(2026, 5, 15, 20, 0, 0, 0, time.UTC)
	if !got.Equal(want) {
		t.Errorf("EDT close: got %v, want %v", got, want)
	}
}

func TestTodayMarketClose_WeekdayESTReturns21UTC(t *testing.T) {
	pm := &PositionManager{}
	// 2026-01-15 is a Thursday in EST (UTC-5). 16:00 ET = 21:00 UTC.
	now := time.Date(2026, 1, 15, 12, 0, 0, 0, time.UTC)
	got := pm.todayMarketClose(now)
	want := time.Date(2026, 1, 15, 21, 0, 0, 0, time.UTC)
	if !got.Equal(want) {
		t.Errorf("EST close: got %v, want %v", got, want)
	}
}

func TestTodayMarketClose_SaturdayReturnsZero(t *testing.T) {
	pm := &PositionManager{}
	// 2026-05-16 is a Saturday.
	now := time.Date(2026, 5, 16, 12, 0, 0, 0, time.UTC)
	got := pm.todayMarketClose(now)
	if !got.IsZero() {
		t.Errorf("Saturday should return zero time, got %v", got)
	}
}

func TestTodayMarketClose_SundayReturnsZero(t *testing.T) {
	pm := &PositionManager{}
	// 2026-05-17 is a Sunday.
	now := time.Date(2026, 5, 17, 12, 0, 0, 0, time.UTC)
	got := pm.todayMarketClose(now)
	if !got.IsZero() {
		t.Errorf("Sunday should return zero time, got %v", got)
	}
}
