package services

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestOrphanReporter_WritesJSON(t *testing.T) {
	dir := t.TempDir()
	r := NewOrphanReporter(dir)
	orphans := []OrphanAlert{{Symbol: "UNH", BrokerQty: 13, PositionID: "pos_unh", LedgerStatus: "CLOSED"}}
	if err := r.Report(orphans); err != nil {
		t.Fatalf("Report: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(dir, "orphans.json"))
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var got []OrphanAlert
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(got) != 1 || got[0].Symbol != "UNH" || got[0].BrokerQty != 13 || got[0].LedgerStatus != "CLOSED" {
		t.Errorf("got %+v, want one UNH/13/CLOSED orphan", got)
	}
}

func TestOrphanReporter_EmptySetClearsFile(t *testing.T) {
	dir := t.TempDir()
	r := NewOrphanReporter(dir)
	if err := r.Report(nil); err != nil {
		t.Fatalf("Report: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(dir, "orphans.json"))
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if strings.TrimSpace(string(data)) != "[]" {
		t.Errorf("got %q, want []", string(data))
	}
}
