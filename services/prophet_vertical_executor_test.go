package services

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"prophet-trader/interfaces"
)

// ── stub harness (mirrors the hedge stubs) ──────────────────────────

type vertStubChain struct{ snaps map[string]*interfaces.OptionContract }

func (s vertStubChain) GetOptionSnapshot(_ context.Context, sym string) (*interfaces.OptionContract, error) {
	c, ok := s.snaps[sym]
	if !ok || c == nil {
		return nil, errors.New("no snapshot")
	}
	return c, nil
}

type vertStubBars struct{ bars map[string]*interfaces.Bar }

func (s vertStubBars) GetLatestBar(_ context.Context, sym string) (*interfaces.Bar, error) {
	b, ok := s.bars[sym]
	if !ok {
		return nil, errors.New("no bar")
	}
	return b, nil
}

type vertPlaced struct{ order MultiLegOrder }
type vertStubMleg struct {
	placed   []vertPlaced
	orders   map[string]*interfaces.Order
	placeErr error
}

func (s *vertStubMleg) PlaceMultiLegOrder(_ context.Context, o MultiLegOrder) (string, error) {
	if s.placeErr != nil {
		return "", s.placeErr
	}
	s.placed = append(s.placed, vertPlaced{order: o})
	return "mleg-vert", nil
}
func (s *vertStubMleg) GetOrder(_ context.Context, id string) (*interfaces.Order, error) {
	o, ok := s.orders[id]
	if !ok {
		return nil, errors.New("order not found")
	}
	return o, nil
}

type vertStubGuard struct {
	rejected []string // symbols to reject
	checked  []string // symbols seen
}

func (g *vertStubGuard) CheckOptionsOpen(_ AgentSource, _ string, symbol string, _ *interfaces.OptionsQuote, _ time.Time) error {
	g.checked = append(g.checked, symbol)
	for _, r := range g.rejected {
		if r == symbol {
			return errors.New("guard: rejected " + symbol)
		}
	}
	return nil
}

// newVertExec builds an executor over the fake store with the given stubs.
func newVertExec(store *fakeVerticalStore, chain vertStubChain, bars vertStubBars, mleg *vertStubMleg, guard *vertStubGuard) (*ProphetVerticalExecutor, *ProphetVerticalLedger) {
	led := NewProphetVerticalLedger(store)
	var g verticalGuard
	if guard != nil {
		g = guard
	}
	return NewProphetVerticalExecutor(led, chain, bars, mleg, g, nil), led
}

// liquid AMZN call legs: long 240 mid 7.00 (BA 6.80/7.20), short 260 mid 2.00 (BA 1.90/2.10)
func amznCallSnaps() map[string]*interfaces.OptionContract {
	return map[string]*interfaces.OptionContract{
		"AMZN260717C00240000": {Symbol: "AMZN260717C00240000", ContractType: "call", StrikePrice: 240, Bid: 6.80, Ask: 7.20, ImpliedVolatility: 0.35},
		"AMZN260717C00260000": {Symbol: "AMZN260717C00260000", ContractType: "call", StrikePrice: 260, Bid: 1.90, Ask: 2.10, ImpliedVolatility: 0.32},
	}
}

func amznPlaceReq() PlaceVerticalRequest {
	return PlaceVerticalRequest{
		Underlying: "AMZN", Expiration: time.Date(2026, 7, 17, 20, 0, 0, 0, time.UTC),
		Direction:  CallDebit,
		LongSymbol: "AMZN260717C00240000", LongStrike: 240,
		ShortSymbol: "AMZN260717C00260000", ShortStrike: 260,
	}
}

// ── Place tests ─────────────────────────────────────────────────────

func TestPlace_SubmitsDebitComboAndPersistsPending(t *testing.T) {
	store := newFakeVerticalStore()
	mleg := &vertStubMleg{}
	guard := &vertStubGuard{}
	ex, _ := newVertExec(store, vertStubChain{snaps: amznCallSnaps()}, vertStubBars{}, mleg, guard)

	id, err := ex.Place(context.Background(), amznPlaceReq(), time.Now())
	if err != nil {
		t.Fatalf("place: %v", err)
	}
	if len(mleg.placed) != 1 {
		t.Fatalf("want 1 combo placed, got %d", len(mleg.placed))
	}
	o := mleg.placed[0].order
	// net mid 5.00 + 0.25*(0.40+0.20)=0.15 → 5.15 positive DEBIT limit
	if o.LimitPrice <= 0 {
		t.Fatalf("opening debit limit must be positive (Alpaca: positive=debit), got %v", o.LimitPrice)
	}
	if !almostEqual(o.LimitPrice, 5.15, 1e-9) {
		t.Fatalf("limit = %v, want 5.15", o.LimitPrice)
	}
	if o.Strategy != verticalStrategyTag || o.Contracts != verticalContracts || o.Underlying != "AMZN" {
		t.Fatalf("order meta wrong: %+v", o)
	}
	if len(o.Legs) != 2 ||
		o.Legs[0].Symbol != "AMZN260717C00240000" || o.Legs[0].Side != "buy" || o.Legs[0].PositionIntent != "buy_to_open" ||
		o.Legs[1].Symbol != "AMZN260717C00260000" || o.Legs[1].Side != "sell" || o.Legs[1].PositionIntent != "sell_to_open" {
		t.Fatalf("legs wrong: %+v", o.Legs)
	}
	if len(guard.checked) != 2 {
		t.Fatalf("guard must run per leg (2 checks), got %v", guard.checked)
	}
	sp := store.spreads[id]
	if sp == nil || sp.Status != "pending_fill" || sp.EntryOrderID != "mleg-vert" {
		t.Fatalf("row not persisted as pending_fill: %+v", sp)
	}
	if !almostEqual(sp.TotalDebit, 5.15*100, 1e-6) || sp.MaxGain <= 0 || sp.Breakeven <= 240 {
		t.Fatalf("economics not recorded: %+v", sp)
	}
}

func TestPlace_GuardRejectionBlocksEitherLeg(t *testing.T) {
	for _, rejected := range []string{"AMZN260717C00240000", "AMZN260717C00260000"} {
		store := newFakeVerticalStore()
		mleg := &vertStubMleg{}
		ex, _ := newVertExec(store, vertStubChain{snaps: amznCallSnaps()}, vertStubBars{}, mleg, &vertStubGuard{rejected: []string{rejected}})
		if _, err := ex.Place(context.Background(), amznPlaceReq(), time.Now()); err == nil {
			t.Fatalf("guard rejection of %s must block the open", rejected)
		}
		if len(mleg.placed) != 0 || len(store.spreads) != 0 {
			t.Fatal("no order and no row may exist after a guard rejection")
		}
	}
}

func TestPlace_DebitCapRejects(t *testing.T) {
	snaps := amznCallSnaps()
	snaps["AMZN260717C00240000"].Bid, snaps["AMZN260717C00240000"].Ask = 14.0, 14.4 // mid 14.2 → debit ~12.35 → $1235 > $1000 cap
	store := newFakeVerticalStore()
	mleg := &vertStubMleg{}
	ex, _ := newVertExec(store, vertStubChain{snaps: snaps}, vertStubBars{}, mleg, &vertStubGuard{})
	_, err := ex.Place(context.Background(), amznPlaceReq(), time.Now())
	if err == nil || !strings.Contains(err.Error(), "debit cap") {
		t.Fatalf("expected debit-cap rejection, got %v", err)
	}
	if len(mleg.placed) != 0 {
		t.Fatal("capped order must not be placed")
	}
}

func TestPlace_MissingQuoteFailsClosed(t *testing.T) {
	store := newFakeVerticalStore()
	mleg := &vertStubMleg{}
	ex, _ := newVertExec(store, vertStubChain{snaps: map[string]*interfaces.OptionContract{}}, vertStubBars{}, mleg, &vertStubGuard{})
	if _, err := ex.Place(context.Background(), amznPlaceReq(), time.Now()); err == nil {
		t.Fatal("missing leg snapshot must fail the place (no blind order)")
	}
	if len(mleg.placed) != 0 || len(store.spreads) != 0 {
		t.Fatal("no order and no row on a failed place")
	}
}
