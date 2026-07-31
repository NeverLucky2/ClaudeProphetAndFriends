package services

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"prophet-trader/interfaces"
	"prophet-trader/models"
)

type hedgeStubRegime struct{ st RegimeGateStatus }

func (s hedgeStubRegime) GetStatus() RegimeGateStatus { return s.st }

type hedgeStubChain struct {
	chain      map[string]*interfaces.OptionContract
	rangeChain map[string]*interfaces.OptionContract
	snaps      map[string]*interfaces.OptionContract
}

func (s hedgeStubChain) GetOptionChain(_ context.Context, _ string, _ time.Time) (map[string]*interfaces.OptionContract, error) {
	return s.chain, nil
}

// GetOptionChainRange defaults to `chain` when no explicit rangeChain is set,
// so existing fixtures keep working unchanged.
func (s hedgeStubChain) GetOptionChainRange(_ context.Context, _ string, _, _ time.Time) (map[string]*interfaces.OptionContract, error) {
	if s.rangeChain != nil {
		return s.rangeChain, nil
	}
	return s.chain, nil
}
func (s hedgeStubChain) GetOptionSnapshot(_ context.Context, sym string) (*interfaces.OptionContract, error) {
	return s.snaps[sym], nil
}

type placedMleg struct{ order MultiLegOrder }
type hedgeStubMleg struct {
	placed []placedMleg
	orders map[string]*interfaces.Order
}

func (s *hedgeStubMleg) PlaceMultiLegOrder(_ context.Context, o MultiLegOrder) (string, error) {
	s.placed = append(s.placed, placedMleg{order: o})
	return "mleg-ord", nil
}
func (s *hedgeStubMleg) GetOrder(_ context.Context, id string) (*interfaces.Order, error) {
	return s.orders[id], nil
}

type hedgeStubAcct struct {
	pv   float64
	bars map[string]*interfaces.Bar
}

func (s hedgeStubAcct) GetAccount(_ context.Context) (*interfaces.Account, error) {
	return &interfaces.Account{PortfolioValue: s.pv}, nil
}
func (s hedgeStubAcct) GetLatestBar(_ context.Context, sym string) (*interfaces.Bar, error) {
	return s.bars[sym], nil
}

func TestRunHeartbeat_OutOfWindowSkips(t *testing.T) {
	led := NewProphetHedgeLedger(newFakeHedgeStore())
	ex := NewProphetHedgeExecutor(led, hedgeStubRegime{}, hedgeStubChain{}, &hedgeStubMleg{}, hedgeStubAcct{}, nil, nil)
	now := time.Date(2026, 6, 1, 13, 0, 0, 0, time.UTC) // 09:00 ET — outside 17:00-17:10
	res, err := ex.RunHeartbeat(context.Background(), now)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if res.Skipped == "" {
		t.Fatal("expected out-of-window skip")
	}
}

func TestReconcile_FilledTransitionsToOpen(t *testing.T) {
	store := newFakeHedgeStore()
	led := NewProphetHedgeLedger(store)
	avg := 5.0
	mleg := &hedgeStubMleg{orders: map[string]*interfaces.Order{
		"o1": {ID: "o1", Status: "filled", FilledQty: 2, FilledAvgPrice: &avg},
	}}
	store.spreads["s1"] = &models.DBProphetHedgeSpread{
		SpreadID: "s1", Status: "pending_fill", EntryOrderID: "o1", Contracts: 2,
		LongPutStrike: 95, ShortPutStrike: 85,
	}
	ex := NewProphetHedgeExecutor(led, hedgeStubRegime{}, hedgeStubChain{}, mleg, hedgeStubAcct{}, nil, nil)
	ex.reconcile(context.Background(), mustOpen(t, led), time.Now(), &HedgeResult{})
	got := store.spreads["s1"]
	if got.Status != "open" {
		t.Fatalf("want open, got %s", got.Status)
	}
	if got.MaxPayoff != ((95.0-85.0)-5.0)*100*2 { // (width-debit)*100*contracts = 5*100*2 = 1000
		t.Fatalf("MaxPayoff not computed on fill: got %.2f", got.MaxPayoff)
	}
}

func TestReconcile_NeverPersistsSingleLeg(t *testing.T) {
	// Safety-critical (D-DP15): a non-filled combo must NEVER become "open".
	store := newFakeHedgeStore()
	led := NewProphetHedgeLedger(store)
	mleg := &hedgeStubMleg{orders: map[string]*interfaces.Order{
		"o1": {ID: "o1", Status: "canceled", FilledQty: 0},
	}}
	store.spreads["s1"] = &models.DBProphetHedgeSpread{SpreadID: "s1", Status: "pending_fill", EntryOrderID: "o1"}
	ex := NewProphetHedgeExecutor(led, hedgeStubRegime{}, hedgeStubChain{}, mleg, hedgeStubAcct{}, nil, nil)
	ex.reconcile(context.Background(), mustOpen(t, led), time.Now(), &HedgeResult{})
	if s := store.spreads["s1"].Status; s == "open" {
		t.Fatalf("a non-filled combo must never become open (got %s)", s)
	}
	if s := store.spreads["s1"].Status; s != "failed" {
		t.Fatalf("canceled entry should become failed, got %s", s)
	}
}

func mustOpen(t *testing.T, l *ProphetHedgeLedger) []*models.DBProphetHedgeSpread {
	t.Helper()
	o, err := l.ListOpen()
	if err != nil {
		t.Fatalf("listopen: %v", err)
	}
	return o
}

func TestManageOpen_HarvestClosesAtTarget(t *testing.T) {
	store := newFakeHedgeStore()
	led := NewProphetHedgeLedger(store)
	mleg := &hedgeStubMleg{}
	snaps := map[string]*interfaces.OptionContract{
		"L": {Symbol: "L", Bid: 8.9, Ask: 9.1}, // long mid 9.0
		"S": {Symbol: "S", Bid: 0.9, Ask: 1.1}, // short mid 1.0 → value/contract = 8.0*100 = 800
	}
	store.spreads["s1"] = &models.DBProphetHedgeSpread{
		SpreadID: "s1", Status: "open", Underlying: "QQQ", Contracts: 1, MaxPayoff: 1000,
		LongPutSymbol: "L", ShortPutSymbol: "S", LongPutStrike: 95, ShortPutStrike: 85,
		Expiration: time.Now().Add(40 * 24 * time.Hour),
	}
	acct := hedgeStubAcct{bars: map[string]*interfaces.Bar{"QQQ": {Close: 500}}}
	ex := NewProphetHedgeExecutor(led, hedgeStubRegime{}, hedgeStubChain{snaps: snaps}, mleg, acct, nil, nil)
	ex.manageOpen(context.Background(), mustOpen(t, led), time.Now(), true, &HedgeResult{})
	got := store.spreads["s1"]
	if got.Status != "closing" || got.CloseReason != "harvest" {
		t.Fatalf("want closing/harvest, got %s/%s", got.Status, got.CloseReason)
	}
	if len(mleg.placed) != 1 {
		t.Fatalf("expected one reverse combo placed, got %d", len(mleg.placed))
	}
	o := mleg.placed[0].order
	if o.Legs[0].PositionIntent != "sell_to_close" || o.Legs[1].PositionIntent != "buy_to_close" {
		t.Fatalf("close legs wrong: %+v", o.Legs)
	}
}

func TestReconcileClosing_ToClosedWithPnL(t *testing.T) {
	store := newFakeHedgeStore()
	led := NewProphetHedgeLedger(store)
	cl := 9.0 // close credit per share
	mleg := &hedgeStubMleg{orders: map[string]*interfaces.Order{
		"c1": {ID: "c1", Status: "filled", FilledQty: 1, FilledAvgPrice: &cl},
	}}
	store.spreads["s1"] = &models.DBProphetHedgeSpread{
		SpreadID: "s1", Status: "closing", CloseOrderID: "c1", Contracts: 1, TotalDebit: 300,
	}
	ex := NewProphetHedgeExecutor(led, hedgeStubRegime{}, hedgeStubChain{}, mleg, hedgeStubAcct{}, nil, nil)
	ex.reconcile(context.Background(), mustOpen(t, led), time.Now(), &HedgeResult{})
	got := store.spreads["s1"]
	if got.Status != "closed" {
		t.Fatalf("want closed, got %s", got.Status)
	}
	// proceeds = 9.0*100*1 = 900 ; realized = 900 − 300 = 600
	if got.RealizedPnL != 600 {
		t.Fatalf("want realized 600, got %.2f", got.RealizedPnL)
	}
}

func TestOpenNew_ArmedPlacesSpread(t *testing.T) {
	store := newFakeHedgeStore()
	led := NewProphetHedgeLedger(store)
	mleg := &hedgeStubMleg{}
	exp := time.Now().Add(50 * 24 * time.Hour)
	chain := map[string]*interfaces.OptionContract{
		"QQQ_P475": {Symbol: "QQQ_P475", ContractType: "put", StrikePrice: 475, ExpirationDate: exp},
		"QQQ_P425": {Symbol: "QQQ_P425", ContractType: "put", StrikePrice: 425, ExpirationDate: exp},
	}
	snaps := map[string]*interfaces.OptionContract{
		"QQQ_P475": {Symbol: "QQQ_P475", Bid: 6.0, Ask: 6.2},
		"QQQ_P425": {Symbol: "QQQ_P425", Bid: 1.0, Ask: 1.2},
	}
	acct := hedgeStubAcct{pv: 100_000, bars: map[string]*interfaces.Bar{"QQQ": {Close: 500}}}
	ex := NewProphetHedgeExecutor(led, hedgeStubRegime{st: RegimeGateStatus{Tier: "DEFENSIVE", Score: 30}},
		hedgeStubChain{chain: chain, snaps: snaps}, mleg, acct, nil, nil)
	ex.openNew(context.Background(), nil, time.Now(), &HedgeResult{})
	if len(mleg.placed) != 1 {
		t.Fatalf("expected one spread opened, got %d", len(mleg.placed))
	}
	o := mleg.placed[0].order
	if o.Strategy != hedgeStrategyTag || len(o.Legs) != 2 {
		t.Fatalf("order mis-structured: %+v", o)
	}
	if o.Legs[0].PositionIntent != "buy_to_open" || o.Legs[1].PositionIntent != "sell_to_open" {
		t.Fatalf("leg intents wrong: %+v", o.Legs)
	}
}

func TestOpenNew_UnaffordableEmitsGradeVisibleSkip(t *testing.T) {
	store := newFakeHedgeStore()
	led := NewProphetHedgeLedger(store)
	mleg := &hedgeStubMleg{}
	exp := time.Now().Add(50 * 24 * time.Hour)
	chain := map[string]*interfaces.OptionContract{
		"QQQ_P475": {Symbol: "QQQ_P475", ContractType: "put", StrikePrice: 475, ExpirationDate: exp},
		"QQQ_P425": {Symbol: "QQQ_P425", ContractType: "put", StrikePrice: 425, ExpirationDate: exp},
	}
	// net debit 15/sh → $1500/contract > 1% of 100k ($1000) → 0 contracts.
	snaps := map[string]*interfaces.OptionContract{
		"QQQ_P475": {Symbol: "QQQ_P475", Bid: 16.0, Ask: 16.0},
		"QQQ_P425": {Symbol: "QQQ_P425", Bid: 1.0, Ask: 1.0},
	}
	acct := hedgeStubAcct{pv: 100_000, bars: map[string]*interfaces.Bar{"QQQ": {Close: 500}}}
	ex := NewProphetHedgeExecutor(led, hedgeStubRegime{st: RegimeGateStatus{Tier: "DEFENSIVE", Score: 30}},
		hedgeStubChain{chain: chain, snaps: snaps}, mleg, acct, nil, nil)
	res := &HedgeResult{}
	ex.openNew(context.Background(), nil, time.Now(), res)
	if len(mleg.placed) != 0 {
		t.Fatal("must not place when unaffordable")
	}
	found := false
	for _, s := range res.Skips {
		if strings.Contains(s, "unaffordable") {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected a grade-visible 'unaffordable' skip, got %v", res.Skips)
	}
}

func TestRunHeartbeat_HolidaySkips(t *testing.T) {
	led := NewProphetHedgeLedger(newFakeHedgeStore())
	ex := NewProphetHedgeExecutor(led, hedgeStubRegime{}, hedgeStubChain{}, &hedgeStubMleg{}, hedgeStubAcct{}, nil, nil)
	// 2026-12-25 17:00 EST = 22:00 UTC — Christmas, NYSE closed, but inside the beat window.
	now := time.Date(2026, 12, 25, 22, 0, 0, 0, time.UTC)
	res, err := ex.RunHeartbeat(context.Background(), now)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if res.Skipped == "" || !strings.Contains(res.Skipped, "holiday") {
		t.Fatalf("expected a holiday skip, got Skipped=%q", res.Skipped)
	}
}

// hedgeExpiryFixture builds a chain of puts at the given expiries, all priced
// identically — only the expiration dates matter to pickExpiry.
func hedgeExpiryFixture(exps ...time.Time) map[string]*interfaces.OptionContract {
	chain := map[string]*interfaces.OptionContract{}
	for i, e := range exps {
		sym := fmt.Sprintf("QQQ_P475_%d", i)
		chain[sym] = &interfaces.OptionContract{
			Symbol: sym, ContractType: "put", StrikePrice: 475, ExpirationDate: e,
		}
	}
	return chain
}

// TestPickExpiry_PrefersMonthlyOverEarlierWeekly: the band query can surface
// both a weekly and a monthly. The monthly carries the open interest, and the
// short leg's liquidity is not covered by the spread guard, so the monthly
// wins even though the weekly has a lower DTE.
func TestPickExpiry_PrefersMonthlyOverEarlierWeekly(t *testing.T) {
	now := time.Date(2026, 7, 31, 12, 0, 0, 0, time.UTC)
	weekly := time.Date(2026, 9, 16, 0, 0, 0, 0, time.UTC)  // Wed, DTE 47
	monthly := time.Date(2026, 9, 18, 0, 0, 0, 0, time.UTC) // 3rd Fri, DTE 49

	ex := NewProphetHedgeExecutor(nil, hedgeStubRegime{},
		hedgeStubChain{rangeChain: hedgeExpiryFixture(weekly, monthly)},
		nil, nil, nil, nil)

	got, ok := ex.pickExpiry(context.Background(), selectStructure(RegimeGateStatus{}, 0), now)
	if !ok {
		t.Fatal("pickExpiry returned ok=false, want a monthly expiry")
	}
	if !got.Equal(monthly) {
		t.Errorf("picked %s, want the monthly %s", got.Format("2006-01-02"), monthly.Format("2006-01-02"))
	}
}

// TestPickExpiry_FallsBackToNearestWhenNoMonthly keeps the hedge tradable in a
// band that happens to contain no third Friday.
func TestPickExpiry_FallsBackToNearestWhenNoMonthly(t *testing.T) {
	now := time.Date(2026, 7, 31, 12, 0, 0, 0, time.UTC)
	early := time.Date(2026, 9, 16, 0, 0, 0, 0, time.UTC) // DTE 47
	late := time.Date(2026, 9, 23, 0, 0, 0, 0, time.UTC)  // DTE 54

	ex := NewProphetHedgeExecutor(nil, hedgeStubRegime{},
		hedgeStubChain{rangeChain: hedgeExpiryFixture(early, late)},
		nil, nil, nil, nil)

	got, ok := ex.pickExpiry(context.Background(), selectStructure(RegimeGateStatus{}, 0), now)
	if !ok {
		t.Fatal("pickExpiry returned ok=false, want the nearest in-band expiry")
	}
	if !got.Equal(early) {
		t.Errorf("picked %s, want the nearest in-band %s", got.Format("2006-01-02"), early.Format("2006-01-02"))
	}
}

// TestPickExpiry_EmptyBandSkipsCleanly: the real-world case that produced 52
// days of silent skips — no listed expiry in the band.
func TestPickExpiry_EmptyBandSkipsCleanly(t *testing.T) {
	now := time.Date(2026, 7, 31, 12, 0, 0, 0, time.UTC)
	ex := NewProphetHedgeExecutor(nil, hedgeStubRegime{},
		hedgeStubChain{rangeChain: map[string]*interfaces.OptionContract{}},
		nil, nil, nil, nil)

	if _, ok := ex.pickExpiry(context.Background(), selectStructure(RegimeGateStatus{}, 0), now); ok {
		t.Error("pickExpiry returned ok=true on an empty band, want false")
	}
}

// TestPickExpiry_IgnoresOutOfBandExpiries: the API range is inclusive by date,
// so the DTE filter must still reject anything outside [DTEMin, DTEMax].
func TestPickExpiry_IgnoresOutOfBandExpiries(t *testing.T) {
	now := time.Date(2026, 7, 31, 12, 0, 0, 0, time.UTC)
	tooSoon := time.Date(2026, 8, 21, 0, 0, 0, 0, time.UTC) // 3rd Fri, DTE 21
	inBand := time.Date(2026, 9, 18, 0, 0, 0, 0, time.UTC)  // 3rd Fri, DTE 49

	ex := NewProphetHedgeExecutor(nil, hedgeStubRegime{},
		hedgeStubChain{rangeChain: hedgeExpiryFixture(tooSoon, inBand)},
		nil, nil, nil, nil)

	got, ok := ex.pickExpiry(context.Background(), selectStructure(RegimeGateStatus{}, 0), now)
	if !ok {
		t.Fatal("pickExpiry returned ok=false, want the in-band monthly")
	}
	if !got.Equal(inBand) {
		t.Errorf("picked %s, want %s", got.Format("2006-01-02"), inBand.Format("2006-01-02"))
	}
}
