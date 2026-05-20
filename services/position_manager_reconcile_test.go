package services

import (
	"context"
	"errors"
	"prophet-trader/database"
	"prophet-trader/interfaces"
	"testing"
)

// reconcileStubTrading scripts the broker's GetPositions response (and an
// optional error) and records how many orders were placed. A reconciliation
// close must NEVER place an order — the broker is already flat, so a sell
// would either reject or open a short. placeCalls is the guard for that.
type reconcileStubTrading struct {
	*stubTrading
	positions  []*interfaces.Position
	getPosErr  error
	placeCalls int
}

func (s *reconcileStubTrading) GetPositions(_ context.Context) ([]*interfaces.Position, error) {
	if s.getPosErr != nil {
		return nil, s.getPosErr
	}
	return s.positions, nil
}

func (s *reconcileStubTrading) PlaceOrder(_ context.Context, _ *interfaces.Order) (*interfaces.OrderResult, error) {
	s.placeCalls++
	return &interfaces.OrderResult{OrderID: "should-not-be-placed", Status: "accepted"}, nil
}

func newReconcilePM(t *testing.T, trading interfaces.TradingService) *PositionManager {
	t.Helper()
	storage, err := database.NewLocalStorage(":memory:")
	if err != nil {
		t.Fatalf("create storage: %v", err)
	}
	return NewPositionManager(trading, nil, storage)
}

func injectPosition(pm *PositionManager, pos *ManagedPosition) {
	if pos.ID == "" {
		pos.ID = pm.generatePositionID()
	}
	pm.mu.Lock()
	pm.positions[pos.ID] = pos
	pm.mu.Unlock()
}

// A phantom ACTIVE position (broker holds none) is closed WITHOUT placing an
// exit order — but only after the absence is confirmed on two consecutive
// passes, so a just-filled buy that hasn't propagated to GetPositions yet is
// not wrongly closed. This is the exact III-on-Spark failure: managed row
// stuck ACTIVE for 2+ days while the broker had been flat since the agent's
// own hard-stop sell.
func TestReconcile_PhantomActive_ClosedWithoutOrderAfterTwoPasses(t *testing.T) {
	trading := &reconcileStubTrading{stubTrading: &stubTrading{}, positions: []*interfaces.Position{}}
	pm := newReconcilePM(t, trading)

	pos := &ManagedPosition{Symbol: "III", Side: "buy", Status: "ACTIVE", Quantity: 490, RemainingQty: 490, AgentStrategy: "penny-momentum"}
	injectPosition(pm, pos)

	// Pass 1: absence seen once — not yet closed (could be propagation lag).
	if _, err := pm.reconcileWithBroker(context.Background()); err != nil {
		t.Fatalf("pass 1: %v", err)
	}
	if pos.Status != "ACTIVE" {
		t.Fatalf("after pass 1 status = %q, want ACTIVE (single absence must not close)", pos.Status)
	}

	// Pass 2: absence confirmed — close, no order.
	if _, err := pm.reconcileWithBroker(context.Background()); err != nil {
		t.Fatalf("pass 2: %v", err)
	}
	if pos.Status != "CLOSED" {
		t.Errorf("after pass 2 status = %q, want CLOSED", pos.Status)
	}
	if pos.ClosedAt == nil {
		t.Errorf("ClosedAt not set on reconciled-closed position")
	}
	if trading.placeCalls != 0 {
		t.Errorf("placeCalls = %d, want 0 (reconcile must not place an exit order)", trading.placeCalls)
	}

	// The CLOSED state must be persisted so a later reload doesn't resurrect it.
	saved, err := pm.storageService.GetManagedPosition(pos.ID)
	if err != nil {
		t.Fatalf("GetManagedPosition: %v", err)
	}
	if saved.Status != "CLOSED" {
		t.Errorf("persisted status = %q, want CLOSED", saved.Status)
	}
}

// A failed/transient broker read must never close a position — we only act on
// a confirmed-empty broker, never on an error.
func TestReconcile_BrokerReadError_NoChange(t *testing.T) {
	trading := &reconcileStubTrading{stubTrading: &stubTrading{}, getPosErr: errors.New("alpaca 503")}
	pm := newReconcilePM(t, trading)

	pos := &ManagedPosition{Symbol: "III", Side: "buy", Status: "ACTIVE", Quantity: 490, RemainingQty: 490}
	injectPosition(pm, pos)

	for i := 0; i < 3; i++ {
		if _, err := pm.reconcileWithBroker(context.Background()); err == nil {
			t.Fatalf("pass %d: expected error from broker read, got nil", i+1)
		}
	}
	if pos.Status != "ACTIVE" {
		t.Errorf("status = %q, want ACTIVE (broker-read error must not close)", pos.Status)
	}
	if trading.placeCalls != 0 {
		t.Errorf("placeCalls = %d, want 0", trading.placeCalls)
	}
}

// PENDING positions legitimately have no broker position yet (entry order not
// filled). Reconcile must skip them — they are handled by checkEntryOrder and
// the 24h stale filter, not by broker reconciliation.
func TestReconcile_PendingNotClosed(t *testing.T) {
	trading := &reconcileStubTrading{stubTrading: &stubTrading{}, positions: []*interfaces.Position{}}
	pm := newReconcilePM(t, trading)

	pos := &ManagedPosition{Symbol: "III", Side: "buy", Status: "PENDING", Quantity: 490, RemainingQty: 490}
	injectPosition(pm, pos)

	for i := 0; i < 3; i++ {
		if _, err := pm.reconcileWithBroker(context.Background()); err != nil {
			t.Fatalf("pass %d: %v", i+1, err)
		}
	}
	if pos.Status != "PENDING" {
		t.Errorf("status = %q, want PENDING (reconcile must not touch PENDING)", pos.Status)
	}
	if trading.placeCalls != 0 {
		t.Errorf("placeCalls = %d, want 0", trading.placeCalls)
	}
}

// When the broker actually holds the symbol, the position is left alone no
// matter how many passes run.
func TestReconcile_BrokerHoldsSymbol_NoChange(t *testing.T) {
	trading := &reconcileStubTrading{
		stubTrading: &stubTrading{},
		positions:   []*interfaces.Position{{Symbol: "III", Qty: 490, Side: "long"}},
	}
	pm := newReconcilePM(t, trading)

	pos := &ManagedPosition{Symbol: "III", Side: "buy", Status: "ACTIVE", Quantity: 490, RemainingQty: 490}
	injectPosition(pm, pos)

	for i := 0; i < 3; i++ {
		if _, err := pm.reconcileWithBroker(context.Background()); err != nil {
			t.Fatalf("pass %d: %v", i+1, err)
		}
	}
	if pos.Status != "ACTIVE" {
		t.Errorf("status = %q, want ACTIVE (broker holds it)", pos.Status)
	}
}

// A single absence followed by the symbol reappearing must reset the
// confirmation counter, so an absent → present → absent flicker can never
// accumulate to a false close across non-consecutive passes.
func TestReconcile_AbsenceResetsWhenSymbolReappears(t *testing.T) {
	flat := []*interfaces.Position{}
	held := []*interfaces.Position{{Symbol: "III", Qty: 490, Side: "long"}}
	trading := &reconcileStubTrading{stubTrading: &stubTrading{}, positions: flat}
	pm := newReconcilePM(t, trading)

	pos := &ManagedPosition{Symbol: "III", Side: "buy", Status: "ACTIVE", Quantity: 490, RemainingQty: 490}
	injectPosition(pm, pos)

	// miss #1
	pm.reconcileWithBroker(context.Background())
	// symbol reappears -> counter resets
	trading.positions = held
	pm.reconcileWithBroker(context.Background())
	// miss #1 again (not #2) -> must NOT close
	trading.positions = flat
	pm.reconcileWithBroker(context.Background())

	if pos.Status != "ACTIVE" {
		t.Errorf("status = %q, want ACTIVE (non-consecutive absences must not close)", pos.Status)
	}
	if trading.placeCalls != 0 {
		t.Errorf("placeCalls = %d, want 0", trading.placeCalls)
	}
}
