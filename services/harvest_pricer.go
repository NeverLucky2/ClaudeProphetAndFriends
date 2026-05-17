package services

import (
	"context"
	"fmt"

	"prophet-trader/interfaces"
	"prophet-trader/models"
)

// optionPricer is the subset of AlpacaOptionsDataService that the pricer
// needs. Decoupled so the monitor's tests don't pay an HTTP client.
type optionPricer interface {
	GetOptionSnapshot(ctx context.Context, symbol string) (*interfaces.OptionContract, error)
}

// HarvestPricer prices iron condors at the current mid for close-decisions.
type HarvestPricer struct {
	src optionPricer
}

func NewHarvestPricer(src optionPricer) *HarvestPricer {
	return &HarvestPricer{src: src}
}

// CostToClosePerContract returns the per-contract dollar cost-to-close at
// the current mid. Definition matches the rules doc:
//
//	cost = (short_put_mid + short_call_mid) - (long_put_mid + long_call_mid)
//
// A small / negative cost means the condor has converged toward expiry
// worthless and we've captured most of the credit. An error is returned if
// any leg has a missing or zero price — entering the close-decision branch
// with phantom prices would be worse than skipping the tick.
func (p *HarvestPricer) CostToClosePerContract(ctx context.Context, c *models.DBHarvestCondor) (float64, error) {
	symbols := []string{c.ShortPutSymbol, c.LongPutSymbol, c.ShortCallSymbol, c.LongCallSymbol}
	prices := make(map[string]float64, 4)
	for _, s := range symbols {
		snap, err := p.src.GetOptionSnapshot(ctx, s)
		if err != nil {
			return 0, fmt.Errorf("price %s: %w", s, err)
		}
		if snap.Premium <= 0 {
			return 0, fmt.Errorf("zero/missing mid for leg %s", s)
		}
		prices[s] = snap.Premium
	}
	cost := (prices[c.ShortPutSymbol] + prices[c.ShortCallSymbol]) -
		(prices[c.LongPutSymbol] + prices[c.LongCallSymbol])
	return cost, nil
}
