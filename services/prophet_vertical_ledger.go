package services

import "prophet-trader/models"

// verticalLedgerStore is the storage subset the vertical ledger needs.
// Implemented by *database.LocalStorage; tests substitute fakeVerticalStore.
type verticalLedgerStore interface {
	SaveProphetVerticalSpread(e *models.DBProphetVerticalSpread) error
	ListOpenProphetVerticalSpreads() ([]*models.DBProphetVerticalSpread, error)
	GetProphetVerticalSpreadByID(id uint) (*models.DBProphetVerticalSpread, error)
}

// ProphetVerticalLedger is a thin, stateless façade over vertical storage.
type ProphetVerticalLedger struct{ store verticalLedgerStore }

func NewProphetVerticalLedger(store verticalLedgerStore) *ProphetVerticalLedger {
	return &ProphetVerticalLedger{store: store}
}

func (l *ProphetVerticalLedger) Save(e *models.DBProphetVerticalSpread) error {
	return l.store.SaveProphetVerticalSpread(e)
}
func (l *ProphetVerticalLedger) ListOpen() ([]*models.DBProphetVerticalSpread, error) {
	return l.store.ListOpenProphetVerticalSpreads()
}
func (l *ProphetVerticalLedger) GetByID(id uint) (*models.DBProphetVerticalSpread, error) {
	return l.store.GetProphetVerticalSpreadByID(id)
}
