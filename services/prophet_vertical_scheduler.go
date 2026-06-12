package services

import (
	"context"
	"io"
	"sync"
	"time"

	"github.com/sirupsen/logrus"
)

// ProphetVerticalScheduler drives the vertical executor's manage tick on an
// intraday cadence: every `interval` while marketIsOpen(), else `idleInterval`.
// Loop shape mirrors ProphetOptionsStopMonitor.Start (NOT the once-daily hedge
// scheduler). Opens are LLM-triggered via Phase 3; this loop only manages, so
// with an empty ledger it is a cheap no-op.
type ProphetVerticalScheduler struct {
	executor     *ProphetVerticalExecutor
	interval     time.Duration
	idleInterval time.Duration
	marketIsOpen func() bool
	logger       *logrus.Logger

	mu   sync.RWMutex
	last *VerticalTickResult
}

func NewProphetVerticalScheduler(exec *ProphetVerticalExecutor, interval, idleInterval time.Duration, marketIsOpen func() bool, logger *logrus.Logger) *ProphetVerticalScheduler {
	if logger == nil {
		logger = logrus.New()
		logger.SetOutput(io.Discard)
	}
	return &ProphetVerticalScheduler{
		executor: exec, interval: interval, idleInterval: idleInterval,
		marketIsOpen: marketIsOpen, logger: logger,
	}
}

// Start blocks until ctx is canceled.
func (s *ProphetVerticalScheduler) Start(ctx context.Context) {
	timer := time.NewTimer(s.interval)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			s.logger.Info("vertical-scheduler: context canceled, exiting")
			return
		case <-timer.C:
		}
		res := &VerticalTickResult{}
		s.executor.RunManageTick(ctx, time.Now(), res)
		s.mu.Lock()
		s.last = res
		s.mu.Unlock()
		if len(res.Closed) > 0 || len(res.Errors) > 0 {
			s.logger.WithFields(logrus.Fields{
				"open_count": res.OpenCount, "closed": res.Closed, "errors": res.Errors,
			}).Info("vertical-scheduler: tick")
		}
		next := s.interval
		if s.marketIsOpen != nil && !s.marketIsOpen() {
			next = s.idleInterval
		}
		timer.Reset(next)
	}
}

// LastResult returns the most recent tick result (nil before the first tick).
func (s *ProphetVerticalScheduler) LastResult() *VerticalTickResult {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.last
}
