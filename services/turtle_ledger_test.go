package services

import (
	"testing"

	"prophet-trader/database"
	"prophet-trader/models"
)

func newInMemTurtleStore(t *testing.T) *database.LocalStorage {
	t.Helper()
	s, err := database.NewLocalStorage(":memory:")
	if err != nil {
		t.Fatalf("create test DB: %v", err)
	}
	return s
}

func TestTurtleLedger_FirstRunReturnsNilSentinel(t *testing.T) {
	store := newInMemTurtleStore(t)
	ledger := NewTurtleLedger(store)

	sess, err := ledger.Session()
	if err != nil {
		t.Fatalf("Session() on fresh DB returned error: %v", err)
	}
	if sess != nil {
		t.Fatalf("Session() on fresh DB expected nil sentinel, got %+v", sess)
	}
}

func TestTurtleLedger_SaveAndReloadSession(t *testing.T) {
	store := newInMemTurtleStore(t)
	ledger := NewTurtleLedger(store)

	// Caller leaves SessionID empty; SaveSession should normalize to "singleton".
	in := &models.DBTurtleSession{
		LastHeartbeatDate:  "2026-05-15",
		ColdStartCompleted: true,
	}
	if err := ledger.SaveSession(in); err != nil {
		t.Fatalf("SaveSession: %v", err)
	}

	got, err := ledger.Session()
	if err != nil {
		t.Fatalf("Session: %v", err)
	}
	if got == nil {
		t.Fatal("Session returned nil after save")
	}
	if got.SessionID != "singleton" {
		t.Errorf("SessionID: got %q, want \"singleton\"", got.SessionID)
	}
	if got.LastHeartbeatDate != "2026-05-15" {
		t.Errorf("LastHeartbeatDate: got %q, want \"2026-05-15\"", got.LastHeartbeatDate)
	}
	if !got.ColdStartCompleted {
		t.Errorf("ColdStartCompleted: got false, want true")
	}
}

func TestTurtleLedger_SessionUpsert(t *testing.T) {
	store := newInMemTurtleStore(t)
	ledger := NewTurtleLedger(store)

	// First save.
	first := &models.DBTurtleSession{
		SessionID:         "singleton",
		LastHeartbeatDate: "2026-05-15",
	}
	if err := ledger.SaveSession(first); err != nil {
		t.Fatalf("first SaveSession: %v", err)
	}

	// Reload, mutate, save again — emulates the executor flipping fields on the
	// same singleton row across heartbeats.
	loaded, err := ledger.Session()
	if err != nil {
		t.Fatalf("Session after first save: %v", err)
	}
	if loaded == nil {
		t.Fatal("Session returned nil after first save")
	}
	loaded.LastHeartbeatDate = "2026-05-16"
	if err := ledger.SaveSession(loaded); err != nil {
		t.Fatalf("second SaveSession: %v", err)
	}

	// Reload again — the singleton must reflect the latest value, not stack a
	// second row.
	got, err := ledger.Session()
	if err != nil {
		t.Fatalf("Session after second save: %v", err)
	}
	if got == nil {
		t.Fatal("Session returned nil after second save")
	}
	if got.LastHeartbeatDate != "2026-05-16" {
		t.Errorf("LastHeartbeatDate: got %q, want \"2026-05-16\"", got.LastHeartbeatDate)
	}

	// Confirm uniqueness: only one row exists for SessionID="singleton".
	// We do this by reloading and asserting the ID is still the same as the
	// first persisted row (upsert in place, not insert-new).
	if got.ID != loaded.ID {
		t.Errorf("singleton row ID changed across saves: first=%d second=%d (expected upsert in place)", loaded.ID, got.ID)
	}
}

func TestTurtleLedger_CreateListUpdate(t *testing.T) {
	store := newInMemTurtleStore(t)
	ledger := NewTurtleLedger(store)

	entry := &models.DBTrendLedgerEntry{
		Ticker:      "TLT",
		EntryPrice:  90.0,
		Shares:      100,
		ATRAtEntry:  1.25,
		InitialStop: 87.5,
		Strategy:    "trend",
		Status:      "pending_fill",
	}
	if err := ledger.Save(entry); err != nil {
		t.Fatalf("Save: %v", err)
	}

	open, err := ledger.ListOpen()
	if err != nil {
		t.Fatalf("ListOpen: %v", err)
	}
	if len(open) != 1 {
		t.Fatalf("ListOpen: got %d rows, want 1", len(open))
	}
	if open[0].Ticker != "TLT" || open[0].Status != "pending_fill" {
		t.Errorf("ListOpen row: ticker=%q status=%q, want TLT/pending_fill", open[0].Ticker, open[0].Status)
	}

	// Flip status + entry price; save again.
	open[0].Status = "open"
	open[0].EntryPrice = 90.42
	if err := ledger.Save(open[0]); err != nil {
		t.Fatalf("Save (update): %v", err)
	}

	reloaded, err := ledger.ListOpen()
	if err != nil {
		t.Fatalf("ListOpen (after update): %v", err)
	}
	if len(reloaded) != 1 {
		t.Fatalf("ListOpen after update: got %d rows, want 1", len(reloaded))
	}
	if reloaded[0].Status != "open" {
		t.Errorf("Status after update: got %q, want \"open\"", reloaded[0].Status)
	}
	if reloaded[0].EntryPrice != 90.42 {
		t.Errorf("EntryPrice after update: got %v, want 90.42", reloaded[0].EntryPrice)
	}
}

func TestTurtleLedger_ClosedRowsExcludedFromListOpen(t *testing.T) {
	store := newInMemTurtleStore(t)
	ledger := NewTurtleLedger(store)

	openEntry := &models.DBTrendLedgerEntry{
		Ticker:   "GLD",
		Strategy: "trend",
		Status:   "open",
	}
	closedEntry := &models.DBTrendLedgerEntry{
		Ticker:     "USO",
		Strategy:   "trend",
		Status:     "closed",
		ExitReason: "trailing_stop",
	}
	if err := ledger.Save(openEntry); err != nil {
		t.Fatalf("Save openEntry: %v", err)
	}
	if err := ledger.Save(closedEntry); err != nil {
		t.Fatalf("Save closedEntry: %v", err)
	}

	open, err := ledger.ListOpen()
	if err != nil {
		t.Fatalf("ListOpen: %v", err)
	}
	if len(open) != 1 {
		t.Fatalf("ListOpen: got %d rows, want 1 (only the open row)", len(open))
	}
	if open[0].Ticker != "GLD" {
		t.Errorf("ListOpen returned wrong row: ticker=%q, want GLD", open[0].Ticker)
	}
}

func TestTurtleLedger_GetByID(t *testing.T) {
	store := newInMemTurtleStore(t)
	ledger := NewTurtleLedger(store)

	entry := &models.DBTrendLedgerEntry{
		Ticker:   "DBC",
		Strategy: "trend",
		Status:   "open",
	}
	if err := ledger.Save(entry); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if entry.ID == 0 {
		t.Fatal("Save did not populate gorm.Model.ID")
	}

	got, err := ledger.GetByID(entry.ID)
	if err != nil {
		t.Fatalf("GetByID(%d): %v", entry.ID, err)
	}
	if got == nil {
		t.Fatal("GetByID returned nil entry")
	}
	if got.Ticker != "DBC" {
		t.Errorf("GetByID ticker: got %q, want \"DBC\"", got.Ticker)
	}
}
