package services

import (
	"math"

	"prophet-trader/models"
)

// dailyReturns converts a close-price series into simple daily returns:
// r[i] = closes[i]/closes[i-1] - 1. Output length is len(closes)-1. A series
// shorter than 2 yields nil. A non-positive prior close (defensive — equity
// ETF closes are always positive) ends the series early.
func dailyReturns(closes []float64) []float64 {
	if len(closes) < 2 {
		return nil
	}
	out := make([]float64, 0, len(closes)-1)
	for i := 1; i < len(closes); i++ {
		if closes[i-1] <= 0 {
			return out
		}
		out = append(out, closes[i]/closes[i-1]-1)
	}
	return out
}

// pearsonR returns the Pearson correlation coefficient of two equal-length
// series with ok=true, or (0,false) when the inputs are unusable: unequal
// lengths, fewer than 2 points, or zero variance in either series (a flat
// series has no defined correlation).
func pearsonR(a, b []float64) (float64, bool) {
	n := len(a)
	if n < 2 || len(b) != n {
		return 0, false
	}
	var ma, mb float64
	for i := 0; i < n; i++ {
		ma += a[i]
		mb += b[i]
	}
	ma /= float64(n)
	mb /= float64(n)
	var cov, va, vb float64
	for i := 0; i < n; i++ {
		da := a[i] - ma
		db := b[i] - mb
		cov += da * db
		va += da * da
		vb += db * db
	}
	if va == 0 || vb == 0 {
		return 0, false
	}
	return cov / math.Sqrt(va*vb), true
}

// trailing returns the last `window` elements of s, or nil when s has fewer
// than `window` elements (not enough history to assess).
func trailing(s []float64, window int) []float64 {
	if window <= 0 || len(s) < window {
		return nil
	}
	return s[len(s)-window:]
}

// clusterSlotTaken reports whether the candidate's driver cluster already
// holds at least `max` positions on the book. Only rows still on the book
// (status open or pending_fill) count — a row closed earlier this beat frees
// its slot. With max=1 this enforces one-position-per-driver breadth. An empty
// candidate cluster (ticker not in the universe) never binds.
func clusterSlotTaken(open []*models.DBTrendLedgerEntry, candidateCluster string, max int) bool {
	if candidateCluster == "" {
		return false
	}
	count := 0
	for _, row := range open {
		if row.Status != "open" && row.Status != "pending_fill" {
			continue
		}
		if models.ClusterOf(row.Ticker) == candidateCluster {
			count++
			if count >= max {
				return true
			}
		}
	}
	return false
}

// tooCorrelated reports whether the candidate's return series is positively
// correlated above `threshold` with ANY open position's return series, over
// the trailing `window` returns. Only positive correlation blocks (redundant
// concentration); a negatively-correlated position is diversifying and is
// allowed. A pair whose candidate or open series is shorter than `window` is
// treated as "cannot assess" and does not block.
func tooCorrelated(candidateReturns []float64, openReturnsByTicker map[string][]float64, threshold float64, window int) bool {
	candWin := trailing(candidateReturns, window)
	if candWin == nil {
		return false
	}
	for _, openRets := range openReturnsByTicker {
		openWin := trailing(openRets, window)
		if openWin == nil {
			continue
		}
		rho, ok := pearsonR(candWin, openWin)
		if ok && rho > threshold {
			return true
		}
	}
	return false
}
