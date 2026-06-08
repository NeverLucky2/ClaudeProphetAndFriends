package services

import (
	"context"
	"fmt"
	"io"
	"sync"
	"time"

	"github.com/sirupsen/logrus"
)

// ProphetHedgeScheduler runs the Prophet Hedge daily heartbeat at 17:00 ET on weekdays.
// One scheduler per process; intended to be started in cmd/bot/main.go behind
// the PROPHET_HEDGE_SCHEDULER_ENABLED env flag. The scheduler is single-threaded:
// at most one RunHeartbeat is in flight at any time.
type ProphetHedgeScheduler struct {
	executor *ProphetHedgeExecutor
	logger   *logrus.Logger
	now      func() time.Time

	mu   sync.RWMutex
	last *HedgeResult
}

// NewProphetHedgeScheduler constructs the scheduler. A nil logger is replaced with
// a logrus default whose output is io.Discard (matching the executor).
func NewProphetHedgeScheduler(exec *ProphetHedgeExecutor, logger *logrus.Logger) *ProphetHedgeScheduler {
	if logger == nil {
		logger = logrus.New()
		logger.SetOutput(io.Discard)
	}
	return &ProphetHedgeScheduler{
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
func (s *ProphetHedgeScheduler) Start(ctx context.Context) {
	for {
		next := nextFireTime(s.now())
		wait := next.Sub(s.now())
		if wait < 0 {
			wait = 0
		}
		s.logger.WithFields(logrus.Fields{
			"next_fire_utc": next.Format(time.RFC3339),
			"wait":          wait.String(),
		}).Info("hedge-scheduler: scheduled next fire")

		select {
		case <-ctx.Done():
			s.logger.Info("hedge-scheduler: context canceled, exiting")
			return
		case <-time.After(wait):
		}

		res, err := s.executor.RunHeartbeat(ctx, s.now())
		if err != nil {
			s.logger.WithError(err).Error("hedge-scheduler: heartbeat error")
			// Still cache the (possibly nil) result so the status endpoint
			// can surface "no successful heartbeat" — but only if res != nil.
		}
		if res != nil {
			s.mu.Lock()
			s.last = res
			s.mu.Unlock()
			s.logger.WithFields(logrus.Fields{
				"date":         res.Date,
				"armed":        res.Armed,
				"open_count":   res.OpenCount,
				"opened":       res.Opened,
				"closed":       res.Closed,
				"skips":        res.Skips,
				"errors":       res.Errors,
				"skipped":      res.Skipped,
			}).Info("hedge-scheduler: heartbeat complete")
			s.logger.Info(formatHeartbeatLine("Defensive-Prophet",
				fmt.Sprintf("armed=%t, %d open, %d opened, %d closed, %d skips",
					res.Armed, res.OpenCount, len(res.Opened), len(res.Closed), len(res.Skips)),
				s.now().In(nyLoc).Format("15:04")))
		}
	}
}

// LastResult returns the most recent successful (or partial) heartbeat result,
// or nil if no heartbeat has run yet this process. Safe for concurrent reads
// from the status endpoint.
func (s *ProphetHedgeScheduler) LastResult() *HedgeResult {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.last
}
