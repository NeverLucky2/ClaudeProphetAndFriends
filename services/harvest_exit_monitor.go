package services

import (
	"context"
	"fmt"
	"math"
	"time"

	"prophet-trader/models"
)

// monitorStore is the storage subset the monitor needs to enumerate
// candidates. Decoupled from harvestStateStore so tests don't need to fake
// every method.
type monitorStore interface {
	ListOpenHarvestCondors() ([]*models.DBHarvestCondor, error)
}

// monitorPricer is implemented by HarvestPricer in production and a fake in
// tests.
type monitorPricer interface {
	CostToClosePerContract(ctx context.Context, c *models.DBHarvestCondor) (float64, error)
}

// monitorCloser is implemented by HarvestCloser in production and a fake in
// tests.
type monitorCloser interface {
	CloseCondor(ctx context.Context, req CloseCondorRequest) (*CloseCondorResult, error)
}

// HarvestExitMonitor evaluates the three Step-2 exit rules from
// TRADING_RULES_HARVEST.md against each open condor on every tick:
//
//   - time exit:     DTE <= 21                                 -> limit @ mid
//   - loss stop:     cost_to_close >= 2.0 * credit_per_contract -> limit @ mid + $0.20
//   - profit target: cost_to_close <= 0.50 * credit_per_contract -> limit @ mid
//
// Priority is time -> loss -> profit, matching the rules doc. Time wins over
// loss when both fire on the same condor because it doesn't require a
// price-aware tier escalation (Task 4 will add that nuance).
//
// This is the Task 3 single-tick path: no tier escalation, no CLOSING-row
// handling, no fill-confirmation poll. The monitor calls the closer with
// FinalizeImmediately=false so the row lands in CLOSING and Task 5's fill
// poll owns the CLOSING -> CLOSED transition.
type HarvestExitMonitor struct {
	store  monitorStore
	pricer monitorPricer
	closer monitorCloser
}

func NewHarvestExitMonitor(store monitorStore, pricer monitorPricer, closer monitorCloser) *HarvestExitMonitor {
	return &HarvestExitMonitor{store: store, pricer: pricer, closer: closer}
}

// EvaluateTick runs one pass over open condors. Pricing or close-call errors
// on a single condor are logged via fmt (the goroutine wiring in Task 5 will
// swap this for the standard logger) and do not block the loop — other
// condors still get evaluated.
//
// CLOSING rows are skipped here; Task 4 introduces the cancel-and-replace
// path that needs them. For Task 3, the monitor only ever transitions OPEN
// -> CLOSING via a single close-order placement.
func (m *HarvestExitMonitor) EvaluateTick(ctx context.Context, now time.Time) {
	condors, err := m.store.ListOpenHarvestCondors()
	if err != nil {
		fmt.Printf("[harvest-exit-monitor] list condors failed: %v\n", err)
		return
	}
	for _, c := range condors {
		if c.Status != "OPEN" {
			continue
		}
		dte := int(math.Round(c.Expiration.Sub(now).Hours() / 24))

		// Always fetch cost-to-close. Even time-exit needs it to set the
		// limit price at current mid. Pricer failure is non-fatal per condor
		// (next tick retries).
		cost, err := m.pricer.CostToClosePerContract(ctx, c)
		if err != nil {
			fmt.Printf("[harvest-exit-monitor] %s pricer failed: %v\n", c.CondorID, err)
			continue
		}

		reason, orderType, limitPrice := m.classify(c, dte, cost)
		if reason == "" {
			continue
		}

		req := CloseCondorRequest{
			CondorID:            c.CondorID,
			OrderType:           orderType,
			LimitPrice:          limitPrice,
			CostPerContract:     cost,
			CloseReason:         reason,
			FinalizeImmediately: false, // monitor owns CLOSING -> CLOSED via Task 5 fill poll
		}
		if _, err := m.closer.CloseCondor(ctx, req); err != nil {
			fmt.Printf("[harvest-exit-monitor] %s close failed: %v\n", c.CondorID, err)
			continue
		}
	}
}

// classify returns the close reason, initial-tier order type, and limit
// price for the highest-priority trigger that fires. An empty reason means
// no trigger is active. Priority matches the rules doc: time -> loss ->
// profit.
func (m *HarvestExitMonitor) classify(c *models.DBHarvestCondor, dte int, cost float64) (reason, orderType string, limitPrice float64) {
	if dte <= 21 {
		return "time_exit", "limit", cost
	}
	if cost >= 2.0*c.CreditPerContract {
		// Marketable limit: mid + $0.20 to chase the fill on a loss exit.
		return "loss_stop", "limit", cost + 0.20
	}
	if cost <= 0.50*c.CreditPerContract {
		return "profit_target", "limit", cost
	}
	return "", "", 0
}
