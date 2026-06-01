package database

import (
	"testing"
	"time"

	"prophet-trader/models"
)

func TestProphetHedgeSpread_SaveAndListOpen(t *testing.T) {
	s, err := NewLocalStorage(":memory:")
	if err != nil {
		t.Fatalf("storage: %v", err)
	}
	open := &models.DBProphetHedgeSpread{
		SpreadID: "s1", Underlying: "QQQ", Status: "open",
		LongPutSymbol: "QQQ260101P00475000", ShortPutSymbol: "QQQ260101P00425000",
		Contracts: 1, Expiration: time.Now().Add(45 * 24 * time.Hour),
	}
	closed := &models.DBProphetHedgeSpread{SpreadID: "s2", Underlying: "QQQ", Status: "closed"}
	if err := s.SaveProphetHedgeSpread(open); err != nil {
		t.Fatalf("save open: %v", err)
	}
	if err := s.SaveProphetHedgeSpread(closed); err != nil {
		t.Fatalf("save closed: %v", err)
	}
	got, err := s.ListOpenProphetHedgeSpreads()
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 1 || got[0].SpreadID != "s1" {
		t.Fatalf("want only the open spread, got %d rows", len(got))
	}
}
