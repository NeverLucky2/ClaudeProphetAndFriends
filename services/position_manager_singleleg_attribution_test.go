package services

import (
	"context"
	"testing"
	"time"
)

func TestManagedPosition_SingleLegAttribution_RoundTrip(t *testing.T) {
	// managedPositionToDB and dbToManagedPosition use only their argument (no pm
	// fields), so a zero-value PositionManager is sufficient.
	pm := &PositionManager{}
	pos := &ManagedPosition{
		ID:                   "p1",
		Symbol:               "QQQ260918C00400000",
		AgentStrategy:        "v2-options",
		EntryUnderlyingSpot:  405.0,
		EntryIV:              0.22,
		EntryTimeToExpiry:    0.24,
		SingleLegRealizedPnL: -120.0,
		AttribDirection:      50.0,
		AttribTheta:          -90.0,
		AttribIV:             -70.0,
		AttribResidual:       -10.0,
	}
	db := pm.managedPositionToDB(pos)
	if db.EntryUnderlyingSpot != 405.0 || db.EntryIV != 0.22 || db.EntryTimeToExpiry != 0.24 {
		t.Fatalf("entry snapshot not mapped to DB: %+v", db)
	}
	if db.SingleLegRealizedPnL != -120.0 || db.AttribDirection != 50.0 || db.AttribTheta != -90.0 || db.AttribIV != -70.0 || db.AttribResidual != -10.0 {
		t.Fatalf("attribution not mapped to DB: %+v", db)
	}
	back := pm.dbToManagedPosition(db)
	if back.EntryUnderlyingSpot != 405.0 || back.EntryIV != 0.22 || back.EntryTimeToExpiry != 0.24 ||
		back.SingleLegRealizedPnL != -120.0 || back.AttribDirection != 50.0 || back.AttribTheta != -90.0 ||
		back.AttribIV != -70.0 || back.AttribResidual != -10.0 {
		t.Fatalf("round-trip lost fields: %+v", back)
	}
}

func TestCaptureSingleLegEntry_GatingNoOps(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 6, 22, 15, 0, 0, 0, time.UTC)

	// Flag OFF → no-op even for a v2-options option (nil services must not panic).
	off := &PositionManager{}
	posOff := &ManagedPosition{Symbol: "QQQ260918C00400000", AgentStrategy: "v2-options"}
	off.captureSingleLegEntrySnapshot(ctx, posOff, now)
	if posOff.EntryIV != 0 || posOff.EntryUnderlyingSpot != 0 {
		t.Fatal("flag off must capture nothing")
	}

	// Flag ON but equity (non-option) → no-op.
	on := &PositionManager{}
	on.EnableSingleLegAttribution(true)
	posEq := &ManagedPosition{Symbol: "QQQ", AgentStrategy: "trend"}
	on.captureSingleLegEntrySnapshot(ctx, posEq, now)
	if posEq.EntryIV != 0 {
		t.Fatal("non-option must capture nothing")
	}
}

func TestAttributeSingleLegClose_SkipsOnIncompleteEntry(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 6, 22, 15, 0, 0, 0, time.UTC)
	pm := &PositionManager{}
	pm.EnableSingleLegAttribution(true)
	// v2-options option but entry snapshot never captured (zeros) → skip, no panic
	// (must return before touching the nil services).
	pos := &ManagedPosition{Symbol: "QQQ260918C00400000", AgentStrategy: "v2-options", Side: "buy", Quantity: 1, EntryPrice: 12.0}
	pm.attributeSingleLegClose(ctx, pos, now)
	if pos.AttribDirection != 0 || pos.SingleLegRealizedPnL != 0 {
		t.Fatal("incomplete entry snapshot must skip attribution")
	}
}
