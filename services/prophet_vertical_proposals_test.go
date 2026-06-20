package services

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"prophet-trader/interfaces"
)

func testProposal(id string) *verticalProposal {
	return &verticalProposal{
		id:          id,
		req:         PlaceVerticalRequest{Underlying: "NVDA", LongSymbol: "NVDA250620C00130000", ShortSymbol: "NVDA250620C00140000"},
		quotedDebit: 4.20,
		entryLong:   &interfaces.OptionContract{Symbol: "NVDA250620C00130000"},
		entryShort:  &interfaces.OptionContract{Symbol: "NVDA250620C00140000"},
	}
}

func TestProposalStore_PutGetExpiry(t *testing.T) {
	now := time.Date(2026, 6, 18, 15, 0, 0, 0, time.UTC)
	s := newProposalStore()
	s.put(testProposal("p1"), now)

	if got, ok := s.get("p1", now.Add(2*time.Minute)); !ok || got.id != "p1" {
		t.Fatalf("within TTL: want p1, got ok=%v", ok)
	}
	if _, ok := s.get("p1", now.Add(verticalProposalTTL+time.Second)); ok {
		t.Fatal("past TTL: want miss")
	}
	if _, ok := s.get("nope", now); ok {
		t.Fatal("unknown id: want miss")
	}
}

func TestProposalStore_SweepBoundsRetention(t *testing.T) {
	now := time.Date(2026, 6, 18, 15, 0, 0, 0, time.UTC)
	s := newProposalStore()
	s.put(testProposal("old"), now)
	s.put(testProposal("fresh"), now.Add(2*time.Minute))
	s.sweep(now.Add(verticalProposalTTL + time.Second)) // "old" expired, "fresh" still valid
	if s.len() != 1 {
		t.Fatalf("after sweep want 1 retained, got %d", s.len())
	}
}

// fakes for the proposer
type fakeChainSource struct {
	chain map[string]*interfaces.OptionContract
	spot  float64
	err   error
}

func (f *fakeChainSource) ChainMap(_ context.Context, underlying string, exp time.Time) (map[string]*interfaces.OptionContract, error) {
	return f.chain, f.err
}
func (f *fakeChainSource) Spot(_ context.Context, underlying string) (float64, error) {
	return f.spot, f.err
}

type fakeOpenGuard struct{ err error }

func (f *fakeOpenGuard) CheckOptionsOpen(_ AgentSource, _ string, _ string, _ *interfaces.OptionsQuote, _ time.Time) error {
	return f.err
}

func twoLegChain() map[string]*interfaces.OptionContract {
	return map[string]*interfaces.OptionContract{
		"NVDA250620C00130000": {Symbol: "NVDA250620C00130000", StrikePrice: 130, ContractType: "call", Bid: 6.0, Ask: 6.4, ImpliedVolatility: 0.45},
		"NVDA250620C00140000": {Symbol: "NVDA250620C00140000", StrikePrice: 140, ContractType: "call", Bid: 2.0, Ask: 2.4, ImpliedVolatility: 0.42},
	}
}

func TestProposer_Propose_StoresAndCards(t *testing.T) {
	now := time.Date(2026, 6, 18, 15, 0, 0, 0, time.UTC)
	exp := time.Date(2026, 6, 20, 0, 0, 0, 0, time.UTC)
	src := &fakeChainSource{chain: twoLegChain(), spot: 130}
	p := NewVerticalProposer(src, &fakeOpenGuard{}, newProposalStore(), nil)

	id, card, err := p.Propose(context.Background(), "NVDA", CallDebit, exp, 10.0, now)
	if err != nil {
		t.Fatal(err)
	}
	if id == "" || card.NetDebit <= 0 || card.MaxLossUSD <= 0 {
		t.Fatalf("bad card: id=%q card=%+v", id, card)
	}
	// stored, and within TTL retrievable
	if _, ok := p.store.get(id, now.Add(time.Minute)); !ok {
		t.Fatal("proposal not stored")
	}
}

func TestProposer_Propose_RejectsNonPositiveDebit(t *testing.T) {
	now := time.Date(2026, 6, 18, 15, 0, 0, 0, time.UTC)
	// invert quotes so long is cheaper than short → non-positive debit
	chain := twoLegChain()
	chain["NVDA250620C00130000"].Bid, chain["NVDA250620C00130000"].Ask = 1.0, 1.2
	chain["NVDA250620C00140000"].Bid, chain["NVDA250620C00140000"].Ask = 6.0, 6.4
	p := NewVerticalProposer(&fakeChainSource{chain: chain, spot: 130}, &fakeOpenGuard{}, newProposalStore(), nil)
	if _, _, err := p.Propose(context.Background(), "NVDA", CallDebit, time.Now(), 10.0, now); err == nil {
		t.Fatal("want non-positive-debit rejection, got nil")
	}
	if p.store.len() != 0 {
		t.Fatal("rejected propose must store nothing")
	}
}

func TestProposer_ValidateForPlace(t *testing.T) {
	now := time.Date(2026, 6, 18, 15, 0, 0, 0, time.UTC)
	store := newProposalStore()
	src := &fakeChainSource{chain: twoLegChain(), spot: 130}
	p := NewVerticalProposer(src, &fakeOpenGuard{}, store, nil)
	id, card, err := p.Propose(context.Background(), "NVDA", CallDebit, time.Now(), 10.0, now)
	if err != nil {
		t.Fatal(err)
	}

	// happy path: fresh quotes ≈ quoted → returns stored req + fresh debit
	req, fresh, err := p.ValidateForPlace(context.Background(), id, now.Add(time.Minute))
	if err != nil || req.LongSymbol != card.LongSymbol || fresh <= 0 {
		t.Fatalf("validate happy: err=%v req=%+v fresh=%v", err, req, fresh)
	}

	// expired
	if _, _, err := p.ValidateForPlace(context.Background(), id, now.Add(verticalProposalTTL+time.Second)); err == nil {
		t.Fatal("want TTL rejection")
	}

	// drift: re-propose, then move the market beyond tolerance
	id2, _, _ := p.Propose(context.Background(), "NVDA", CallDebit, time.Now(), 10.0, now)
	src.chain["NVDA250620C00130000"].Bid, src.chain["NVDA250620C00130000"].Ask = 12.0, 12.4 // long leg jumps → debit balloons
	if _, _, err := p.ValidateForPlace(context.Background(), id2, now.Add(time.Minute)); err == nil {
		t.Fatal("want debit-drift rejection")
	}
}

func TestVerticalContracts(t *testing.T) {
	n := VerticalContracts()
	if n <= 0 {
		t.Fatalf("VerticalContracts: want positive int, got %d", n)
	}
}

func TestParseVerticalDirection(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		want    VerticalDirection
		wantErr bool
	}{
		{"call_debit", "call_debit", CallDebit, false},
		{"put_debit", "put_debit", PutDebit, false},
		{"invalid", "invalid", "", true},
		{"empty", "", "", true},
		{"CallDebit uppercase", "CallDebit", "", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParseVerticalDirection(tt.input)
			if (err != nil) != tt.wantErr {
				t.Fatalf("ParseVerticalDirection(%q): wantErr=%v, got err=%v", tt.input, tt.wantErr, err)
			}
			if !tt.wantErr && got != tt.want {
				t.Fatalf("ParseVerticalDirection(%q): want %q, got %q", tt.input, tt.want, got)
			}
		})
	}
}

type fakeRealizedVolSource struct {
	vol float64
	err error
}

func (f *fakeRealizedVolSource) GetAnnualizedRealizedVol(_ context.Context, _ string, _ int) (float64, error) {
	return f.vol, f.err
}

func TestProposer_Propose_EnrichesCheapness(t *testing.T) {
	now := time.Date(2026, 6, 18, 15, 0, 0, 0, time.UTC)
	exp := time.Date(2026, 6, 20, 0, 0, 0, 0, time.UTC)
	// twoLegChain: long C130 IV 0.45, short C140 IV 0.42 → SkewDiff -0.03 (steep).
	src := &fakeChainSource{chain: twoLegChain(), spot: 130}
	rv := &fakeRealizedVolSource{vol: 0.50}
	p := NewVerticalProposer(src, &fakeOpenGuard{}, newProposalStore(), rv)

	_, card, err := p.Propose(context.Background(), "NVDA", CallDebit, exp, 10.0, now)
	if err != nil {
		t.Fatal(err)
	}
	if !almostEqual(card.SkewDiff, -0.03, 1e-9) {
		t.Fatalf("SkewDiff = %v, want -0.03", card.SkewDiff)
	}
	if !almostEqual(card.IVtoRV, 0.90, 1e-9) { // longIV 0.45 / rv 0.50
		t.Fatalf("IVtoRV = %v, want 0.90", card.IVtoRV)
	}
	if !strings.HasPrefix(card.Cheapness, "rich") || !strings.Contains(card.Cheapness, "steep skew") {
		t.Fatalf("Cheapness = %q, want rich/steep-skew", card.Cheapness)
	}
}

func TestProposer_Propose_NilRV_SkewOnly(t *testing.T) {
	now := time.Date(2026, 6, 18, 15, 0, 0, 0, time.UTC)
	// Use a favorable-skew chain (long IV 0.40, short IV 0.42 → SkewDiff +0.02)
	// so that the label shows "no RV" when rv is nil.
	favorableChain := map[string]*interfaces.OptionContract{
		"NVDA250620C00130000": {Symbol: "NVDA250620C00130000", StrikePrice: 130, ContractType: "call", Bid: 6.0, Ask: 6.4, ImpliedVolatility: 0.40},
		"NVDA250620C00140000": {Symbol: "NVDA250620C00140000", StrikePrice: 140, ContractType: "call", Bid: 2.0, Ask: 2.4, ImpliedVolatility: 0.42},
	}
	src := &fakeChainSource{chain: favorableChain, spot: 130}
	p := NewVerticalProposer(src, &fakeOpenGuard{}, newProposalStore(), nil)

	_, card, err := p.Propose(context.Background(), "NVDA", CallDebit, time.Now(), 10.0, now)
	if err != nil {
		t.Fatal(err)
	}
	if card.IVtoRV != 0 {
		t.Fatalf("IVtoRV = %v, want 0 with nil RV", card.IVtoRV)
	}
	if !strings.Contains(card.Cheapness, "no RV") {
		t.Fatalf("Cheapness = %q, want 'no RV'", card.Cheapness)
	}
}

func TestProposer_Propose_RVError_SkewOnly(t *testing.T) {
	now := time.Date(2026, 6, 18, 15, 0, 0, 0, time.UTC)
	// Use a favorable-skew chain so the label shows "no RV" when rv fetch fails.
	favorableChain := map[string]*interfaces.OptionContract{
		"NVDA250620C00130000": {Symbol: "NVDA250620C00130000", StrikePrice: 130, ContractType: "call", Bid: 6.0, Ask: 6.4, ImpliedVolatility: 0.40},
		"NVDA250620C00140000": {Symbol: "NVDA250620C00140000", StrikePrice: 140, ContractType: "call", Bid: 2.0, Ask: 2.4, ImpliedVolatility: 0.42},
	}
	src := &fakeChainSource{chain: favorableChain, spot: 130}
	rv := &fakeRealizedVolSource{err: errors.New("feed down")}
	p := NewVerticalProposer(src, &fakeOpenGuard{}, newProposalStore(), rv)

	_, card, err := p.Propose(context.Background(), "NVDA", CallDebit, time.Now(), 10.0, now)
	if err != nil {
		t.Fatalf("propose must succeed despite RV error: %v", err)
	}
	if card.IVtoRV != 0 {
		t.Fatalf("IVtoRV = %v, want 0 on RV error", card.IVtoRV)
	}
}
