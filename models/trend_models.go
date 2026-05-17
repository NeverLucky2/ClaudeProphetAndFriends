package models

import (
	"time"

	"gorm.io/gorm"
)

// DBTrendLedgerEntry mirrors the per-position metadata in TRADING_RULES_TREND.md
// "Persisted Ledger" section. One row per Turtle position; closed rows are
// retained for audit (Status flips to closed instead of being deleted).
type DBTrendLedgerEntry struct {
	gorm.Model
	Ticker                 string `gorm:"index"`
	EntryDate              time.Time
	EntryPrice             float64
	Shares                 int
	ATRAtEntry             float64
	InitialStop            float64
	Donchian100HighAtEntry float64
	Strategy               string // always "trend"
	Status                 string `gorm:"index"` // pending_fill | open | closed
	EntryOrderID           string
	ExitOrderID            string
	ExitDate               *time.Time
	ExitPrice              float64
	ExitReason             string // trailing_stop | initial_hard_stop | missed_entry | reconciliation
}

// DBTurtleSession tracks per-day run state: last_heartbeat_date,
// cold_start_completed, circuit_breaker_tripped. One row total; queried by
// hardcoded SessionID = "singleton".
type DBTurtleSession struct {
	gorm.Model
	SessionID                 string `gorm:"uniqueIndex"`
	LastHeartbeatDate         string // ISO date (YYYY-MM-DD) — "" on first ever run
	ColdStartCompleted        bool
	CircuitBreakerTrippedDate string // ISO date; empty when not tripped
}

func (DBTrendLedgerEntry) TableName() string { return "trend_ledger_entries" }
func (DBTurtleSession) TableName() string    { return "turtle_session" }
