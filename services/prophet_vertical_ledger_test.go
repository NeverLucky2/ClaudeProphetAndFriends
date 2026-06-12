package services

import (
	"fmt"
	"testing"

	"prophet-trader/models"
)

// fakeVerticalStore is the in-memory verticalLedgerStore used across the
// Phase-2 executor tests (mirrors newFakeHedgeStore).
type fakeVerticalStore struct {
	spreads map[string]*models.DBProphetVerticalSpread
	nextID  uint
}

func newFakeVerticalStore() *fakeVerticalStore {
	return &fakeVerticalStore{spreads: map[string]*models.DBProphetVerticalSpread{}}
}

func (f *fakeVerticalStore) SaveProphetVerticalSpread(e *models.DBProphetVerticalSpread) error {
	if e.ID == 0 {
		f.nextID++
		e.ID = f.nextID
	}
	f.spreads[e.VerticalID] = e
	return nil
}

func (f *fakeVerticalStore) ListOpenProphetVerticalSpreads() ([]*models.DBProphetVerticalSpread, error) {
	var out []*models.DBProphetVerticalSpread
	for _, sp := range f.spreads {
		if sp.Status == "pending_fill" || sp.Status == "open" || sp.Status == "closing" {
			out = append(out, sp)
		}
	}
	return out, nil
}

func (f *fakeVerticalStore) GetProphetVerticalSpreadByID(id uint) (*models.DBProphetVerticalSpread, error) {
	for _, sp := range f.spreads {
		if sp.ID == id {
			return sp, nil
		}
	}
	return nil, fmt.Errorf("not found: %d", id)
}

func TestVerticalLedger_RoundTrip(t *testing.T) {
	led := NewProphetVerticalLedger(newFakeVerticalStore())
	sp := &models.DBProphetVerticalSpread{VerticalID: "v1", Status: "pending_fill"}
	if err := led.Save(sp); err != nil {
		t.Fatalf("save: %v", err)
	}
	open, err := led.ListOpen()
	if err != nil || len(open) != 1 || open[0].VerticalID != "v1" {
		t.Fatalf("listopen: %v / %d rows", err, len(open))
	}
	sp.Status = "closed"
	_ = led.Save(sp)
	open, _ = led.ListOpen()
	if len(open) != 0 {
		t.Fatalf("closed row must not be live, got %d", len(open))
	}
}

func TestVerticalExitConfigFromConstants(t *testing.T) {
	cfg := verticalExitConfig()
	if cfg.ForceDTE != verticalForceDTE || cfg.SalvageFloorFrac != verticalSalvageFloorFrac {
		t.Fatalf("exit config must reflect the constants: %+v", cfg)
	}
}
