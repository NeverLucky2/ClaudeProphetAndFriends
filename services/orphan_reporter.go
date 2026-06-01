package services

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"
)

// OrphanAlert describes a broker position whose managed record this agent has
// marked terminal (CLOSED/STOPPED_OUT/FAILED) while the broker still holds the
// shares — a close that never actually flattened the broker side.
type OrphanAlert struct {
	Symbol       string     `json:"symbol"`
	BrokerQty    float64    `json:"broker_qty"`
	PositionID   string     `json:"position_id"`
	LedgerStatus string     `json:"ledger_status"`
	ClosedAt     *time.Time `json:"closed_at,omitempty"`
	DetectedAt   time.Time  `json:"detected_at"`
}

// OrphanReporter persists the current orphan set to <dir>/orphans.json so the
// operator can see it (the Go bot's console logs are not reliably retained). It
// is report-only and never trades.
type OrphanReporter struct {
	dir string
}

func NewOrphanReporter(dir string) *OrphanReporter {
	return &OrphanReporter{dir: dir}
}

// Report overwrites <dir>/orphans.json with the given orphan set. A nil/empty
// set writes an empty JSON array so a resolved orphan clears the file. The
// directory is created if missing.
func (r *OrphanReporter) Report(orphans []OrphanAlert) error {
	if err := os.MkdirAll(r.dir, 0o755); err != nil {
		return err
	}
	if orphans == nil {
		orphans = []OrphanAlert{}
	}
	data, err := json.MarshalIndent(orphans, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(r.dir, "orphans.json"), data, 0o644)
}
