package services

import (
	"context"
	"testing"
	"time"

	"prophet-trader/models"
)

type fakeListStore struct {
	condors []*models.DBHarvestCondor
}

func (f *fakeListStore) ListOpenHarvestCondors() ([]*models.DBHarvestCondor, error) {
	return f.condors, nil
}

type fakeCostPricer struct {
	costs map[string]float64
}

func (f *fakeCostPricer) CostToClosePerContract(_ context.Context, c *models.DBHarvestCondor) (float64, error) {
	return f.costs[c.CondorID], nil
}

type fakeCloser struct {
	calls []CloseCondorRequest
}

func (f *fakeCloser) CloseCondor(_ context.Context, req CloseCondorRequest) (*CloseCondorResult, error) {
	f.calls = append(f.calls, req)
	return &CloseCondorResult{CondorID: req.CondorID, CloseOrderID: "ord-x", Status: "CLOSING"}, nil
}

// mkCondor builds a test condor with Expiration set relative to the supplied
// `now`. Taking `now` as a parameter (instead of calling time.Now() internally)
// lets the test pass the same instant to EvaluateTick, eliminating microsecond
// drift in the DTE rounding that could otherwise make TestExitMonitor_TimeExitFiresAtDTE21
// flaky on the boundary.
func mkCondor(id, underlying string, contracts int, credit float64, expDaysAhead int, now time.Time) *models.DBHarvestCondor {
	return &models.DBHarvestCondor{
		CondorID:          id,
		Underlying:        underlying,
		Contracts:         contracts,
		CreditPerContract: credit,
		Status:            "OPEN",
		Expiration:        now.Add(time.Duration(expDaysAhead*24) * time.Hour),
		ShortPutSymbol:    id + "_sp",
		LongPutSymbol:     id + "_lp",
		ShortCallSymbol:   id + "_sc",
		LongCallSymbol:    id + "_lc",
	}
}

func TestExitMonitor_TimeExitFiresAtDTE21(t *testing.T) {
	now := time.Now().UTC()
	c := mkCondor("c1", "SPY", 1, 1.0, 21, now) // exactly 21 DTE
	store := &fakeListStore{condors: []*models.DBHarvestCondor{c}}
	pricer := &fakeCostPricer{costs: map[string]float64{"c1": 0.80}} // not at profit or loss threshold
	closer := &fakeCloser{}
	m := NewHarvestExitMonitor(store, pricer, closer)
	m.EvaluateTick(context.Background(), now)
	if len(closer.calls) != 1 {
		t.Fatalf("expected 1 close call, got %d", len(closer.calls))
	}
	if closer.calls[0].CloseReason != "time_exit" {
		t.Errorf("got reason %q, want time_exit", closer.calls[0].CloseReason)
	}
	if closer.calls[0].OrderType != "limit" {
		t.Errorf("got order type %q, want limit", closer.calls[0].OrderType)
	}
}

func TestExitMonitor_LossStopFiresAt2xCredit(t *testing.T) {
	now := time.Now().UTC()
	c := mkCondor("c1", "SPY", 1, 1.0, 30, now) // 30 DTE
	store := &fakeListStore{condors: []*models.DBHarvestCondor{c}}
	pricer := &fakeCostPricer{costs: map[string]float64{"c1": 2.10}} // > 2x 1.0 credit
	closer := &fakeCloser{}
	m := NewHarvestExitMonitor(store, pricer, closer)
	m.EvaluateTick(context.Background(), now)
	if len(closer.calls) != 1 {
		t.Fatalf("expected 1 close call, got %d", len(closer.calls))
	}
	if closer.calls[0].CloseReason != "loss_stop" {
		t.Errorf("got reason %q, want loss_stop", closer.calls[0].CloseReason)
	}
}

func TestExitMonitor_ProfitTargetFiresAt50pct(t *testing.T) {
	now := time.Now().UTC()
	c := mkCondor("c1", "SPY", 1, 1.0, 30, now)
	store := &fakeListStore{condors: []*models.DBHarvestCondor{c}}
	pricer := &fakeCostPricer{costs: map[string]float64{"c1": 0.40}} // < 0.50x 1.0 credit
	closer := &fakeCloser{}
	m := NewHarvestExitMonitor(store, pricer, closer)
	m.EvaluateTick(context.Background(), now)
	if len(closer.calls) != 1 {
		t.Fatalf("expected 1 close call, got %d", len(closer.calls))
	}
	if closer.calls[0].CloseReason != "profit_target" {
		t.Errorf("got reason %q, want profit_target", closer.calls[0].CloseReason)
	}
}

func TestExitMonitor_HoldsWhenNoTriggers(t *testing.T) {
	now := time.Now().UTC()
	c := mkCondor("c1", "SPY", 1, 1.0, 30, now)
	store := &fakeListStore{condors: []*models.DBHarvestCondor{c}}
	pricer := &fakeCostPricer{costs: map[string]float64{"c1": 0.80}} // in band
	closer := &fakeCloser{}
	m := NewHarvestExitMonitor(store, pricer, closer)
	m.EvaluateTick(context.Background(), now)
	if len(closer.calls) != 0 {
		t.Fatalf("expected no close calls, got %d", len(closer.calls))
	}
}

func TestExitMonitor_LossStopWinsOverProfitTarget(t *testing.T) {
	// Defensive: never reachable in practice (cost can't be both >2x and <0.5x),
	// but the priority order should match the rules doc: time -> loss -> profit.
	// This case has DTE=21 AND cost=2.20 (both time and loss active); time wins.
	now := time.Now().UTC()
	c := mkCondor("c1", "SPY", 1, 1.0, 21, now)
	store := &fakeListStore{condors: []*models.DBHarvestCondor{c}}
	pricer := &fakeCostPricer{costs: map[string]float64{"c1": 2.20}}
	closer := &fakeCloser{}
	m := NewHarvestExitMonitor(store, pricer, closer)
	m.EvaluateTick(context.Background(), now)
	if len(closer.calls) != 1 {
		t.Fatalf("expected 1 close call, got %d", len(closer.calls))
	}
	if closer.calls[0].CloseReason != "time_exit" {
		t.Errorf("DTE<=21 must take priority, got %q", closer.calls[0].CloseReason)
	}
}
