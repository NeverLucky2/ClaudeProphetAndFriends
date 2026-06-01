package services

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"prophet-trader/interfaces"
)

func brokerPos(sym string, qty float64) *interfaces.Position {
	return &interfaces.Position{Symbol: sym, Qty: qty, Side: "long"}
}

// Broker holds a symbol whose only managed record is terminal -> orphan.
func TestFindOrphans_TerminalRecordBrokerHolds_Flagged(t *testing.T) {
	managed := []*ManagedPosition{{ID: "pos_unh", Symbol: "UNH", Status: "CLOSED", RemainingQty: 13}}
	broker := []*interfaces.Position{brokerPos("UNH", 13)}
	got := findOrphans(broker, managed)
	if len(got) != 1 {
		t.Fatalf("got %d orphans, want 1: %+v", len(got), got)
	}
	if got[0].Symbol != "UNH" || got[0].BrokerQty != 13 || got[0].PositionID != "pos_unh" || got[0].LedgerStatus != "CLOSED" {
		t.Errorf("orphan = %+v, want UNH/13/pos_unh/CLOSED", got[0])
	}
}

// A held symbol with NO managed record belongs to another agent on the shared
// account and must never be flagged.
func TestFindOrphans_NoRecord_NotFlagged(t *testing.T) {
	managed := []*ManagedPosition{{ID: "pos_unh", Symbol: "UNH", Status: "CLOSED"}}
	broker := []*interfaces.Position{brokerPos("AAPL", 100)}
	if got := findOrphans(broker, managed); len(got) != 0 {
		t.Fatalf("got %+v, want none (AAPL has no record for this agent)", got)
	}
}

// A live (ACTIVE) record is a normal position, not an orphan.
func TestFindOrphans_ActiveRecord_NotFlagged(t *testing.T) {
	managed := []*ManagedPosition{{ID: "pos_wmt", Symbol: "WMT", Status: "ACTIVE", RemainingQty: 42}}
	broker := []*interfaces.Position{brokerPos("WMT", 42)}
	if got := findOrphans(broker, managed); len(got) != 0 {
		t.Fatalf("got %+v, want none (WMT is ACTIVE)", got)
	}
}

// Re-entered after a prior close: a terminal AND a live record for the same
// symbol -> the live record wins, not an orphan.
func TestFindOrphans_TerminalAndActiveCoexist_NotFlagged(t *testing.T) {
	managed := []*ManagedPosition{
		{ID: "pos_old", Symbol: "DE", Status: "CLOSED"},
		{ID: "pos_new", Symbol: "DE", Status: "ACTIVE", RemainingQty: 9},
	}
	broker := []*interfaces.Position{brokerPos("DE", 9)}
	if got := findOrphans(broker, managed); len(got) != 0 {
		t.Fatalf("got %+v, want none (DE has a live record)", got)
	}
}

// Terminal record but the broker is flat -> correctly closed, not an orphan.
func TestFindOrphans_TerminalButBrokerFlat_NotFlagged(t *testing.T) {
	managed := []*ManagedPosition{{ID: "pos_unh", Symbol: "UNH", Status: "CLOSED"}}
	broker := []*interfaces.Position{}
	if got := findOrphans(broker, managed); len(got) != 0 {
		t.Fatalf("got %+v, want none (broker is flat)", got)
	}
}

// A PENDING record (entry not yet filled) is non-terminal -> not an orphan.
func TestFindOrphans_PendingRecord_NotFlagged(t *testing.T) {
	managed := []*ManagedPosition{{ID: "pos_pend", Symbol: "MO", Status: "PENDING", RemainingQty: 70}}
	broker := []*interfaces.Position{brokerPos("MO", 70)}
	if got := findOrphans(broker, managed); len(got) != 0 {
		t.Fatalf("got %+v, want none (MO is PENDING)", got)
	}
}

// Across repeated reconcile passes the same orphan is recorded once and no order
// is ever placed; the report file lists it.
func TestDetectOrphans_AlertsOnceAndReports(t *testing.T) {
	dir := t.TempDir()
	trading := &reconcileStubTrading{stubTrading: &stubTrading{}, positions: []*interfaces.Position{{Symbol: "UNH", Qty: 13, Side: "long"}}}
	pm := newReconcilePM(t, trading)
	pm.SetOrphanReporter(NewOrphanReporter(dir))
	injectPosition(pm, &ManagedPosition{ID: "pos_unh", Symbol: "UNH", Status: "CLOSED", RemainingQty: 13})

	if _, err := pm.reconcileWithBroker(context.Background()); err != nil {
		t.Fatalf("pass 1: %v", err)
	}
	if _, err := pm.reconcileWithBroker(context.Background()); err != nil {
		t.Fatalf("pass 2: %v", err)
	}

	if !pm.orphanAlerted["UNH"] {
		t.Error("UNH should be in the alerted set")
	}
	if trading.placeCalls != 0 {
		t.Errorf("placeCalls = %d, want 0 (detection must place no orders)", trading.placeCalls)
	}
	data, err := os.ReadFile(filepath.Join(dir, "orphans.json"))
	if err != nil {
		t.Fatalf("read report: %v", err)
	}
	var got []OrphanAlert
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(got) != 1 || got[0].Symbol != "UNH" {
		t.Fatalf("report = %+v, want one UNH orphan", got)
	}
}

// When the broker no longer holds the symbol the orphan resolves: it leaves the
// alerted set and the report file empties.
func TestDetectOrphans_ResolvesWhenBrokerDropsSymbol(t *testing.T) {
	dir := t.TempDir()
	trading := &reconcileStubTrading{stubTrading: &stubTrading{}, positions: []*interfaces.Position{{Symbol: "UNH", Qty: 13, Side: "long"}}}
	pm := newReconcilePM(t, trading)
	pm.SetOrphanReporter(NewOrphanReporter(dir))
	injectPosition(pm, &ManagedPosition{ID: "pos_unh", Symbol: "UNH", Status: "CLOSED", RemainingQty: 13})

	if _, err := pm.reconcileWithBroker(context.Background()); err != nil {
		t.Fatalf("pass 1: %v", err)
	}
	if !pm.orphanAlerted["UNH"] {
		t.Fatal("UNH should be alerted after pass 1")
	}

	trading.positions = []*interfaces.Position{} // operator flattened UNH
	if _, err := pm.reconcileWithBroker(context.Background()); err != nil {
		t.Fatalf("pass 2: %v", err)
	}
	if pm.orphanAlerted["UNH"] {
		t.Error("UNH should be cleared from the alerted set after resolution")
	}
	data, err := os.ReadFile(filepath.Join(dir, "orphans.json"))
	if err != nil {
		t.Fatalf("read report: %v", err)
	}
	var got []OrphanAlert
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("report = %+v, want empty after resolution", got)
	}
}
