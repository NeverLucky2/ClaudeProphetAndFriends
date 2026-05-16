package services

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"prophet-trader/models"
)

type fakeCondorStore struct {
	condor       *models.DBHarvestCondor
	getErr       error
	updateErr    error
	lastUpdates  map[string]interface{}
	lastCondorID string
}

func (f *fakeCondorStore) GetHarvestCondorByID(id string) (*models.DBHarvestCondor, error) {
	return f.condor, f.getErr
}
func (f *fakeCondorStore) UpdateHarvestCondor(id string, updates map[string]interface{}) error {
	f.lastCondorID = id
	f.lastUpdates = updates
	return f.updateErr
}

// TestHarvestCloser_PlacesOrderAndUpdatesRow exercises the controller-style
// invocation: FinalizeImmediately=true. The closer should place the order
// and write status=CLOSED + closed_at, preserving the original endpoint
// contract verbatim.
func TestHarvestCloser_PlacesOrderAndUpdatesRow(t *testing.T) {
	store := &fakeCondorStore{
		condor: &models.DBHarvestCondor{
			CondorID:          "c1",
			Underlying:        "SPY",
			Contracts:         2,
			CreditPerContract: 1.50,
			Status:            "OPEN",
			ShortPutSymbol:    "SPY_P_400",
			LongPutSymbol:     "SPY_P_395",
			ShortCallSymbol:   "SPY_C_450",
			LongCallSymbol:    "SPY_C_455",
		},
	}
	var capturedOrder MultiLegOrder
	placeFn := PlaceMultiLegOrderFn(func(_ context.Context, o MultiLegOrder) (string, error) {
		capturedOrder = o
		return "ord-123", nil
	})
	closer := NewHarvestCloser(store, placeFn)

	res, err := closer.CloseCondor(context.Background(), CloseCondorRequest{
		CondorID:            "c1",
		OrderType:           "limit",
		LimitPrice:          0.50,
		CostPerContract:     0.50,
		CloseReason:         "profit_target",
		FinalizeImmediately: true,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.CloseOrderID != "ord-123" {
		t.Errorf("got close order id %q, want ord-123", res.CloseOrderID)
	}
	wantPnL := (1.50 - 0.50) * 2 * 100
	if res.RealizedPnL != wantPnL {
		t.Errorf("got realized pnl %.2f, want %.2f", res.RealizedPnL, wantPnL)
	}
	if capturedOrder.Contracts != 2 {
		t.Errorf("got contracts %d, want 2", capturedOrder.Contracts)
	}
	if capturedOrder.Strategy != "harvest" {
		t.Errorf("got strategy %q, want harvest", capturedOrder.Strategy)
	}
	if len(capturedOrder.Legs) != 4 {
		t.Errorf("got %d legs, want 4", len(capturedOrder.Legs))
	}
	if store.lastUpdates["status"] != "CLOSED" {
		t.Errorf("got status %v, want CLOSED", store.lastUpdates["status"])
	}
	if _, ok := store.lastUpdates["close_order_id"]; !ok {
		t.Error("expected close_order_id in updates")
	}
	if res.Status != "CLOSED" {
		t.Errorf("got result status %q, want CLOSED", res.Status)
	}
	if store.lastCondorID != "c1" {
		t.Errorf("expected update to land on c1, got %q", store.lastCondorID)
	}
}

func TestHarvestCloser_RejectsNonOpenCondor(t *testing.T) {
	store := &fakeCondorStore{
		condor: &models.DBHarvestCondor{CondorID: "c1", Status: "CLOSED"},
	}
	closer := NewHarvestCloser(store, func(_ context.Context, _ MultiLegOrder) (string, error) {
		t.Fatal("placeMLeg should not be called")
		return "", nil
	})
	_, err := closer.CloseCondor(context.Background(), CloseCondorRequest{
		CondorID: "c1", OrderType: "limit", CloseReason: "profit_target",
	})
	if !errors.Is(err, ErrCondorNotOpen) {
		t.Errorf("got err %v, want ErrCondorNotOpen", err)
	}
}

func TestHarvestCloser_MarketOrderForcesZeroLimit(t *testing.T) {
	store := &fakeCondorStore{
		condor: &models.DBHarvestCondor{CondorID: "c1", Status: "OPEN", Contracts: 1,
			CreditPerContract: 1.0, ShortPutSymbol: "x", LongPutSymbol: "x", ShortCallSymbol: "x", LongCallSymbol: "x"},
	}
	var lp float64 = -1
	placeFn := PlaceMultiLegOrderFn(func(_ context.Context, o MultiLegOrder) (string, error) {
		lp = o.LimitPrice
		return "ord", nil
	})
	closer := NewHarvestCloser(store, placeFn)
	_, err := closer.CloseCondor(context.Background(), CloseCondorRequest{
		CondorID: "c1", OrderType: "market", LimitPrice: 99, CostPerContract: 0.5, CloseReason: "loss_stop",
		FinalizeImmediately: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if lp != 0 {
		t.Errorf("market order should zero limit price, got %v", lp)
	}
}

// TestHarvestCloser_FinalizeImmediatelyTrueWritesClosedAndClosedAt verifies
// the controller path: an OPEN condor with FinalizeImmediately=true gets
// status=CLOSED and a non-nil closed_at pointer.
func TestHarvestCloser_FinalizeImmediatelyTrueWritesClosedAndClosedAt(t *testing.T) {
	store := &fakeCondorStore{
		condor: &models.DBHarvestCondor{
			CondorID: "c1", Status: "OPEN", Contracts: 1, CreditPerContract: 1.0,
			ShortPutSymbol: "x", LongPutSymbol: "x", ShortCallSymbol: "x", LongCallSymbol: "x",
		},
	}
	closer := NewHarvestCloser(store, func(_ context.Context, _ MultiLegOrder) (string, error) {
		return "ord-1", nil
	})
	res, err := closer.CloseCondor(context.Background(), CloseCondorRequest{
		CondorID: "c1", OrderType: "limit", CloseReason: "profit_target",
		FinalizeImmediately: true,
	})
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if store.lastUpdates["status"] != "CLOSED" {
		t.Errorf("status: got %v want CLOSED", store.lastUpdates["status"])
	}
	closedAt, ok := store.lastUpdates["closed_at"]
	if !ok {
		t.Fatal("expected closed_at in updates")
	}
	tp, ok := closedAt.(*time.Time)
	if !ok || tp == nil {
		t.Errorf("closed_at: got %T %v, want non-nil *time.Time", closedAt, closedAt)
	}
	if res.Status != "CLOSED" {
		t.Errorf("result status: got %q want CLOSED", res.Status)
	}
}

// TestHarvestCloser_FinalizeImmediatelyFalseWritesClosingAndNoClosedAt
// verifies the monitor path: an OPEN condor with FinalizeImmediately=false
// gets status=CLOSING with NO closed_at — the monitor's fill poll owns the
// CLOSING -> CLOSED flip.
func TestHarvestCloser_FinalizeImmediatelyFalseWritesClosingAndNoClosedAt(t *testing.T) {
	store := &fakeCondorStore{
		condor: &models.DBHarvestCondor{
			CondorID: "c1", Status: "OPEN", Contracts: 1, CreditPerContract: 1.0,
			ShortPutSymbol: "x", LongPutSymbol: "x", ShortCallSymbol: "x", LongCallSymbol: "x",
		},
	}
	closer := NewHarvestCloser(store, func(_ context.Context, _ MultiLegOrder) (string, error) {
		return "ord-1", nil
	})
	res, err := closer.CloseCondor(context.Background(), CloseCondorRequest{
		CondorID: "c1", OrderType: "limit", CloseReason: "loss_stop",
		FinalizeImmediately: false,
	})
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if store.lastUpdates["status"] != "CLOSING" {
		t.Errorf("status: got %v want CLOSING", store.lastUpdates["status"])
	}
	if _, hasClosedAt := store.lastUpdates["closed_at"]; hasClosedAt {
		t.Errorf("did not expect closed_at in updates, got %v", store.lastUpdates["closed_at"])
	}
	if res.Status != "CLOSING" {
		t.Errorf("result status: got %q want CLOSING", res.Status)
	}
}

// TestHarvestCloser_AllowReplaceClosingTrueAcceptsClosingRow verifies that
// when the monitor escalates a tier, it can pass AllowReplaceClosing=true
// to re-place an order against a CLOSING row.
func TestHarvestCloser_AllowReplaceClosingTrueAcceptsClosingRow(t *testing.T) {
	store := &fakeCondorStore{
		condor: &models.DBHarvestCondor{
			CondorID: "c1", Status: "CLOSING", Contracts: 1, CreditPerContract: 1.0,
			ShortPutSymbol: "x", LongPutSymbol: "x", ShortCallSymbol: "x", LongCallSymbol: "x",
		},
	}
	called := false
	placeFn := PlaceMultiLegOrderFn(func(_ context.Context, _ MultiLegOrder) (string, error) {
		called = true
		return "ord-2", nil
	})
	closer := NewHarvestCloser(store, placeFn)
	res, err := closer.CloseCondor(context.Background(), CloseCondorRequest{
		CondorID: "c1", OrderType: "limit", CloseReason: "loss_stop",
		FinalizeImmediately: false, AllowReplaceClosing: true,
	})
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if !called {
		t.Error("expected placeFn to be called")
	}
	if res.CloseOrderID != "ord-2" {
		t.Errorf("got order id %q, want ord-2", res.CloseOrderID)
	}
	if store.lastUpdates["status"] != "CLOSING" {
		t.Errorf("status: got %v want CLOSING", store.lastUpdates["status"])
	}
}

// TestHarvestCloser_AllowReplaceClosingFalseRejectsClosingRow verifies the
// controller's safety: without explicit opt-in, a CLOSING row is rejected
// (this is what stops an HTTP caller from re-placing a closing order).
func TestHarvestCloser_AllowReplaceClosingFalseRejectsClosingRow(t *testing.T) {
	store := &fakeCondorStore{
		condor: &models.DBHarvestCondor{CondorID: "c1", Status: "CLOSING"},
	}
	closer := NewHarvestCloser(store, func(_ context.Context, _ MultiLegOrder) (string, error) {
		t.Fatal("placeMLeg should not be called")
		return "", nil
	})
	_, err := closer.CloseCondor(context.Background(), CloseCondorRequest{
		CondorID: "c1", OrderType: "limit", CloseReason: "loss_stop",
		AllowReplaceClosing: false,
	})
	if !errors.Is(err, ErrCondorNotOpen) {
		t.Errorf("got err %v, want ErrCondorNotOpen", err)
	}
}

func TestHarvestCloser_DBUpdateFailureReturnsOrderIDInError(t *testing.T) {
	store := &fakeCondorStore{
		condor: &models.DBHarvestCondor{
			CondorID:          "c1",
			Underlying:        "SPY",
			Status:            "OPEN",
			Contracts:         1,
			CreditPerContract: 1.0,
			ShortPutSymbol:    "x", LongPutSymbol: "y",
			ShortCallSymbol: "z", LongCallSymbol: "w",
		},
		updateErr: errors.New("db down"),
	}
	placeFn := PlaceMultiLegOrderFn(func(_ context.Context, _ MultiLegOrder) (string, error) {
		return "ord-orphaned-99", nil
	})
	closer := NewHarvestCloser(store, placeFn)
	_, err := closer.CloseCondor(context.Background(), CloseCondorRequest{
		CondorID:            "c1",
		OrderType:           "limit",
		LimitPrice:          0.5,
		CostPerContract:     0.5,
		CloseReason:         "profit_target",
		FinalizeImmediately: true,
	})
	if err == nil {
		t.Fatal("expected error when DB update fails after order placement")
	}
	if !strings.Contains(err.Error(), "ord-orphaned-99") {
		t.Errorf("error must surface the close order ID so operators can recover the orphaned broker order; got: %v", err)
	}
}

func TestHarvestCloser_ClosedAtUsesInjectedClock(t *testing.T) {
	fixed := time.Date(2026, 5, 16, 21, 30, 0, 0, time.UTC)
	store := &fakeCondorStore{
		condor: &models.DBHarvestCondor{
			CondorID:          "c1",
			Underlying:        "SPY",
			Status:            "OPEN",
			Contracts:         1,
			CreditPerContract: 1.0,
			ShortPutSymbol:    "x", LongPutSymbol: "y",
			ShortCallSymbol: "z", LongCallSymbol: "w",
		},
	}
	placeFn := PlaceMultiLegOrderFn(func(_ context.Context, _ MultiLegOrder) (string, error) {
		return "ord", nil
	})
	closer := NewHarvestCloser(store, placeFn)
	closer.nowFn = func() time.Time { return fixed }

	_, err := closer.CloseCondor(context.Background(), CloseCondorRequest{
		CondorID: "c1", OrderType: "limit", LimitPrice: 0.5,
		CostPerContract: 0.5, CloseReason: "profit_target",
		FinalizeImmediately: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	got, ok := store.lastUpdates["closed_at"].(*time.Time)
	if !ok || got == nil {
		t.Fatalf("expected closed_at to be *time.Time, got %T (%v)", store.lastUpdates["closed_at"], store.lastUpdates["closed_at"])
	}
	if !got.Equal(fixed) {
		t.Errorf("expected closed_at == %v, got %v", fixed, *got)
	}
}
