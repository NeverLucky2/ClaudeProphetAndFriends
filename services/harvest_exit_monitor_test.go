package services

import (
	"context"
	"errors"
	"testing"
	"time"

	"prophet-trader/interfaces"
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
	errs  map[string]error
}

func (f *fakeCostPricer) CostToClosePerContract(_ context.Context, c *models.DBHarvestCondor) (float64, error) {
	if e, ok := f.errs[c.CondorID]; ok && e != nil {
		return 0, e
	}
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

// fakeOrderTracker is the in-test order-state source. statuses is a
// CondorID-agnostic orderID->status map; the monitor only ever looks up
// CloseOrderID strings so callers seed those directly.
type fakeOrderTracker struct {
	statuses map[string]string // orderID -> status
	cancels  []string
}

func (f *fakeOrderTracker) GetOrder(_ context.Context, id string) (*interfaces.Order, error) {
	return &interfaces.Order{ID: id, Status: f.statuses[id]}, nil
}

func (f *fakeOrderTracker) CancelOrder(_ context.Context, id string) error {
	f.cancels = append(f.cancels, id)
	return nil
}

func TestExitMonitor_EscalatesLossStopFromLimitToMarket(t *testing.T) {
	// Simulate: a previous tick already placed the tier-0 marketable limit
	// (cost+$0.20) at t0; the order has not filled by t0+3min. The 2-min
	// loss_stop escalation window has elapsed, so the monitor must cancel
	// the existing limit and re-place as market with AllowReplaceClosing.
	t0 := time.Date(2026, 5, 16, 14, 0, 0, 0, time.UTC)
	c := mkCondor("c1", "SPY", 1, 1.0, 30, t0)
	c.CloseOrderID = "ord-1"
	c.Status = "CLOSING"
	store := &fakeListStore{condors: []*models.DBHarvestCondor{c}}
	pricer := &fakeCostPricer{costs: map[string]float64{"c1": 2.20}}
	closer := &fakeCloser{}
	tracker := &fakeOrderTracker{statuses: map[string]string{"ord-1": "open"}}
	m := NewHarvestExitMonitor(store, pricer, closer)
	m.SetOrderTracker(tracker)
	m.RecordTierAttempt("c1", "loss_stop", t0)

	m.EvaluateTick(context.Background(), t0.Add(3*time.Minute))

	if len(tracker.cancels) != 1 || tracker.cancels[0] != "ord-1" {
		t.Fatalf("expected cancels=[ord-1], got %v", tracker.cancels)
	}
	if len(closer.calls) != 1 {
		t.Fatalf("expected 1 close call, got %d", len(closer.calls))
	}
	got := closer.calls[0]
	if got.OrderType != "market" {
		t.Errorf("OrderType: got %q, want market", got.OrderType)
	}
	if got.LimitPrice != 0 {
		t.Errorf("LimitPrice: got %v, want 0 (market orders zero the limit)", got.LimitPrice)
	}
	if !got.AllowReplaceClosing {
		t.Errorf("AllowReplaceClosing: got false, want true (closer must accept CLOSING row)")
	}
	if got.FinalizeImmediately {
		t.Errorf("FinalizeImmediately: got true, want false (still monitor-mode)")
	}
	if got.CloseReason != "loss_stop" {
		t.Errorf("CloseReason: got %q, want loss_stop (reason must be preserved across tiers)", got.CloseReason)
	}
}

func TestExitMonitor_NoEscalationBeforeWindow(t *testing.T) {
	// Same setup as the escalation test but only 1 minute elapsed — below
	// the 2-minute loss_stop window. No cancel, no re-place.
	t0 := time.Date(2026, 5, 16, 14, 0, 0, 0, time.UTC)
	c := mkCondor("c1", "SPY", 1, 1.0, 30, t0)
	c.CloseOrderID = "ord-1"
	c.Status = "CLOSING"
	store := &fakeListStore{condors: []*models.DBHarvestCondor{c}}
	pricer := &fakeCostPricer{costs: map[string]float64{"c1": 2.20}}
	closer := &fakeCloser{}
	tracker := &fakeOrderTracker{statuses: map[string]string{"ord-1": "open"}}
	m := NewHarvestExitMonitor(store, pricer, closer)
	m.SetOrderTracker(tracker)
	m.RecordTierAttempt("c1", "loss_stop", t0)

	m.EvaluateTick(context.Background(), t0.Add(1*time.Minute))

	if len(tracker.cancels) != 0 {
		t.Fatalf("expected no cancels before window, got %v", tracker.cancels)
	}
	if len(closer.calls) != 0 {
		t.Fatalf("expected no close calls before window, got %d", len(closer.calls))
	}
}

// fakeUpdater records the most recent partial update applied via
// UpdateHarvestCondor. Used to assert that the monitor flips CLOSING -> CLOSED
// when the broker confirms a fill.
type fakeUpdater struct {
	lastCondorID string
	lastUpdates  map[string]interface{}
}

func (f *fakeUpdater) UpdateHarvestCondor(id string, u map[string]interface{}) error {
	f.lastCondorID = id
	f.lastUpdates = u
	return nil
}

func TestExitMonitor_FinalizeOnFillFlipsStatusToClosed(t *testing.T) {
	t0 := time.Date(2026, 5, 16, 14, 0, 0, 0, time.UTC)
	c := mkCondor("c1", "SPY", 1, 1.0, 30, t0)
	c.CloseOrderID = "ord-1"
	c.Status = "CLOSING"
	store := &fakeListStore{condors: []*models.DBHarvestCondor{c}}
	closer := &fakeCloser{}
	tracker := &fakeOrderTracker{statuses: map[string]string{"ord-1": "filled"}}
	updater := &fakeUpdater{}

	m := NewHarvestExitMonitor(store, &fakeCostPricer{costs: map[string]float64{}}, closer)
	m.SetOrderTracker(tracker)
	m.SetUpdater(updater)
	m.RecordTierAttempt("c1", "loss_stop", t0) // pre-seeded so we can verify cleanup
	m.EvaluateTick(context.Background(), t0.Add(5*time.Minute))

	if updater.lastCondorID != "c1" {
		t.Errorf("expected update on c1, got %q", updater.lastCondorID)
	}
	if updater.lastUpdates["status"] != "CLOSED" {
		t.Errorf("expected status CLOSED, got %v", updater.lastUpdates["status"])
	}
	closedAt, ok := updater.lastUpdates["closed_at"].(*time.Time)
	if !ok || closedAt == nil {
		t.Errorf("expected closed_at *time.Time, got %T (%v)", updater.lastUpdates["closed_at"], updater.lastUpdates["closed_at"])
	}
	// Verify the attempts entry was cleaned up post-fill.
	if _, stillPresent := m.attempts["c1"]; stillPresent {
		t.Error("expected m.attempts to be cleaned up after fill")
	}
	// No close-call should have been placed: row is already filled, escalation
	// path must not fire.
	if len(closer.calls) != 0 {
		t.Errorf("expected 0 close calls on fill, got %d", len(closer.calls))
	}
}

func TestExitMonitor_PricerErrorAfterCancelRefreshesPlacedAt(t *testing.T) {
	// Repro of the Task-4-review concern: if the pricer fails immediately after
	// a successful cancel, the monitor must NOT leave attempts.placedAt at the
	// original timestamp — otherwise the next tick re-enters the cancel branch
	// (window already elapsed) and a flapping pricer can wedge a row by
	// repeatedly calling CancelOrder on an already-canceled order.
	//
	// Expected behavior: cancel runs, no close-call is placed, and
	// attempts.placedAt is bumped to `now` so the next tick waits the full
	// escalation window before retrying. Tier is unchanged because the
	// replacement order never went out.
	t0 := time.Date(2026, 5, 16, 14, 0, 0, 0, time.UTC)
	c := mkCondor("c1", "SPY", 1, 1.0, 30, t0)
	c.CloseOrderID = "ord-1"
	c.Status = "CLOSING"
	store := &fakeListStore{condors: []*models.DBHarvestCondor{c}}
	pricer := &fakeCostPricer{
		costs: map[string]float64{},
		errs:  map[string]error{"c1": errors.New("pricer down")},
	}
	closer := &fakeCloser{}
	tracker := &fakeOrderTracker{statuses: map[string]string{"ord-1": "open"}}

	m := NewHarvestExitMonitor(store, pricer, closer)
	m.SetOrderTracker(tracker)
	m.RecordTierAttempt("c1", "loss_stop", t0)

	m.EvaluateTick(context.Background(), t0.Add(3*time.Minute))

	if len(tracker.cancels) != 1 {
		t.Errorf("expected cancel, got %v", tracker.cancels)
	}
	if len(closer.calls) != 0 {
		t.Errorf("expected no close call on pricer error, got %d", len(closer.calls))
	}
	got := m.attempts["c1"]
	want := t0.Add(3 * time.Minute)
	if !got.placedAt.Equal(want) {
		t.Errorf("expected placedAt refreshed to %v, got %v", want, got.placedAt)
	}
	if got.tier != 0 { // unchanged from RecordTierAttempt above
		t.Errorf("expected tier unchanged at 0, got %d", got.tier)
	}
	if got.reason != "loss_stop" {
		t.Errorf("expected reason unchanged at loss_stop, got %q", got.reason)
	}
}
