package models

import (
	"time"

	"gorm.io/gorm"
)

// DBProphetVerticalSpread is one LLM-initiated, defined-risk debit vertical
// (call-debit bullish / put-debit bearish). Dedicated table for the same
// reason as DBProphetHedgeSpread: multi-leg doesn't fit the single-symbol
// managed_positions model. Closed rows are retained for the teaching ledger;
// the entry-snapshot + attribution fields make the "right on direction and
// still lost" decomposition durable. No session row: the manage tick is
// idempotent and intraday, so there is no once-daily state to dedupe.
type DBProphetVerticalSpread struct {
	gorm.Model
	VerticalID string `gorm:"uniqueIndex"`
	Underlying string `gorm:"index"`
	Direction  string // "call_debit" | "put_debit" (services.VerticalDirection)
	Expiration time.Time

	LongSymbol  string
	LongStrike  float64
	ShortSymbol string
	ShortStrike float64

	Contracts           int
	NetDebitPerContract float64 // per-share net debit (quoted at place; updated to fill)
	TotalDebit          float64 // NetDebitPerContract * 100 * Contracts (= max loss)
	MaxGain             float64 // (width − net debit) * 100 * Contracts
	Breakeven           float64

	// Entry snapshot, captured at fill-DETECTION (first manage tick that sees
	// the fill; ≤ one tick of drift, absorbed by AttribResidual). Inputs to
	// attributeVerticalPnl. Zero values = degraded feed at capture time.
	EntrySpot         float64
	EntryLongVol      float64
	EntryShortVol     float64
	EntryTimeToExpiry float64 // years

	EntryOrderID string
	CloseOrderID string `gorm:"column:close_order_id"`

	// Status: pending_fill | open | closing | closed | failed
	Status         string `gorm:"index"`
	CloseRequested bool   // set by RequestClose (LLM); manage tick acts on it
	CloseReason    string // llm_requested | salvage_stop | profit_capture | force_close | reconciled
	RealizedPnL    float64 `gorm:"column:realized_pnl"`

	// Black-Scholes reprice-walk decomposition of RealizedPnL (teaching output).
	AttribDirection float64
	AttribTheta     float64
	AttribIV        float64
	AttribResidual  float64

	OpenedAt time.Time
	ClosedAt *time.Time
}

func (DBProphetVerticalSpread) TableName() string { return "prophet_vertical_spreads" }
