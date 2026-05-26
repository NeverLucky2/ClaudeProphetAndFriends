package services

import (
	"sort"
	"time"

	"prophet-trader/interfaces"
)

// FillItem is a single filled order in a FillsSummary.
type FillItem struct {
	Symbol   string    `json:"symbol"`
	Side     string    `json:"side"` // "buy" | "sell"
	Qty      float64   `json:"qty"`
	AvgPrice float64   `json:"avg_price"`
	FilledAt time.Time `json:"filled_at"`
}

// FillsSummary is the response payload for GET /api/v1/fills/summary.
type FillsSummary struct {
	Strategy string     `json:"strategy"`
	Since    time.Time  `json:"since"`
	Count    int        `json:"count"`
	Fills    []FillItem `json:"fills"`
}

// SummarizeFills keeps orders that filled at/after `since` and, when `strategy`
// is non-empty, whose strategy tag matches. The tag is read from Order.Strategy,
// falling back to parsing ClientOrderID. Empty `strategy` matches every filled
// order (tagged or not). Non-"filled" status, nil FilledAt, and FilledAt before
// `since` are skipped. A nil FilledAvgPrice renders as 0. Result is sorted
// ascending by FilledAt.
func SummarizeFills(orders []*interfaces.Order, strategy string, since time.Time) FillsSummary {
	summary := FillsSummary{
		Strategy: strategy,
		Since:    since,
		Fills:    make([]FillItem, 0),
	}
	for _, o := range orders {
		if o == nil || o.Status != "filled" || o.FilledAt == nil || o.FilledAt.Before(since) {
			continue
		}
		tag := o.Strategy
		if tag == "" {
			tag = interfaces.ParseStrategyFromClientOrderID(o.ClientOrderID)
		}
		if strategy != "" && tag != strategy {
			continue
		}
		avg := 0.0
		if o.FilledAvgPrice != nil {
			avg = *o.FilledAvgPrice
		}
		summary.Fills = append(summary.Fills, FillItem{
			Symbol:   o.Symbol,
			Side:     o.Side,
			Qty:      o.FilledQty,
			AvgPrice: avg,
			FilledAt: *o.FilledAt,
		})
	}
	sort.SliceStable(summary.Fills, func(i, j int) bool {
		return summary.Fills[i].FilledAt.Before(summary.Fills[j].FilledAt)
	})
	summary.Count = len(summary.Fills)
	return summary
}
