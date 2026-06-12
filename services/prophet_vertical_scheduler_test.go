package services

import (
	"context"
	"testing"
	"time"
)

func TestVerticalScheduler_TicksAndCachesResult(t *testing.T) {
	store := newFakeVerticalStore()
	ex, _ := newVertExec(store, vertStubChain{}, vertStubBars{}, &vertStubMleg{}, &vertStubGuard{})
	s := NewProphetVerticalScheduler(ex, 5*time.Millisecond, 5*time.Millisecond, func() bool { return true }, nil)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { s.Start(ctx); close(done) }()

	deadline := time.After(2 * time.Second)
	for s.LastResult() == nil {
		select {
		case <-deadline:
			t.Fatal("scheduler never ticked")
		case <-time.After(5 * time.Millisecond):
		}
	}
	cancel()
	<-done
	if s.LastResult().Date == "" {
		t.Fatal("tick result must carry a date")
	}
}
