package services

import (
	"prophet-trader/models"
)

// ledgerStore is the storage subset TurtleLedger depends on. Implemented by
// *database.LocalStorage; tests substitute an in-memory fake.
type ledgerStore interface {
	SaveTrendLedgerEntry(e *models.DBTrendLedgerEntry) error
	ListOpenTrendLedgerEntries() ([]*models.DBTrendLedgerEntry, error)
	GetTrendLedgerEntryByID(id uint) (*models.DBTrendLedgerEntry, error)
	GetTurtleSession() (*models.DBTurtleSession, error)
	SaveTurtleSession(s *models.DBTurtleSession) error
}

// TurtleLedger is a thin façade over the ledger storage methods. It owns no
// state — CRUD only, no caching — so concurrent heartbeats see the same view.
type TurtleLedger struct {
	store ledgerStore
}

func NewTurtleLedger(store ledgerStore) *TurtleLedger {
	return &TurtleLedger{store: store}
}

func (l *TurtleLedger) Save(e *models.DBTrendLedgerEntry) error {
	return l.store.SaveTrendLedgerEntry(e)
}

func (l *TurtleLedger) ListOpen() ([]*models.DBTrendLedgerEntry, error) {
	return l.store.ListOpenTrendLedgerEntries()
}

func (l *TurtleLedger) GetByID(id uint) (*models.DBTrendLedgerEntry, error) {
	return l.store.GetTrendLedgerEntryByID(id)
}

// Session returns the singleton session row, or (nil, nil) if no row exists yet.
// Callers detect first-run via the nil return and create + save a fresh row.
func (l *TurtleLedger) Session() (*models.DBTurtleSession, error) {
	return l.store.GetTurtleSession()
}

func (l *TurtleLedger) SaveSession(s *models.DBTurtleSession) error {
	return l.store.SaveTurtleSession(s)
}
