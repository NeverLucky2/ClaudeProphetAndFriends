package services

import (
	"context"
	"time"

	"github.com/sirupsen/logrus"
)

// CandidateCacheWarmInterval is how often the warmer recomputes the candidate
// caches while in-window. Kept below the services' 5-minute candidate cache
// TTL so a once-daily beat's read (GetCandidates) always lands within TTL of
// the last warm and serves a hot cache instead of triggering a cold
// full-universe scan that exceeds agent/preflight.js's 2s budget.
const CandidateCacheWarmInterval = 4 * time.Minute

const (
	warmWindowStartMin = 9 * 60     // 09:00 ET
	warmWindowEndMin   = 17*60 + 30 // 17:30 ET
)

// CandidateRefresher is the narrow interface the warmer drives. Both
// MeanRevCandidatesService and DriftCandidatesService satisfy it via Refresh.
type CandidateRefresher interface {
	Refresh(ctx context.Context)
}

// ShouldWarmCandidates reports whether now (any location) falls in the weekday
// ET window that brackets the once-daily mechanical-equity beats: Coil's
// optional 09:35 morning beat and 15:45 ET beat, and Drift's 17:00 ET beat.
// Outside this window the caches are left cold to avoid pointless overnight and
// weekend full-universe scans.
func ShouldWarmCandidates(now time.Time) bool {
	et := now.In(nyLoc)
	switch et.Weekday() {
	case time.Saturday, time.Sunday:
		return false
	}
	mins := et.Hour()*60 + et.Minute()
	return mins >= warmWindowStartMin && mins <= warmWindowEndMin
}

// WarmCandidatesOnce refreshes every refresher when now is in-window, returning
// whether it warmed. Out-of-window it is a no-op. Extracted from the loop so the
// in/out-of-window dispatch is unit-testable without timing.
func WarmCandidatesOnce(ctx context.Context, now time.Time, refreshers []CandidateRefresher) bool {
	if !ShouldWarmCandidates(now) {
		return false
	}
	for _, r := range refreshers {
		r.Refresh(ctx)
	}
	return true
}

// RunCandidateCacheWarmer keeps the given candidate caches hot during the
// weekday ET beat window. Warms once on start (so a mid-window restart primes
// immediately) then every CandidateCacheWarmInterval until ctx is cancelled.
// Blocks; intended to be launched in its own goroutine.
func RunCandidateCacheWarmer(ctx context.Context, interval time.Duration, logger *logrus.Logger, refreshers ...CandidateRefresher) {
	if len(refreshers) == 0 {
		return
	}
	if WarmCandidatesOnce(ctx, time.Now(), refreshers) && logger != nil {
		logger.Debug("Candidate caches warmed (startup)")
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if WarmCandidatesOnce(ctx, time.Now(), refreshers) && logger != nil {
				logger.Debug("Candidate caches warmed")
			}
		}
	}
}
