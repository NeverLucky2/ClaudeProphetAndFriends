package services

import (
	"testing"
	"time"
)

// All tests are for nextFireTime. The Start goroutine is exercised in Task 7
// smoke testing; unit-testing a select-on-time loop with mocked clock would
// add fixture complexity disproportionate to the value (the logic to test
// is in nextFireTime + executor, both already covered).

func TestNextFireTime_FromMondayMorning(t *testing.T) {
	et := nyLoc
	from := time.Date(2026, 5, 18, 10, 0, 0, 0, et) // Mon 10:00 ET
	got := nextFireTime(from.UTC()).In(et)
	want := time.Date(2026, 5, 18, 17, 0, 0, 0, et)
	if !got.Equal(want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestNextFireTime_FromMondayAfter1700_RollsToTuesday(t *testing.T) {
	et := nyLoc
	from := time.Date(2026, 5, 18, 17, 0, 1, 0, et) // 1s after Mon 17:00 ET
	got := nextFireTime(from.UTC()).In(et)
	want := time.Date(2026, 5, 19, 17, 0, 0, 0, et) // Tue
	if !got.Equal(want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestNextFireTime_FromExactly1700OnMonday_RollsToTuesday(t *testing.T) {
	// Boundary: if from == today's 17:00, we want NEXT fire (don't double-fire today).
	et := nyLoc
	from := time.Date(2026, 5, 18, 17, 0, 0, 0, et)
	got := nextFireTime(from.UTC()).In(et)
	want := time.Date(2026, 5, 19, 17, 0, 0, 0, et)
	if !got.Equal(want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestNextFireTime_FromFridayEvening_RollsToMonday(t *testing.T) {
	et := nyLoc
	from := time.Date(2026, 5, 15, 19, 0, 0, 0, et) // Fri 19:00 ET (past 17:00)
	got := nextFireTime(from.UTC()).In(et)
	want := time.Date(2026, 5, 18, 17, 0, 0, 0, et) // Mon
	if !got.Equal(want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestNextFireTime_FromSaturday_RollsToMonday(t *testing.T) {
	et := nyLoc
	from := time.Date(2026, 5, 16, 10, 0, 0, 0, et) // Sat
	got := nextFireTime(from.UTC()).In(et)
	want := time.Date(2026, 5, 18, 17, 0, 0, 0, et)
	if !got.Equal(want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestNextFireTime_FromSunday_RollsToMonday(t *testing.T) {
	et := nyLoc
	from := time.Date(2026, 5, 17, 22, 0, 0, 0, et) // Sun 22:00 ET
	got := nextFireTime(from.UTC()).In(et)
	want := time.Date(2026, 5, 18, 17, 0, 0, 0, et)
	if !got.Equal(want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestNextFireTime_DSTSpringForward(t *testing.T) {
	// 2026 DST starts Sunday March 8 02:00 ET → 03:00 EDT.
	// On Friday March 6 evening, next fire should be Monday March 9 17:00 ET (EDT, UTC-4).
	et := nyLoc
	from := time.Date(2026, 3, 6, 19, 0, 0, 0, et) // Fri 19:00 EST
	got := nextFireTime(from.UTC()).In(et)
	want := time.Date(2026, 3, 9, 17, 0, 0, 0, et)
	if !got.Equal(want) {
		t.Errorf("got %v, want %v", got, want)
	}
	// And confirm the UTC offset shifted: result should be 21:00 UTC (EDT) not 22:00 UTC (EST).
	if got.UTC().Hour() != 21 {
		t.Errorf("expected 17:00 EDT = 21:00 UTC, got %v", got.UTC())
	}
}

// LastResult contract: nil before any heartbeat runs.
func TestScheduler_LastResultIsNilBeforeStart(t *testing.T) {
	s := NewTurtleScheduler(nil, nil) // both nil OK: nil executor never used here; nil logger gets default
	if s.LastResult() != nil {
		t.Errorf("LastResult should be nil before any heartbeat runs")
	}
}
