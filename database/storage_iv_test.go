package database

import (
	"testing"
	"time"

	"prophet-trader/models"
)

func setupHarvestTestDB(t *testing.T) *LocalStorage {
	t.Helper()
	s, err := NewLocalStorage(":memory:")
	if err != nil {
		t.Fatalf("failed to create test DB: %v", err)
	}
	return s
}

func TestSaveAndGetHarvestIVSnapshot(t *testing.T) {
	s := setupHarvestTestDB(t)
	today := time.Now().Truncate(24 * time.Hour)
	snap := &models.DBIVSnapshot{
		Underlying: "SPY",
		Date:       today,
		ATMIV:      0.185,
	}
	if err := s.SaveHarvestIVSnapshot(snap); err != nil {
		t.Fatalf("SaveHarvestIVSnapshot failed: %v", err)
	}
	snaps, err := s.GetHarvestIVSnapshots("SPY", today.AddDate(0, 0, -1), today.Add(time.Hour))
	if err != nil {
		t.Fatalf("GetHarvestIVSnapshots failed: %v", err)
	}
	if len(snaps) != 1 || snaps[0].ATMIV != 0.185 {
		t.Errorf("unexpected snapshots: %+v", snaps)
	}
}
