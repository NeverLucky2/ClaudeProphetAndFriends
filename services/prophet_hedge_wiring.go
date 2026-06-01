package services

import (
	"context"

	"prophet-trader/interfaces"
)

type hedgeAcctSource interface {
	GetAccount(ctx context.Context) (*interfaces.Account, error)
}
type hedgeBarSource interface {
	GetLatestBar(ctx context.Context, symbol string) (*interfaces.Bar, error)
}

// HedgeAccountFetcher adapts the trading service (GetAccount) and the market-data
// service (GetLatestBar) into the single hedgeAccountFetcher interface the hedge
// executor consumes. cmd/bot wires the two concrete services together via this.
type HedgeAccountFetcher struct {
	acct hedgeAcctSource
	bars hedgeBarSource
}

func NewHedgeAccountFetcher(acct hedgeAcctSource, bars hedgeBarSource) *HedgeAccountFetcher {
	return &HedgeAccountFetcher{acct: acct, bars: bars}
}

func (h *HedgeAccountFetcher) GetAccount(ctx context.Context) (*interfaces.Account, error) {
	return h.acct.GetAccount(ctx)
}
func (h *HedgeAccountFetcher) GetLatestBar(ctx context.Context, symbol string) (*interfaces.Bar, error) {
	return h.bars.GetLatestBar(ctx, symbol)
}
