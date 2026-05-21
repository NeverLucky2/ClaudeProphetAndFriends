package services

import (
	"sync"
	"time"
)

// ProphetBeatObserver records the wall-clock time of the most recent Prophet
// (v2-options) beat. The auto-stop monitor reads it to implement a
// beats-observed startup grace: the loss floor stays dormant until Prophet has
// taken at least one beat since the monitor booted, deferring to the LLM's next
// decision after a restart/deploy. Thread-safe: written by the beat-context
// HTTP handler, read by the monitor goroutine.
type ProphetBeatObserver struct {
	mu       sync.RWMutex
	last     time.Time
	observed bool
}

func NewProphetBeatObserver() *ProphetBeatObserver {
	return &ProphetBeatObserver{}
}

// RecordBeat stamps the most recent Prophet beat time.
func (o *ProphetBeatObserver) RecordBeat(t time.Time) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.last = t
	o.observed = true
}

// LastProphetBeat returns the most recent beat time and whether any beat has
// been observed.
func (o *ProphetBeatObserver) LastProphetBeat() (time.Time, bool) {
	o.mu.RLock()
	defer o.mu.RUnlock()
	return o.last, o.observed
}
