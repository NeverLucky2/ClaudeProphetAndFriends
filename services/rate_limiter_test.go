package services

import (
	"context"
	"errors"
	"testing"

	"golang.org/x/time/rate"
)

func TestNewAlpacaDataRateLimiter_Sizing(t *testing.T) {
	// 180/min => 3 events/sec.
	lim := NewAlpacaDataRateLimiter(180, 10)
	if got := float64(lim.Limit()); got < 2.99 || got > 3.01 {
		t.Errorf("limit: got %v events/sec, want ~3.0 (180/min)", got)
	}
	if lim.Burst() != 10 {
		t.Errorf("burst: got %d, want 10", lim.Burst())
	}
}

func TestNewAlpacaDataRateLimiter_NonPositiveIsUnlimited(t *testing.T) {
	lim := NewAlpacaDataRateLimiter(0, 10)
	if lim.Limit() != rate.Inf {
		t.Errorf("non-positive perMinute must yield rate.Inf, got %v", lim.Limit())
	}
}

// fakeLimiter records Wait calls and can be made to fail.
type fakeLimiter struct {
	calls int
	err   error
}

func (f *fakeLimiter) Wait(ctx context.Context) error {
	f.calls++
	return f.err
}

func TestAcquire_NilLimiterIsNoOp(t *testing.T) {
	if err := acquire(context.Background(), nil); err != nil {
		t.Errorf("nil limiter must be a no-op, got %v", err)
	}
}

func TestAcquire_DelegatesToLimiter(t *testing.T) {
	sentinel := errors.New("blocked")
	f := &fakeLimiter{err: sentinel}
	err := acquire(context.Background(), f)
	if f.calls != 1 {
		t.Errorf("Wait calls: got %d, want 1", f.calls)
	}
	if !errors.Is(err, sentinel) {
		t.Errorf("acquire must return the limiter error, got %v", err)
	}
}
