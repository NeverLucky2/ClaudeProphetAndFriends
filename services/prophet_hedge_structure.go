package services

import (
	"math"

	"prophet-trader/interfaces"
	"prophet-trader/models"
)

// SpreadProfile is the structural recipe for a put-debit-spread: how far OTM
// each leg sits and the acceptable DTE band. The single choke point for
// structure selection — the deferred v2 (D-DP4) makes selectStructure return a
// regime/IV-conditional profile with zero changes to the executor.
type SpreadProfile struct {
	LongPctOTM  float64 // long put strike target = spot * (1 - LongPctOTM)
	ShortPctOTM float64 // short put strike target = spot * (1 - ShortPctOTM)
	DTEMin      int
	DTEMax      int
}

// selectStructure returns the spread recipe. v1 (D-DP4) ignores regime and iv
// and always returns the fixed tail-targeted profile; the parameters exist so
// the v2 conditional policy is a drop-in.
func selectStructure(_ RegimeGateStatus, _ float64) SpreadProfile {
	return SpreadProfile{
		LongPctOTM:  hedgeLongPctOTM,
		ShortPctOTM: hedgeShortPctOTM,
		DTEMin:      hedgeDTEMin,
		DTEMax:      hedgeDTEMax,
	}
}

// pickPutStrikes selects the long and short put legs from a chain by nearest
// listed strike to the profile's % OTM targets. Returns ok=false if the chain
// lacks two distinct puts forming a genuine debit spread (long strike strictly
// above short strike) — caller skips this beat, never half-builds. Pure: no I/O.
func pickPutStrikes(chain map[string]*interfaces.OptionContract, spot float64, p SpreadProfile) (long, short *interfaces.OptionContract, ok bool) {
	longTarget := spot * (1 - p.LongPctOTM)
	shortTarget := spot * (1 - p.ShortPctOTM)
	long = nearestPut(chain, longTarget)
	short = nearestPut(chain, shortTarget)
	if long == nil || short == nil {
		return nil, nil, false
	}
	if long.StrikePrice <= short.StrikePrice {
		return nil, nil, false
	}
	return long, short, true
}

func nearestPut(chain map[string]*interfaces.OptionContract, target float64) *interfaces.OptionContract {
	var best *interfaces.OptionContract
	bestDist := math.MaxFloat64
	for _, c := range chain {
		if c.ContractType != "put" {
			continue
		}
		if d := math.Abs(c.StrikePrice - target); d < bestDist {
			bestDist = d
			best = c
		}
	}
	return best
}

// sizeSpread returns the contract count whose total net debit fits the
// per-spread cap (hedgeDebitCapPct of portfolio). debitPerShare is the net
// debit per share (long mid − short mid); ×100 = per-contract cost. Returns 0
// when even ONE contract exceeds the cap — the executor treats 0 as an
// explicit, grade-visible "armed but unaffordable" skip (D-DP16), never a
// silent no-op.
func sizeSpread(portfolio, debitPerShare float64) int {
	if portfolio <= 0 || debitPerShare <= 0 {
		return 0
	}
	budget := portfolio * hedgeDebitCapPct
	perContract := debitPerShare * 100
	n := int(budget / perContract)
	if n < 0 {
		n = 0
	}
	return n
}

// marketableLimit computes a net-debit limit price that crosses partway into the
// spread to actually fill in a fast move (D-DP T2.2): net mid debit + a fraction
// of the combined bid/ask width. longMid/shortMid are per-share mids;
// longBA/shortBA are the per-leg bid/ask widths; bufferFrac is the fraction of
// total width to add.
func marketableLimit(longMid, shortMid, longBA, shortBA, bufferFrac float64) float64 {
	netMid := longMid - shortMid
	width := longBA + shortBA
	return netMid + bufferFrac*width
}

// marketableLimitCapped clamps the marketable limit to the intrinsic ceiling
// (long strike − short strike per share) so we never pay above the spread's
// maximum possible value.
func marketableLimitCapped(longMid, shortMid, longBA, shortBA, bufferFrac, intrinsicCeiling float64) float64 {
	lim := marketableLimit(longMid, shortMid, longBA, shortBA, bufferFrac)
	if lim > intrinsicCeiling {
		return intrinsicCeiling
	}
	return lim
}

// syntheticStressPayoff (D-DP13) returns the spread's terminal-intrinsic P&L if
// QQQ were `shockFrac` lower at expiry — a conservative, model-light payoff-
// capacity measure (no greeks/IV) so the hedge is gradable even in a calm
// quarter with zero real drawdown days. Stored strikes + debit let the deferred
// grader recompute this from QQQ history without a separate daily series.
func syntheticStressPayoff(sp *models.DBProphetHedgeSpread, spot, shockFrac float64) float64 {
	shocked := spot * (1 - shockFrac)
	longIntrinsic := sp.LongPutStrike - shocked
	if longIntrinsic < 0 {
		longIntrinsic = 0
	}
	shortIntrinsic := sp.ShortPutStrike - shocked
	if shortIntrinsic < 0 {
		shortIntrinsic = 0
	}
	perShare := longIntrinsic - shortIntrinsic - sp.NetDebitPerContract
	return perShare * 100 * float64(sp.Contracts)
}
