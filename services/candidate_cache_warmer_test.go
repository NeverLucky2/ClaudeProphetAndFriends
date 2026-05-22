package services

import (
	"context"
	"testing"
	"time"
)

// fakeCandidateRefresher counts Refresh calls so the executor test can assert
// the side effect actually fired.
type fakeCandidateRefresher struct{ calls int }

func (f *fakeCandidateRefresher) Refresh(ctx context.Context) { f.calls++ }

func TestShouldWarmCandidates(t *testing.T) {
	// nyLoc is the package-level America/New_York location. May 20 2026 is a
	// Wednesday; May 23 a Saturday; May 24 a Sunday.
	at := func(d, hh, mm int) time.Time {
		return time.Date(2026, 5, d, hh, mm, 0, 0, nyLoc)
	}
	cases := []struct {
		name string
		now  time.Time
		want bool
	}{
		{"weekday morning beat 09:35 ET", at(20, 9, 35), true},
		{"weekday Coil beat 15:45 ET", at(20, 15, 45), true},
		{"weekday Drift beat 17:00 ET", at(20, 17, 0), true},
		{"weekday window open edge 09:00 ET", at(20, 9, 0), true},
		{"weekday window close edge 17:30 ET", at(20, 17, 30), true},
		{"weekday pre-window 08:30 ET", at(20, 8, 30), false},
		{"weekday post-window 18:00 ET", at(20, 18, 0), false},
		{"weekday overnight 03:00 ET", at(20, 3, 0), false},
		{"Saturday midday", at(23, 15, 45), false},
		{"Sunday midday", at(24, 15, 45), false},
	}
	for _, tc := range cases {
		if got := ShouldWarmCandidates(tc.now); got != tc.want {
			t.Errorf("%s: ShouldWarmCandidates(%s) = %v, want %v",
				tc.name, tc.now.Format(time.RFC3339), got, tc.want)
		}
	}
}

func TestWarmCandidatesOnce_InWindowRefreshesAll(t *testing.T) {
	r1 := &fakeCandidateRefresher{}
	r2 := &fakeCandidateRefresher{}
	now := time.Date(2026, 5, 20, 15, 45, 0, 0, nyLoc) // Wed, in window
	if warmed := WarmCandidatesOnce(context.Background(), now, []CandidateRefresher{r1, r2}); !warmed {
		t.Fatalf("expected warmed=true in-window")
	}
	if r1.calls != 1 || r2.calls != 1 {
		t.Fatalf("expected each refresher called once; got r1=%d r2=%d", r1.calls, r2.calls)
	}
}

func TestWarmCandidatesOnce_OutOfWindowSkips(t *testing.T) {
	r := &fakeCandidateRefresher{}
	now := time.Date(2026, 5, 23, 15, 45, 0, 0, nyLoc) // Saturday
	if warmed := WarmCandidatesOnce(context.Background(), now, []CandidateRefresher{r}); warmed {
		t.Fatalf("expected warmed=false out-of-window")
	}
	if r.calls != 0 {
		t.Fatalf("expected no refresh out-of-window; got %d", r.calls)
	}
}

// With no refreshers the warmer must return immediately (never enter the ticker
// loop). main.go's per-agent gating relies on this: a bot with neither
// ENABLE_MEANREV_WARMER nor ENABLE_DRIFT_WARMER builds an empty slice, and the
// outer len>0 guard plus this early return mean no warmer goroutine spins.
func TestRunCandidateCacheWarmer_EmptyRefreshers_Noop(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	done := make(chan struct{})
	go func() {
		RunCandidateCacheWarmer(ctx, time.Second, nil)
		close(done)
	}()
	select {
	case <-done: // returned immediately, as required
	case <-ctx.Done():
		t.Error("RunCandidateCacheWarmer with empty refreshers did not return immediately")
	}
}
