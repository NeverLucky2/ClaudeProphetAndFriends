package services

import (
	"testing"

	"prophet-trader/models"
)

type fakeHedgeStore struct {
	spreads map[string]*models.DBProphetHedgeSpread
	session *models.DBProphetHedgeSession
}

func newFakeHedgeStore() *fakeHedgeStore {
	return &fakeHedgeStore{spreads: map[string]*models.DBProphetHedgeSpread{}}
}
func (f *fakeHedgeStore) SaveProphetHedgeSpread(e *models.DBProphetHedgeSpread) error {
	f.spreads[e.SpreadID] = e
	return nil
}
func (f *fakeHedgeStore) ListOpenProphetHedgeSpreads() ([]*models.DBProphetHedgeSpread, error) {
	var out []*models.DBProphetHedgeSpread
	for _, s := range f.spreads {
		if s.Status == "pending_fill" || s.Status == "open" || s.Status == "closing" {
			out = append(out, s)
		}
	}
	return out, nil
}
func (f *fakeHedgeStore) GetProphetHedgeSpreadByID(id uint) (*models.DBProphetHedgeSpread, error) {
	return nil, nil
}
func (f *fakeHedgeStore) GetProphetHedgeSession() (*models.DBProphetHedgeSession, error) {
	return f.session, nil
}
func (f *fakeHedgeStore) SaveProphetHedgeSession(s *models.DBProphetHedgeSession) error {
	f.session = s
	return nil
}

func TestHedgeLedger_SessionRoundTrip(t *testing.T) {
	l := NewProphetHedgeLedger(newFakeHedgeStore())
	got, err := l.Session()
	if err != nil || got != nil {
		t.Fatalf("first-run session should be (nil,nil), got (%v,%v)", got, err)
	}
	if err := l.SaveSession(&models.DBProphetHedgeSession{LastHeartbeatDate: "2026-06-01"}); err != nil {
		t.Fatalf("save: %v", err)
	}
	got, _ = l.Session()
	if got == nil || got.LastHeartbeatDate != "2026-06-01" {
		t.Fatalf("session not persisted")
	}
}
