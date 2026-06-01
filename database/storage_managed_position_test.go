package database

import (
	"testing"

	"prophet-trader/models"
)

// TestManagedPosition_AgentStrategyRoundTrip verifies that the trade-style
// Strategy field and the agent-attribution AgentStrategy field are stored
// independently. This pins the namespace separation introduced when multi-agent
// attribution was added.
func TestManagedPosition_AgentStrategyRoundTrip(t *testing.T) {
	s := setupHarvestTestDB(t)

	pos := &models.DBManagedPosition{
		PositionID:    "mp-test-1",
		Symbol:        "NVDA",
		Side:          "buy",
		Strategy:      "DAY_TRADE",
		AgentStrategy: "trend",
		Quantity:      10,
		EntryPrice:    100.0,
		Status:        "ACTIVE",
	}
	if err := s.SaveManagedPosition(pos); err != nil {
		t.Fatalf("SaveManagedPosition: %v", err)
	}

	got, err := s.GetManagedPosition("mp-test-1")
	if err != nil {
		t.Fatalf("GetManagedPosition: %v", err)
	}
	if got.Strategy != "DAY_TRADE" {
		t.Errorf("Strategy = %q, want DAY_TRADE", got.Strategy)
	}
	if got.AgentStrategy != "trend" {
		t.Errorf("AgentStrategy = %q, want trend", got.AgentStrategy)
	}
}

// TestManagedPosition_UpsertOnPositionID pins the upsert contract introduced
// after the 2026-05-18 Spark incident. PositionManager.managedPositionToDB
// builds a fresh DBManagedPosition struct on every save (no gorm primary key),
// so the second-and-later saves used to fail the uniqueIndex on PositionID
// with a constraint error. PlaceManagedPosition's first save (status=PENDING)
// landed; checkEntryOrder's follow-up save (status=ACTIVE after entry fill)
// silently dropped, and the row stayed PENDING in DB while the in-memory
// position was ACTIVE — producing the broker/DB drift that confused Spark's
// Beat Context reasoning. SaveManagedPosition must upsert by PositionID.
func TestManagedPosition_UpsertOnPositionID(t *testing.T) {
	s := setupHarvestTestDB(t)

	first := &models.DBManagedPosition{
		PositionID:    "pos_test_upsert",
		Symbol:        "LAND",
		Side:          "buy",
		Strategy:      "SWING_TRADE",

		Quantity:      216,
		EntryPrice:    9.49,
		StopLossPrice: 8.54,
		Status:        "PENDING",
	}
	if err := s.SaveManagedPosition(first); err != nil {
		t.Fatalf("initial SaveManagedPosition: %v", err)
	}

	// Simulate checkEntryOrder transitioning the position from PENDING to
	// ACTIVE after an entry fill. Pre-fix this is the save that silently
	// failed.
	second := &models.DBManagedPosition{
		PositionID:      "pos_test_upsert",
		Symbol:          "LAND",
		Side:            "buy",
		Strategy:        "SWING_TRADE",

		Quantity:        216,
		EntryPrice:      9.49,
		StopLossPrice:   8.54,
		Status:          "ACTIVE",
		StopLossOrderID: "stop-broker-id",
	}
	if err := s.SaveManagedPosition(second); err != nil {
		t.Fatalf("update SaveManagedPosition: %v", err)
	}

	got, err := s.GetManagedPosition("pos_test_upsert")
	if err != nil {
		t.Fatalf("GetManagedPosition: %v", err)
	}
	if got.Status != "ACTIVE" {
		t.Errorf("Status = %q, want ACTIVE after second save (PENDING means upsert did not update)", got.Status)
	}
	if got.StopLossOrderID != "stop-broker-id" {
		t.Errorf("StopLossOrderID = %q, want stop-broker-id (later save fields lost)", got.StopLossOrderID)
	}

	// Verify there is exactly ONE row for this PositionID in the table, not
	// two duplicates from a botched INSERT-on-conflict path.
	var rows []*models.DBManagedPosition
	if err := s.db.Where("position_id = ?", "pos_test_upsert").Find(&rows).Error; err != nil {
		t.Fatalf("count rows: %v", err)
	}
	if len(rows) != 1 {
		t.Errorf("got %d rows for pos_test_upsert, want exactly 1 (duplicates indicate insert path)", len(rows))
	}
}

// TestManagedPosition_AgentStrategyEmpty verifies that legacy rows without an
// AgentStrategy still round-trip cleanly. Any reader must tolerate the empty
// case and fall back to DBOrder attribution (or treat the row as unattributable).
func TestManagedPosition_AgentStrategyEmpty(t *testing.T) {
	s := setupHarvestTestDB(t)

	pos := &models.DBManagedPosition{
		PositionID: "mp-test-legacy",
		Symbol:     "AAPL",
		Side:       "buy",
		Strategy:   "SWING_TRADE",
		// AgentStrategy intentionally empty (pre-migration row).
		Quantity:   5,
		EntryPrice: 200.0,
		Status:     "ACTIVE",
	}
	if err := s.SaveManagedPosition(pos); err != nil {
		t.Fatalf("SaveManagedPosition: %v", err)
	}

	got, err := s.GetManagedPosition("mp-test-legacy")
	if err != nil {
		t.Fatalf("GetManagedPosition: %v", err)
	}
	if got.Strategy != "SWING_TRADE" {
		t.Errorf("Strategy = %q, want SWING_TRADE", got.Strategy)
	}
	if got.AgentStrategy != "" {
		t.Errorf("AgentStrategy = %q, want empty", got.AgentStrategy)
	}
}
