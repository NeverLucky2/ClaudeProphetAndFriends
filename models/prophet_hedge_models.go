package models

import (
	"time"

	"gorm.io/gorm"
)

// DBProphetHedgeSpread is one defined-risk QQQ put-debit-spread opened by the
// defensive-Prophet hedge. Dedicated table (multi-leg doesn't fit the
// single-symbol managed_positions model — same reason Harvest uses its own
// condor table). Closed rows are retained for audit; the stored strikes +
// debit let the (deferred) grader recompute the synthetic stress-payoff from
// QQQ history without a separate daily series.
type DBProphetHedgeSpread struct {
	gorm.Model
	SpreadID   string    `gorm:"uniqueIndex"`
	Underlying string    `gorm:"index"` // "QQQ"
	Expiration time.Time

	LongPutSymbol  string
	LongPutStrike  float64
	ShortPutSymbol string
	ShortPutStrike float64

	Contracts             int
	NetDebitPerContract   float64 // per-share net debit (long mid − short mid)
	TotalDebit            float64 // NetDebitPerContract * 100 * Contracts (max loss)
	MaxPayoff             float64 // ((longK − shortK) − netDebit) * 100 * Contracts
	RegimeScoreAtEntry    int
	PortfolioValueAtEntry float64

	EntryOrderID string
	CloseOrderID string `gorm:"column:close_order_id"`

	// Status: pending_fill | open | closing | closed | failed
	Status      string `gorm:"index"`
	CloseReason string  // harvest | roll | expire | itm_short | reconciled
	RealizedPnL float64 `gorm:"column:realized_pnl"`
	OpenedAt    time.Time
	ClosedAt    *time.Time
}

// DBProphetHedgeSession is the singleton per-day run state, mirroring
// DBTurtleSession. Queried by hardcoded SessionID = "singleton".
type DBProphetHedgeSession struct {
	gorm.Model
	SessionID         string `gorm:"uniqueIndex"`
	LastHeartbeatDate string // ISO date (YYYY-MM-DD); "" on first run
}

func (DBProphetHedgeSpread) TableName() string  { return "prophet_hedge_spreads" }
func (DBProphetHedgeSession) TableName() string { return "prophet_hedge_session" }
