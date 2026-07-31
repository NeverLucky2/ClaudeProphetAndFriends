package services

import (
	"testing"
	"time"

	"prophet-trader/interfaces"
	"prophet-trader/models"
)

func TestIsThirdFriday(t *testing.T) {
	cases := []struct {
		name string
		date time.Time
		want bool
	}{
		{"2026-09-18 monthly", time.Date(2026, 9, 18, 0, 0, 0, 0, time.UTC), true},
		{"2026-10-16 monthly", time.Date(2026, 10, 16, 0, 0, 0, 0, time.UTC), true},
		{"2026-09-11 second Friday", time.Date(2026, 9, 11, 0, 0, 0, 0, time.UTC), false},
		{"2026-09-25 fourth Friday", time.Date(2026, 9, 25, 0, 0, 0, 0, time.UTC), false},
		{"2026-09-16 Wednesday weekly", time.Date(2026, 9, 16, 0, 0, 0, 0, time.UTC), false},
		{"2026-09-21 Monday weekly", time.Date(2026, 9, 21, 0, 0, 0, 0, time.UTC), false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := isThirdFriday(c.date); got != c.want {
				t.Errorf("isThirdFriday(%s) = %v, want %v", c.date.Format("2006-01-02"), got, c.want)
			}
		})
	}
}

func TestSelectStructure_FixedV1(t *testing.T) {
	// v1 ignores regime/iv and always returns the fixed tail-targeted profile.
	p := selectStructure(RegimeGateStatus{Score: 10}, 0.0)
	if p.LongPctOTM != hedgeLongPctOTM || p.ShortPctOTM != hedgeShortPctOTM {
		t.Fatalf("v1 must return fixed OTM %.2f/%.2f, got %.2f/%.2f",
			hedgeLongPctOTM, hedgeShortPctOTM, p.LongPctOTM, p.ShortPctOTM)
	}
	if p.DTEMin != hedgeDTEMin || p.DTEMax != hedgeDTEMax {
		t.Fatalf("v1 must return fixed DTE band")
	}
}

func TestPickPutStrikes(t *testing.T) {
	spot := 100.0
	chain := map[string]*interfaces.OptionContract{
		"P80": {Symbol: "P80", ContractType: "put", StrikePrice: 80},
		"P85": {Symbol: "P85", ContractType: "put", StrikePrice: 85},
		"P90": {Symbol: "P90", ContractType: "put", StrikePrice: 90},
		"P95": {Symbol: "P95", ContractType: "put", StrikePrice: 95},
		"C95": {Symbol: "C95", ContractType: "call", StrikePrice: 95}, // ignored
	}
	// long target = 100*(1-.05)=95 ; short target = 100*(1-.15)=85
	long, short, ok := pickPutStrikes(chain, spot, SpreadProfile{LongPctOTM: 0.05, ShortPctOTM: 0.15})
	if !ok {
		t.Fatal("expected ok")
	}
	if long.Symbol != "P95" || short.Symbol != "P85" {
		t.Fatalf("got long=%s short=%s, want P95/P85", long.Symbol, short.Symbol)
	}
}

func TestPickPutStrikes_DegenerateChain(t *testing.T) {
	chain := map[string]*interfaces.OptionContract{
		"P95": {Symbol: "P95", ContractType: "put", StrikePrice: 95},
	}
	if _, _, ok := pickPutStrikes(chain, 100, SpreadProfile{LongPctOTM: 0.05, ShortPctOTM: 0.15}); ok {
		t.Fatal("expected ok=false on degenerate chain")
	}
}

func TestSizeSpread(t *testing.T) {
	// portfolio 100k, cap 1% = $1000 budget. debit per contract = $800 (=$8/sh*100).
	if n := sizeSpread(100_000, 8.0); n != 1 {
		t.Fatalf("want 1 contract, got %d", n)
	}
	// debit $1500/contract exceeds the $1000 cap → 0 contracts (unaffordable).
	if n := sizeSpread(100_000, 15.0); n != 0 {
		t.Fatalf("want 0 (unaffordable), got %d", n)
	}
	// budget fits 2 contracts ($400 each = $800 ≤ $1000).
	if n := sizeSpread(100_000, 4.0); n != 2 {
		t.Fatalf("want 2 contracts, got %d", n)
	}
	// non-positive inputs → 0.
	if n := sizeSpread(0, 8.0); n != 0 {
		t.Fatalf("want 0 on zero portfolio")
	}
}

func TestMarketableLimit(t *testing.T) {
	// long mid 6.00, short mid 1.00 → net mid debit = 5.00.
	// longBA=0.40, shortBA=0.20 → width=0.60 → buffer(25%)=0.15 → limit=5.15.
	got := marketableLimit(6.00, 1.00, 0.40, 0.20, 0.25)
	if diff := got - 5.15; diff > 1e-9 || diff < -1e-9 {
		t.Fatalf("want 5.15, got %.4f", got)
	}
	// intrinsic ceiling clamp: huge widths → clamp to ceiling 10.
	if got := marketableLimitCapped(6.00, 1.00, 100, 100, 0.25, 10.0); got != 10.0 {
		t.Fatalf("want clamp to 10.0, got %.4f", got)
	}
}

func TestSyntheticStressPayoff(t *testing.T) {
	// spot 100, long put 95, short put 85, debit 3.00/sh, 2 contracts.
	// per-share terminal-intrinsic payoff at shocked spot S:
	//   max(0,95-S) - max(0,85-S) - 3 , then *100*contracts.
	sp := &models.DBProphetHedgeSpread{
		LongPutStrike: 95, ShortPutStrike: 85, NetDebitPerContract: 3.0, Contracts: 2,
	}
	// −10% → S=90: (95-90)=5 ; (85-90)→0 ; 5-0-3 = 2 /sh → *100*2 = 400
	if got := syntheticStressPayoff(sp, 100, 0.10); got != 400 {
		t.Fatalf("-10%% want 400, got %.2f", got)
	}
	// −20% → S=80: (95-80)=15 ; (85-80)=5 ; 15-5-3 = 7 /sh → *100*2 = 1400
	if got := syntheticStressPayoff(sp, 100, 0.20); got != 1400 {
		t.Fatalf("-20%% want 1400, got %.2f", got)
	}
	// 0% → S=100: both OTM → -3/sh → *200 = -600 (full debit loss)
	if got := syntheticStressPayoff(sp, 100, 0.0); got != -600 {
		t.Fatalf("0%% want -600, got %.2f", got)
	}
}
