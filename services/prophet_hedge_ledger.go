package services

import "prophet-trader/models"

// hedgeLedgerStore is the storage subset the ledger needs. Implemented by
// *database.LocalStorage; tests substitute an in-memory fake.
type hedgeLedgerStore interface {
	SaveProphetHedgeSpread(e *models.DBProphetHedgeSpread) error
	ListOpenProphetHedgeSpreads() ([]*models.DBProphetHedgeSpread, error)
	GetProphetHedgeSpreadByID(id uint) (*models.DBProphetHedgeSpread, error)
	GetProphetHedgeSession() (*models.DBProphetHedgeSession, error)
	SaveProphetHedgeSession(s *models.DBProphetHedgeSession) error
}

// ProphetHedgeLedger is a thin, stateless façade over the hedge storage methods.
type ProphetHedgeLedger struct{ store hedgeLedgerStore }

func NewProphetHedgeLedger(store hedgeLedgerStore) *ProphetHedgeLedger {
	return &ProphetHedgeLedger{store: store}
}

func (l *ProphetHedgeLedger) Save(e *models.DBProphetHedgeSpread) error {
	return l.store.SaveProphetHedgeSpread(e)
}
func (l *ProphetHedgeLedger) ListOpen() ([]*models.DBProphetHedgeSpread, error) {
	return l.store.ListOpenProphetHedgeSpreads()
}
func (l *ProphetHedgeLedger) Session() (*models.DBProphetHedgeSession, error) {
	return l.store.GetProphetHedgeSession()
}
func (l *ProphetHedgeLedger) SaveSession(s *models.DBProphetHedgeSession) error {
	return l.store.SaveProphetHedgeSession(s)
}
