package services

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"prophet-trader/interfaces"
	"prophet-trader/models"
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

func pendingRow(store *fakeVerticalStore) *models.DBProphetVerticalSpread {
	sp := &models.DBProphetVerticalSpread{
		VerticalID: "v1", Underlying: "AMZN", Direction: "call_debit",
		Expiration:  time.Now().Add(35 * 24 * time.Hour),
		LongSymbol:  "AMZN260717C00240000", LongStrike: 240,
		ShortSymbol: "AMZN260717C00260000", ShortStrike: 260,
		Contracts: 1, NetDebitPerContract: 5.15, TotalDebit: 515,
		EntryOrderID: "o1", Status: "pending_fill",
	}
	_ = store.SaveProphetVerticalSpread(sp)
	return sp
}

func TestReconcilePending_FilledOpensAndSnapshots(t *testing.T) {
	store := newFakeVerticalStore()
	avg := 5.0
	mleg := &vertStubMleg{orders: map[string]*interfaces.Order{
		"o1": {ID: "o1", Status: "filled", FilledQty: 1, FilledAvgPrice: &avg},
	}}
	bars := vertStubBars{bars: map[string]*interfaces.Bar{"AMZN": {Close: 245.0}}}
	ex, _ := newVertExec(store, vertStubChain{snaps: amznCallSnaps()}, bars, mleg, &vertStubGuard{})
	pendingRow(store)

	res := &VerticalTickResult{}
	ex.RunManageTick(context.Background(), time.Now(), res)

	sp := store.spreads["v1"]
	if sp.Status != "open" {
		t.Fatalf("filled entry must open, got %s (errors: %v)", sp.Status, res.Errors)
	}
	if !almostEqual(sp.NetDebitPerContract, 5.0, 1e-9) || !almostEqual(sp.TotalDebit, 500, 1e-9) {
		t.Fatalf("fill economics not updated: %+v", sp)
	}
	if !almostEqual(sp.MaxGain, (20-5.0)*100, 1e-9) {
		t.Fatalf("MaxGain not recomputed from fill debit: %v", sp.MaxGain)
	}
	if sp.EntrySpot != 245.0 || sp.EntryLongVol != 0.35 || sp.EntryShortVol != 0.32 || sp.EntryTimeToExpiry <= 0 {
		t.Fatalf("entry snapshot not captured: %+v", sp)
	}
	if sp.OpenedAt.IsZero() {
		t.Fatal("OpenedAt must be set on fill")
	}
}

func TestReconcilePending_CanceledFails_NeverSingleLeg(t *testing.T) {
	store := newFakeVerticalStore()
	mleg := &vertStubMleg{orders: map[string]*interfaces.Order{
		"o1": {ID: "o1", Status: "canceled", FilledQty: 0},
	}}
	ex, _ := newVertExec(store, vertStubChain{}, vertStubBars{}, mleg, &vertStubGuard{})
	pendingRow(store)
	ex.RunManageTick(context.Background(), time.Now(), &VerticalTickResult{})
	if s := store.spreads["v1"].Status; s != "failed" {
		t.Fatalf("canceled entry must become failed (never open/single-leg), got %s", s)
	}
}

func TestReconcilePending_StillWorkingLeavesPending(t *testing.T) {
	store := newFakeVerticalStore()
	mleg := &vertStubMleg{orders: map[string]*interfaces.Order{
		"o1": {ID: "o1", Status: "accepted"},
	}}
	ex, _ := newVertExec(store, vertStubChain{}, vertStubBars{}, mleg, &vertStubGuard{})
	pendingRow(store)
	ex.RunManageTick(context.Background(), time.Now(), &VerticalTickResult{})
	if s := store.spreads["v1"].Status; s != "pending_fill" {
		t.Fatalf("working order must stay pending_fill, got %s", s)
	}
}

func TestReconcilePending_DegradedFeedStillOpens(t *testing.T) {
	// Missing bar/snapshots must NOT block the open transition — snapshot
	// fields stay zero (attribution degrades; Residual absorbs).
	store := newFakeVerticalStore()
	avg := 5.0
	mleg := &vertStubMleg{orders: map[string]*interfaces.Order{
		"o1": {ID: "o1", Status: "filled", FilledQty: 1, FilledAvgPrice: &avg},
	}}
	ex, _ := newVertExec(store, vertStubChain{snaps: map[string]*interfaces.OptionContract{}}, vertStubBars{}, mleg, &vertStubGuard{})
	pendingRow(store)
	ex.RunManageTick(context.Background(), time.Now(), &VerticalTickResult{})
	sp := store.spreads["v1"]
	if sp.Status != "open" {
		t.Fatalf("degraded feed must not block the open, got %s", sp.Status)
	}
	if sp.EntrySpot != 0 || sp.EntryLongVol != 0 {
		t.Fatalf("degraded snapshot fields must stay zero: %+v", sp)
	}
}

func openVerticalRow(store *fakeVerticalStore) *models.DBProphetVerticalSpread {
	sp := &models.DBProphetVerticalSpread{
		VerticalID: "v1", Underlying: "AMZN", Direction: "call_debit",
		Expiration:  time.Now().Add(35 * 24 * time.Hour),
		LongSymbol:  "AMZN260717C00240000", LongStrike: 240,
		ShortSymbol: "AMZN260717C00260000", ShortStrike: 260,
		Contracts: 1, NetDebitPerContract: 5.0, TotalDebit: 500, MaxGain: 1500,
		EntrySpot: 245, EntryLongVol: 0.35, EntryShortVol: 0.32, EntryTimeToExpiry: 35.0 / 365,
		Status: "open", OpenedAt: time.Now().Add(-48 * time.Hour),
	}
	_ = store.SaveProphetVerticalSpread(sp)
	return sp
}

func TestCloseVertical_MarketComboAndClosingState(t *testing.T) {
	store := newFakeVerticalStore()
	mleg := &vertStubMleg{}
	ex, _ := newVertExec(store, vertStubChain{snaps: amznCallSnaps()}, vertStubBars{}, mleg, &vertStubGuard{})
	sp := openVerticalRow(store)

	ex.closeVertical(context.Background(), sp, "force_close", &VerticalTickResult{})

	if len(mleg.placed) != 1 {
		t.Fatalf("want 1 close combo, got %d", len(mleg.placed))
	}
	o := mleg.placed[0].order
	// SIGN-HAZARD GUARD: a close RECEIVES credit; per Alpaca (positive=debit)
	// a positive limit here would mean "willing to pay". v1 closes at MARKET.
	if o.LimitPrice != 0 {
		t.Fatalf("close must be a market combo (LimitPrice==0), got %v", o.LimitPrice)
	}
	if len(o.Legs) != 2 ||
		o.Legs[0].Symbol != sp.LongSymbol || o.Legs[0].Side != "sell" || o.Legs[0].PositionIntent != "sell_to_close" ||
		o.Legs[1].Symbol != sp.ShortSymbol || o.Legs[1].Side != "buy" || o.Legs[1].PositionIntent != "buy_to_close" {
		t.Fatalf("close legs wrong: %+v", o.Legs)
	}
	if o.Strategy != verticalStrategyTag {
		t.Fatalf("close must carry the vertical tag, got %q", o.Strategy)
	}
	if sp.Status != "closing" || sp.CloseOrderID != "mleg-vert" || sp.CloseReason != "force_close" {
		t.Fatalf("row not flipped to closing: %+v", sp)
	}
}

func TestReconcileClosing_FilledClosesWithPnLAndAttribution(t *testing.T) {
	store := newFakeVerticalStore()
	avg := 8.0 // close proceeds 8.00/share → realized = 800 − 500 = +300
	mleg := &vertStubMleg{orders: map[string]*interfaces.Order{
		"c1": {ID: "c1", Status: "filled", FilledQty: 1, FilledAvgPrice: &avg},
	}}
	bars := vertStubBars{bars: map[string]*interfaces.Bar{"AMZN": {Close: 258.0}}}
	ex, _ := newVertExec(store, vertStubChain{snaps: amznCallSnaps()}, bars, mleg, &vertStubGuard{})
	sp := openVerticalRow(store)
	sp.Status = "closing"
	sp.CloseOrderID = "c1"
	sp.CloseReason = "llm_requested"

	ex.RunManageTick(context.Background(), time.Now(), &VerticalTickResult{})

	if sp.Status != "closed" {
		t.Fatalf("filled close must finalize closed, got %s", sp.Status)
	}
	if !almostEqual(sp.RealizedPnL, 300, 1e-9) {
		t.Fatalf("realized = %v, want 300", sp.RealizedPnL)
	}
	if sp.ClosedAt == nil {
		t.Fatal("ClosedAt must be set")
	}
	sum := sp.AttribDirection + sp.AttribTheta + sp.AttribIV + sp.AttribResidual
	if !almostEqual(sum, sp.RealizedPnL, 1e-6) {
		t.Fatalf("attribution components must reconcile to realized P&L: sum=%v realized=%v", sum, sp.RealizedPnL)
	}
	if sp.AttribDirection == 0 && sp.AttribTheta == 0 && sp.AttribIV == 0 {
		t.Fatal("attribution must be computed (non-degenerate inputs)")
	}
}

func TestReconcileClosing_CanceledRevertsToOpen_NeverStranded(t *testing.T) {
	// THE fail-closed test: a canceled/rejected close must revert to open
	// (retry next tick) — NEVER closed, NEVER stuck in closing.
	store := newFakeVerticalStore()
	mleg := &vertStubMleg{orders: map[string]*interfaces.Order{
		"c1": {ID: "c1", Status: "canceled"},
	}}
	ex, _ := newVertExec(store, vertStubChain{}, vertStubBars{}, mleg, &vertStubGuard{})
	sp := openVerticalRow(store)
	sp.Status = "closing"
	sp.CloseOrderID = "c1"

	ex.RunManageTick(context.Background(), time.Now(), &VerticalTickResult{})

	if sp.Status != "open" {
		t.Fatalf("canceled close must revert to open (never closed/stranded), got %s", sp.Status)
	}
	if sp.CloseOrderID != "" {
		t.Fatal("CloseOrderID must be cleared on revert")
	}
}

func TestReconcileClosing_NilFillPriceStaysClosing(t *testing.T) {
	store := newFakeVerticalStore()
	mleg := &vertStubMleg{orders: map[string]*interfaces.Order{
		"c1": {ID: "c1", Status: "filled", FilledQty: 1, FilledAvgPrice: nil},
	}}
	ex, _ := newVertExec(store, vertStubChain{}, vertStubBars{}, mleg, &vertStubGuard{})
	sp := openVerticalRow(store)
	sp.Status = "closing"
	sp.CloseOrderID = "c1"
	ex.RunManageTick(context.Background(), time.Now(), &VerticalTickResult{})
	if sp.Status != "closing" {
		t.Fatalf("nil fill price must leave closing (retry), got %s", sp.Status)
	}
}

// snapsWithMids returns leg snapshots with the given per-share mids (BA ±0.10).
func snapsWithMids(longMid, shortMid float64) map[string]*interfaces.OptionContract {
	return map[string]*interfaces.OptionContract{
		"AMZN260717C00240000": {Symbol: "AMZN260717C00240000", ContractType: "call", StrikePrice: 240, Bid: longMid - 0.10, Ask: longMid + 0.10, ImpliedVolatility: 0.30},
		"AMZN260717C00260000": {Symbol: "AMZN260717C00260000", ContractType: "call", StrikePrice: 260, Bid: shortMid - 0.10, Ask: shortMid + 0.10, ImpliedVolatility: 0.28},
	}
}

func TestManageOpen_CloseRequestedClosesLLMReason(t *testing.T) {
	store := newFakeVerticalStore()
	mleg := &vertStubMleg{}
	bars := vertStubBars{bars: map[string]*interfaces.Bar{"AMZN": {Close: 250.0}}}
	ex, _ := newVertExec(store, vertStubChain{snaps: snapsWithMids(7.0, 2.0)}, bars, mleg, &vertStubGuard{})
	sp := openVerticalRow(store)
	sp.CloseRequested = true

	ex.RunManageTick(context.Background(), time.Now(), &VerticalTickResult{})

	if sp.Status != "closing" || sp.CloseReason != "llm_requested" {
		t.Fatalf("CloseRequested must close with llm_requested, got %s/%s", sp.Status, sp.CloseReason)
	}
}

func TestManageOpen_ForceCloseAtDTEFloor(t *testing.T) {
	store := newFakeVerticalStore()
	mleg := &vertStubMleg{}
	bars := vertStubBars{bars: map[string]*interfaces.Bar{"AMZN": {Close: 250.0}}} // between strikes
	ex, _ := newVertExec(store, vertStubChain{snaps: snapsWithMids(10.2, 0.1)}, bars, mleg, &vertStubGuard{})
	sp := openVerticalRow(store)
	sp.Expiration = time.Now().Add(36 * time.Hour) // DTE 1 ≤ force 2

	ex.RunManageTick(context.Background(), time.Now(), &VerticalTickResult{})

	if sp.Status != "closing" || sp.CloseReason != "force_close" {
		t.Fatalf("DTE≤floor must force-close, got %s/%s", sp.Status, sp.CloseReason)
	}
}

func TestManageOpen_LetExpireCarveOutHolds(t *testing.T) {
	store := newFakeVerticalStore()
	mleg := &vertStubMleg{}
	bars := vertStubBars{bars: map[string]*interfaces.Bar{"AMZN": {Close: 230.0}}} // both legs OTM
	// residual value: mids 0.03/0.01 → value $2 ≤ $5 expected exit cost
	ex, _ := newVertExec(store, vertStubChain{snaps: snapsWithMids(0.03, 0.01)}, bars, mleg, &vertStubGuard{})
	sp := openVerticalRow(store)
	sp.Expiration = time.Now().Add(36 * time.Hour)

	res := &VerticalTickResult{}
	ex.RunManageTick(context.Background(), time.Now(), res)

	if sp.Status != "open" || len(mleg.placed) != 0 {
		t.Fatalf("worthless both-OTM spread must ride to expiry (let_expire), got %s, %d orders", sp.Status, len(mleg.placed))
	}
}

func TestManageOpen_HealthyHolds(t *testing.T) {
	store := newFakeVerticalStore()
	mleg := &vertStubMleg{}
	bars := vertStubBars{bars: map[string]*interfaces.Bar{"AMZN": {Close: 250.0}}}
	ex, _ := newVertExec(store, vertStubChain{snaps: snapsWithMids(7.0, 2.0)}, bars, mleg, &vertStubGuard{})
	openVerticalRow(store) // DTE ~35, value $500 (healthy)

	ex.RunManageTick(context.Background(), time.Now(), &VerticalTickResult{})

	if len(mleg.placed) != 0 {
		t.Fatal("healthy vertical must hold (no close order)")
	}
}

func TestManageOpen_BlindNearExpiryForceCloses(t *testing.T) {
	// Degraded feed (no snapshots/spot) at the DTE floor: close protectively
	// rather than ride blind into expiry.
	store := newFakeVerticalStore()
	mleg := &vertStubMleg{}
	ex, _ := newVertExec(store, vertStubChain{snaps: map[string]*interfaces.OptionContract{}}, vertStubBars{}, mleg, &vertStubGuard{})
	sp := openVerticalRow(store)
	sp.Expiration = time.Now().Add(36 * time.Hour)

	ex.RunManageTick(context.Background(), time.Now(), &VerticalTickResult{})

	if sp.Status != "closing" || sp.CloseReason != "force_close" {
		t.Fatalf("blind near-expiry must force-close, got %s/%s", sp.Status, sp.CloseReason)
	}
}

func TestRequestClose_SetsFlag(t *testing.T) {
	store := newFakeVerticalStore()
	ex, _ := newVertExec(store, vertStubChain{}, vertStubBars{}, &vertStubMleg{}, &vertStubGuard{})
	sp := openVerticalRow(store)
	if err := ex.RequestClose(context.Background(), sp.VerticalID); err != nil {
		t.Fatalf("request close: %v", err)
	}
	if !store.spreads["v1"].CloseRequested {
		t.Fatal("CloseRequested must be persisted")
	}
	if err := ex.RequestClose(context.Background(), "nope"); err == nil {
		t.Fatal("unknown vertical must error")
	}
}

func TestListOpenVerticalsEnriched(t *testing.T) {
	store := newFakeVerticalStore()
	now := time.Now()
	expiration := now.Add(7 * 24 * time.Hour)

	// Create an open row with known valuation
	sp := &models.DBProphetVerticalSpread{
		VerticalID: "v-enriched-1", Underlying: "AMZN", Direction: "call_debit",
		Expiration:  expiration,
		LongSymbol:  "AMZN260717C00240000", LongStrike: 240,
		ShortSymbol: "AMZN260717C00260000", ShortStrike: 260,
		Contracts: 1, NetDebitPerContract: 5.0, TotalDebit: 500, MaxGain: 1500,
		EntrySpot: 245, EntryLongVol: 0.35, EntryShortVol: 0.32, EntryTimeToExpiry: 35.0 / 365,
		Status: "open", OpenedAt: now.Add(-48 * time.Hour),
	}
	_ = store.SaveProphetVerticalSpread(sp)

	// Build executor with chain containing both legs (prices: long 6.80/7.20 mid=7.00, short 1.90/2.10 mid=2.00)
	// Value = (7.00 - 2.00) * 100 * 1 = 500
	chain := vertStubChain{snaps: amznCallSnaps()}
	ex, _ := newVertExec(store, chain, vertStubBars{}, &vertStubMleg{}, &vertStubGuard{})

	enriched, err := ex.ListOpenVerticalsEnriched(context.Background(), now)
	if err != nil {
		t.Fatalf("ListOpenVerticalsEnriched: %v", err)
	}
	if len(enriched) != 1 {
		t.Fatalf("expected 1 enriched row, got %d", len(enriched))
	}

	ev := enriched[0]
	if ev.Row.VerticalID != "v-enriched-1" {
		t.Fatalf("row ID wrong: %q", ev.Row.VerticalID)
	}
	if !ev.ValueOK {
		t.Fatal("valuation must succeed (both legs quoted)")
	}
	expectedValue := (7.00 - 2.00) * 100 * 1
	if !almostEqual(ev.Value, expectedValue, 1e-9) {
		t.Fatalf("value wrong: got %v, want %v", ev.Value, expectedValue)
	}
	dte := verticalDTE(expiration, now)
	if ev.DTE != dte {
		t.Fatalf("DTE wrong: got %d, want %d", ev.DTE, dte)
	}
}
