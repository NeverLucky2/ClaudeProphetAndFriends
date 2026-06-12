package database

import (
	"testing"
	"time"

	"prophet-trader/models"
)

func TestProphetVerticalSpread_SaveListOpenGet(t *testing.T) {
	s, err := NewLocalStorage(":memory:")
	if err != nil {
		t.Fatalf("storage: %v", err)
	}
	open := &models.DBProphetVerticalSpread{
		VerticalID: "v1", Underlying: "AMZN", Direction: "call_debit", Status: "open",
		LongSymbol: "AMZN260717C00240000", LongStrike: 240,
		ShortSymbol: "AMZN260717C00260000", ShortStrike: 260,
		Contracts: 1, Expiration: time.Now().Add(35 * 24 * time.Hour),
	}
	closing := &models.DBProphetVerticalSpread{VerticalID: "v2", Underlying: "CEG", Direction: "put_debit", Status: "closing"}
	closed := &models.DBProphetVerticalSpread{VerticalID: "v3", Underlying: "CEG", Direction: "put_debit", Status: "closed"}
	for _, sp := range []*models.DBProphetVerticalSpread{open, closing, closed} {
		if err := s.SaveProphetVerticalSpread(sp); err != nil {
			t.Fatalf("save %s: %v", sp.VerticalID, err)
		}
	}
	got, err := s.ListOpenProphetVerticalSpreads()
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 2 { // open + closing are live; closed is terminal
		t.Fatalf("want 2 live rows, got %d", len(got))
	}
	byID, err := s.GetProphetVerticalSpreadByID(open.ID)
	if err != nil || byID.VerticalID != "v1" {
		t.Fatalf("get by id: %v / %+v", err, byID)
	}
}
