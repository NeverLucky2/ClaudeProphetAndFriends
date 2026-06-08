package services

import (
	"context"
	"fmt"
	"io"
	"sync"
	"time"

	"github.com/sirupsen/logrus"
)

// TurtleScheduler runs the Turtle daily heartbeat at 17:00 ET on weekdays.
// One scheduler per process; intended to be started in cmd/bot/main.go behind
// the TURTLE_SCHEDULER_ENABLED env flag. The scheduler is single-threaded:
// at most one RunHeartbeat is in flight at any time.
type TurtleScheduler struct {
	executor *TurtleExecutor
	logger   *logrus.Logger
	now      func() time.Time

	mu   sync.RWMutex
	last *HeartbeatResult
}

// NewTurtleScheduler constructs the scheduler. A nil logger is replaced with
// a logrus default whose output is io.Discard (matching the executor).
func NewTurtleScheduler(exec *TurtleExecutor, logger *logrus.Logger) *TurtleScheduler {
	if logger == nil {
		logger = logrus.New()
		logger.SetOutput(io.Discard)
	}
	return &TurtleScheduler{
		executor: exec,
		logger:   logger,
		now:      time.Now,
	}
}

// Start blocks until ctx is canceled. On each tick: compute nextFireTime,
// sleep until then, call RunHeartbeat, cache the result, log a summary.
// Errors from RunHeartbeat are logged but do not stop the scheduler — the
// next 17:00 ET will retry. If ctx is canceled mid-sleep, Start returns
// cleanly without invoking the executor.
func (s *TurtleScheduler) Start(ctx context.Context) {
	for {
		next := nextFireTime(s.now())
		wait := next.Sub(s.now())
		if wait < 0 {
			wait = 0
		}
		s.logger.WithFields(logrus.Fields{
			"next_fire_utc": next.Format(time.RFC3339),
			"wait":          wait.String(),
		}).Info("turtle-scheduler: scheduled next fire")

		select {
		case <-ctx.Done():
			s.logger.Info("turtle-scheduler: context canceled, exiting")
			return
		case <-time.After(wait):
		}

		res, err := s.executor.RunHeartbeat(ctx, s.now())
		if err != nil {
			s.logger.WithError(err).Error("turtle-scheduler: heartbeat error")
			// Still cache the (possibly nil) result so the status endpoint
			// can surface "no successful heartbeat" — but only if res != nil.
		}
		if res != nil {
			s.mu.Lock()
			s.last = res
			s.mu.Unlock()
			s.logger.WithFields(logrus.Fields{
				"date":            res.Date,
				"entries":         res.Entries,
				"exits":           res.Exits,
				"skips":           res.Skips,
				"errors":          res.Errors,
				"skipped":         res.Skipped,
				"circuit_breaker": res.CircuitBreaker,
			}).Info("turtle-scheduler: heartbeat complete")
			s.logger.Info(formatHeartbeatLine("Turtle",
				fmt.Sprintf("%d entries, %d exits, %d skips", len(res.Entries), len(res.Exits), len(res.Skips)),
				s.now().In(nyLoc).Format("15:04")))
		}
	}
}

// LastResult returns the most recent successful (or partial) heartbeat result,
// or nil if no heartbeat has run yet this process. Safe for concurrent reads
// from the status endpoint.
func (s *TurtleScheduler) LastResult() *HeartbeatResult {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.last
}

// nextFireTime returns the next weekday 17:00 ET (UTC-normalized) strictly
// after `from`. If `from` is before today's 17:00 ET on a weekday, returns
// today's 17:00 ET; otherwise rolls forward to the next weekday.
//
// Date advancement uses time.Date with day+1 rather than time.Add(24h) so the
// wall clock stays pinned to 17:00 ET across DST transitions (spring-forward
// week, the absolute duration between two 17:00 ETs is 23h, not 24h).
func nextFireTime(from time.Time) time.Time {
	local := from.In(nyLoc)
	candidate := time.Date(local.Year(), local.Month(), local.Day(), 17, 0, 0, 0, nyLoc)
	if !candidate.After(local) {
		candidate = time.Date(local.Year(), local.Month(), local.Day()+1, 17, 0, 0, 0, nyLoc)
	}
	for candidate.Weekday() == time.Saturday || candidate.Weekday() == time.Sunday {
		candidate = time.Date(candidate.Year(), candidate.Month(), candidate.Day()+1, 17, 0, 0, 0, nyLoc)
	}
	return candidate.UTC()
}
