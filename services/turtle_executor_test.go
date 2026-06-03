package services

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
	"testing"
	"time"

	"prophet-trader/interfaces"
	"prophet-trader/models"

	"github.com/sirupsen/logrus"
)

// universeTickers is the centralized basket's ticker list. Tests that need to
// set up signals/bars across the whole universe range over this instead of a
// local copy.
func universeTickers() []string { return models.TrendUniverseTickers() }

// ---- per-test stubs (kept local so tests don't share mutable state) ----

type stubSignals struct {
	signals map[string]*TrendSignal
	errs    map[string]error
}

func (s *stubSignals) GetSignal(_ context.Context, sym string) (*TrendSignal, error) {
	if s.errs != nil {
		if e, ok := s.errs[sym]; ok {
			return nil, e
		}
	}
	if sig, ok := s.signals[sym]; ok {
		return sig, nil
	}
	return nil, fmt.Errorf("no signal stub for %s", sym)
}

type stubBars struct {
	bars map[string]*interfaces.Bar
	errs map[string]error
}

func (s *stubBars) GetLatestBar(_ context.Context, sym string) (*interfaces.Bar, error) {
	if s.errs != nil {
		if e, ok := s.errs[sym]; ok {
			return nil, e
		}
	}
	if b, ok := s.bars[sym]; ok {
		return b, nil
	}
	return nil, fmt.Errorf("no bar stub for %s", sym)
}

type stubTrader struct {
	account *interfaces.Account
	acctErr error

	placedOrders []*interfaces.Order
	placeErrs    map[string]error // keyed by Symbol

	getOrderResponses map[string]*interfaces.Order
	getOrderErrs      map[string]error

	nextOrderIDs []string // optional: pop from front for each PlaceOrder
}

func (s *stubTrader) PlaceOrder(_ context.Context, ord *interfaces.Order) (*interfaces.OrderResult, error) {
	if s.placeErrs != nil {
		if e, ok := s.placeErrs[ord.Symbol]; ok {
			return nil, e
		}
	}
	// Capture a copy of the placed order for test inspection.
	cp := *ord
	s.placedOrders = append(s.placedOrders, &cp)
	var id string
	if len(s.nextOrderIDs) > 0 {
		id = s.nextOrderIDs[0]
		s.nextOrderIDs = s.nextOrderIDs[1:]
	} else {
		id = fmt.Sprintf("ord-%s-%d", ord.Symbol, len(s.placedOrders))
	}
	return &interfaces.OrderResult{OrderID: id, Status: "accepted"}, nil
}

func (s *stubTrader) GetOrder(_ context.Context, id string) (*interfaces.Order, error) {
	if s.getOrderErrs != nil {
		if e, ok := s.getOrderErrs[id]; ok {
			return nil, e
		}
	}
	if ord, ok := s.getOrderResponses[id]; ok {
		return ord, nil
	}
	return nil, fmt.Errorf("no get-order stub for %s", id)
}

func (s *stubTrader) GetAccount(_ context.Context) (*interfaces.Account, error) {
	if s.acctErr != nil {
		return nil, s.acctErr
	}
	return s.account, nil
}

type stubSegmentPnL struct {
	res *SegmentPnL
	err error
}

func (s *stubSegmentPnL) GetSegmentPnL(_ context.Context, _ string) (*SegmentPnL, error) {
	if s.err != nil {
		return nil, s.err
	}
	return s.res, nil
}

type stubRegime struct {
	status RegimeGateStatus
}

func (s *stubRegime) GetStatus() RegimeGateStatus { return s.status }

type stubGuard struct {
	// errBySymbol returns an error for the named symbol on CheckBuy.
	errBySymbol map[string]error
	// calls records every (agent, symbol, allocation) for assertion.
	calls []stubGuardCall
}

type stubGuardCall struct {
	agent      AgentSource
	symbol     string
	allocation float64
}

func (s *stubGuard) CheckBuy(_ context.Context, agent AgentSource, sym string, alloc float64) error {
	s.calls = append(s.calls, stubGuardCall{agent: agent, symbol: sym, allocation: alloc})
	if e, ok := s.errBySymbol[sym]; ok {
		return e
	}
	return nil
}

// ---- in-memory ledger backing ----

func newTestExecutor(t *testing.T,
	signals *stubSignals,
	bars *stubBars,
	trader *stubTrader,
	seg *stubSegmentPnL,
	regime *stubRegime,
	guard *stubGuard,
) (*TurtleExecutor, *TurtleLedger) {
	t.Helper()
	store := newInMemTurtleStore(t)
	ledger := NewTurtleLedger(store)
	logger := logrus.New()
	logger.SetLevel(logrus.FatalLevel) // silence during tests
	exe := NewTurtleExecutor(ledger, signals, bars, trader, seg, regime, guard, logger)
	return exe, ledger
}

// at1700 builds a time at 17:00 ET on the given date. Used as the canonical
// "in-window" wall clock for tests.
func at1700(t *testing.T, ymd string) time.Time {
	t.Helper()
	et, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatalf("load NY tz: %v", err)
	}
	got, err := time.ParseInLocation("2006-01-02 15:04", ymd+" 17:00", et)
	if err != nil {
		t.Fatalf("parse %s 17:00: %v", ymd, err)
	}
	return got
}

func atTime(t *testing.T, ymd, hhmm string) time.Time {
	t.Helper()
	et, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatalf("load NY tz: %v", err)
	}
	got, err := time.ParseInLocation("2006-01-02 15:04", ymd+" "+hhmm, et)
	if err != nil {
		t.Fatalf("parse %s %s: %v", ymd, hhmm, err)
	}
	return got
}

func atTimeSec(t *testing.T, ymd, hhmmss string) time.Time {
	t.Helper()
	et, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatalf("load NY tz: %v", err)
	}
	got, err := time.ParseInLocation("2006-01-02 15:04:05", ymd+" "+hhmmss, et)
	if err != nil {
		t.Fatalf("parse %s %s: %v", ymd, hhmmss, err)
	}
	return got
}

// ---- evaluateEntry ----

func TestEvaluateEntry_AllConditionsHold(t *testing.T) {
	sig := &TrendSignal{
		Ticker: "TLT", LastClose: 95.00, Donchian100High: 92.00,
		SMA200: 90.00, ATR20: 1.50, BarsCount: 300,
	}
	res := evaluateEntry(sig, false)
	if !res.Eligible {
		t.Errorf("expected eligible, got reason=%q", res.Reason)
	}
}

func TestEvaluateEntry_NilSignalIneligible(t *testing.T) {
	res := evaluateEntry(nil, false)
	if res.Eligible {
		t.Errorf("nil signal must not be eligible")
	}
}

func TestEvaluateEntry_FailsOnLowBarsCount(t *testing.T) {
	sig := &TrendSignal{LastClose: 95.0, Donchian100High: 92.0, SMA200: 90.0, ATR20: 1.50, BarsCount: 249}
	res := evaluateEntry(sig, false)
	if res.Eligible {
		t.Errorf("expected ineligible (insufficient bars), got eligible")
	}
}

func TestEvaluateEntry_FailsOnNotAboveDonchian(t *testing.T) {
	sig := &TrendSignal{LastClose: 91.50, Donchian100High: 92.00, SMA200: 90.00, ATR20: 1.50, BarsCount: 300}
	res := evaluateEntry(sig, false)
	if res.Eligible || res.Reason == "" {
		t.Errorf("expected ineligible, got %+v", res)
	}
}

func TestEvaluateEntry_FailsOnBelowSMA200(t *testing.T) {
	sig := &TrendSignal{LastClose: 93.00, Donchian100High: 92.00, SMA200: 94.00, ATR20: 1.50, BarsCount: 300}
	res := evaluateEntry(sig, false)
	if res.Eligible {
		t.Errorf("expected ineligible (below sma200), got eligible")
	}
}

func TestEvaluateEntry_FailsOnFlatATR(t *testing.T) {
	// ATR/close = 0.30/100 = 0.003 < 0.005
	sig := &TrendSignal{LastClose: 100.00, Donchian100High: 99.00, SMA200: 95.00, ATR20: 0.30, BarsCount: 300}
	res := evaluateEntry(sig, false)
	if res.Eligible {
		t.Errorf("expected ineligible (ATR floor), got eligible")
	}
}

func TestEvaluateEntry_FailsOnZeroLastClose(t *testing.T) {
	sig := &TrendSignal{LastClose: 0.0, Donchian100High: 92.0, SMA200: 90.0, ATR20: 1.50, BarsCount: 300}
	res := evaluateEntry(sig, false)
	if res.Eligible {
		t.Errorf("zero last_close must not be eligible (avoid division by zero)")
	}
}

func TestEvaluateEntry_ColdStartProximityFilter(t *testing.T) {
	// Far above breakout: 100 close, 92 high → distance 8, ATR 1.5 → reject
	sig := &TrendSignal{LastClose: 100.00, Donchian100High: 92.00, SMA200: 90.00, ATR20: 1.50, BarsCount: 300}
	res := evaluateEntry(sig, true)
	if res.Eligible {
		t.Errorf("expected cold-start ineligibility (too far above breakout), got eligible")
	}
	// Within ATR of breakout: 92.5 close, 92 high → distance 0.5, ATR 1.5 → eligible
	sig.LastClose = 92.50
	res = evaluateEntry(sig, true)
	if !res.Eligible {
		t.Errorf("expected cold-start eligibility within ATR proximity, got %q", res.Reason)
	}
}

func TestEvaluateEntry_ColdStartHasNoEffectWhenColdStartFalse(t *testing.T) {
	// Same far-above-breakout config as above; coldStart=false should pass all other checks.
	sig := &TrendSignal{LastClose: 100.00, Donchian100High: 92.00, SMA200: 90.00, ATR20: 1.50, BarsCount: 300}
	res := evaluateEntry(sig, false)
	if !res.Eligible {
		t.Errorf("once coldStart completes, far-above-breakout entries are eligible (got reason=%q)", res.Reason)
	}
}

// ---- evaluateExit ----

func mkLedgerOpen(ticker string, entryPx float64, shares int, atr float64) *models.DBTrendLedgerEntry {
	return &models.DBTrendLedgerEntry{
		Ticker: ticker, EntryPrice: entryPx, Shares: shares, ATRAtEntry: atr,
		Status: "open",
	}
}

func TestEvaluateExit_TrailingStopFires(t *testing.T) {
	sig := &TrendSignal{Donchian50Low: 91.00}
	entry := mkLedgerOpen("TLT", 95.0, 100, 1.5)
	got := evaluateExit(entry, sig, 90.50, 5)
	if got.Reason != "trailing_stop" {
		t.Errorf("expected trailing_stop, got %q", got.Reason)
	}
}

func TestEvaluateExit_InitialHardStopFiresWithin20Days(t *testing.T) {
	sig := &TrendSignal{Donchian50Low: 80.00}
	entry := mkLedgerOpen("TLT", 95.0, 100, 1.5)
	entry.InitialStop = 95.0 - 2*1.5 // 92.0
	got := evaluateExit(entry, sig, 91.50, 10)
	if got.Reason != "initial_hard_stop" {
		t.Errorf("expected initial_hard_stop, got %q", got.Reason)
	}
}

func TestEvaluateExit_HardStopActiveOnBoundaryDay20(t *testing.T) {
	// Boundary check: days_since_entry == 20 is still active.
	sig := &TrendSignal{Donchian50Low: 80.00}
	entry := mkLedgerOpen("TLT", 95.0, 100, 1.5)
	entry.InitialStop = 92.0
	got := evaluateExit(entry, sig, 91.50, 20)
	if got.Reason != "initial_hard_stop" {
		t.Errorf("day 20 hard stop must still fire, got %q", got.Reason)
	}
}

func TestEvaluateExit_HardStopInactivePast20Days(t *testing.T) {
	sig := &TrendSignal{Donchian50Low: 80.00}
	entry := mkLedgerOpen("TLT", 95.0, 100, 1.5)
	entry.InitialStop = 92.0
	got := evaluateExit(entry, sig, 91.50, 21)
	if got.Reason == "initial_hard_stop" {
		t.Errorf("hard stop should not fire past 20 days, got %q", got.Reason)
	}
}

func TestEvaluateExit_NoExitWhenAboveAllStops(t *testing.T) {
	sig := &TrendSignal{Donchian50Low: 91.00}
	entry := mkLedgerOpen("TLT", 95.0, 100, 1.5)
	entry.InitialStop = 92.0
	got := evaluateExit(entry, sig, 96.0, 10)
	if got.Reason != "" {
		t.Errorf("expected no exit, got %q", got.Reason)
	}
}

func TestEvaluateExit_NilEntryHolds(t *testing.T) {
	if got := evaluateExit(nil, &TrendSignal{Donchian50Low: 100}, 50, 5); got.Reason != "" {
		t.Errorf("nil entry must produce no exit, got %q", got.Reason)
	}
}

func TestEvaluateExit_NilSigHolds(t *testing.T) {
	entry := mkLedgerOpen("TLT", 95.0, 100, 1.5)
	if got := evaluateExit(entry, nil, 50, 5); got.Reason != "" {
		t.Errorf("nil sig must produce no exit, got %q", got.Reason)
	}
}

func TestEvaluateExit_TrailingTakesPriorityOverHardStop(t *testing.T) {
	// Both rules trigger; the function should return the first one (trailing).
	// Today's open is below both donchian_50_low (91) AND initial_stop (92).
	sig := &TrendSignal{Donchian50Low: 91.00}
	entry := mkLedgerOpen("TLT", 95.0, 100, 1.5)
	entry.InitialStop = 92.0
	got := evaluateExit(entry, sig, 90.50, 5)
	if got.Reason != "trailing_stop" {
		t.Errorf("when both fire, trailing_stop wins (it's the always-active rule); got %q", got.Reason)
	}
}

// ---- computePositionDollars ----

func TestComputePositionDollars_ATRSizingHitsRiskTarget(t *testing.T) {
	// portfolio=$100k, risk 0.5% = $500
	// ATR=$10, lastClose=$100 → stopDistance=$20 → dollars = $500 / ($20/$100) = $2,500
	// (must use high-vol ATR so raw stays under the 4% / $4,000 hard cap
	// from TRADING_RULES_TREND.md line 253; otherwise the test would
	// observe the cap clip rather than the risk-budget formula)
	dollars := computePositionDollars(100_000, 100.0, 10.0, 1.0)
	if dollars < 2_400 || dollars > 2_600 {
		t.Errorf("got $%.2f, want roughly $2,500", dollars)
	}
}

func TestComputePositionDollars_CapsAt4PctOfPortfolio(t *testing.T) {
	// ATR=$0.50, lastClose=$100 → stopDistance=$1 → uncapped = $50,000 (50%)
	// Cap = 4% → $4000
	dollars := computePositionDollars(100_000, 100.0, 0.50, 1.0)
	if dollars > 4_000+1 {
		t.Errorf("expected cap at $4000, got $%.2f", dollars)
	}
}

func TestComputePositionDollars_AppliesSizingMultiplier(t *testing.T) {
	// Use high-vol ATR so we observe pure multiplier scaling without the
	// 4% notional cap clipping both calls to the same ceiling value.
	full := computePositionDollars(100_000, 100.0, 10.0, 1.0)
	half := computePositionDollars(100_000, 100.0, 10.0, 0.5)
	if math.Abs(half-full*0.5) > 1.0 {
		t.Errorf("multiplier not applied: full=%.2f half=%.2f", full, half)
	}
}

func TestComputePositionDollars_ReturnsZeroOnBadInput(t *testing.T) {
	cases := []struct {
		name                                string
		portfolio, lastClose, atr20, sizing float64
	}{
		{"zero portfolio", 0, 100, 1.5, 1.0},
		{"negative portfolio", -100, 100, 1.5, 1.0},
		{"zero lastClose", 100_000, 0, 1.5, 1.0},
		{"zero atr", 100_000, 100, 0, 1.0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := computePositionDollars(tc.portfolio, tc.lastClose, tc.atr20, tc.sizing)
			if got != 0 {
				t.Errorf("expected 0 for %s, got %.2f", tc.name, got)
			}
		})
	}
}

func TestComputePositionDollars_RegimeGateZeroMultiplierGivesZero(t *testing.T) {
	// Regime RED tier sets multiplier=0.0; entry should size to zero.
	got := computePositionDollars(100_000, 100.0, 1.50, 0.0)
	if got != 0 {
		t.Errorf("zero sizingMultiplier must produce $0, got %.2f", got)
	}
}

// ---- preloopCheck ----

func TestPreloop_OutOfWindowSkips(t *testing.T) {
	exe, _ := newTestExecutor(t, nil, nil, nil, nil, nil, nil)
	now := atTime(t, "2026-05-15", "14:00")
	if reason := exe.preloopCheck(now, nil); reason == "" {
		t.Errorf("14:00 ET must be out-of-window, got empty reason")
	}
}

func TestPreloop_DuplicateHeartbeatSkips(t *testing.T) {
	exe, _ := newTestExecutor(t, nil, nil, nil, nil, nil, nil)
	now := at1700(t, "2026-05-15")
	sess := &models.DBTurtleSession{SessionID: "singleton", LastHeartbeatDate: "2026-05-15"}
	if reason := exe.preloopCheck(now, sess); reason == "" {
		t.Errorf("duplicate-heartbeat must be detected, got empty reason")
	}
}

func TestPreloop_InWindowFreshDayReturnsEmpty(t *testing.T) {
	exe, _ := newTestExecutor(t, nil, nil, nil, nil, nil, nil)
	now := at1700(t, "2026-05-15")
	sess := &models.DBTurtleSession{SessionID: "singleton", LastHeartbeatDate: "2026-05-14"}
	if reason := exe.preloopCheck(now, sess); reason != "" {
		t.Errorf("in-window fresh day must pass, got %q", reason)
	}
}

func TestPreloop_NilSessionReturnsEmpty(t *testing.T) {
	exe, _ := newTestExecutor(t, nil, nil, nil, nil, nil, nil)
	now := at1700(t, "2026-05-15")
	if reason := exe.preloopCheck(now, nil); reason != "" {
		t.Errorf("first-run (nil session) in window must pass, got %q", reason)
	}
}

func TestPreloop_BoundaryAt1655ETPasses(t *testing.T) {
	exe, _ := newTestExecutor(t, nil, nil, nil, nil, nil, nil)
	now := atTimeSec(t, "2026-05-15", "16:55:00")
	if reason := exe.preloopCheck(now, nil); reason != "" {
		t.Errorf("16:55:00 must be in window, got %q", reason)
	}
}

func TestPreloop_BoundaryAt1705ETPasses(t *testing.T) {
	exe, _ := newTestExecutor(t, nil, nil, nil, nil, nil, nil)
	now := atTimeSec(t, "2026-05-15", "17:05:00")
	if reason := exe.preloopCheck(now, nil); reason != "" {
		t.Errorf("17:05:00 must be in window, got %q", reason)
	}
}

func TestPreloop_BoundaryAt1654ETIsOutOfWindow(t *testing.T) {
	exe, _ := newTestExecutor(t, nil, nil, nil, nil, nil, nil)
	now := atTimeSec(t, "2026-05-15", "16:54:59")
	if reason := exe.preloopCheck(now, nil); reason == "" {
		t.Errorf("16:54:59 must be out-of-window")
	}
}

// ---- wouldExceedAggregateRiskCap ----

func mkOpenLedger(ticker string, shares int, atr float64) *models.DBTrendLedgerEntry {
	return &models.DBTrendLedgerEntry{Ticker: ticker, Shares: shares, ATRAtEntry: atr, Status: "open"}
}

func TestAggRiskCap_BelowCap(t *testing.T) {
	// portfolio=$100k, cap=2.5%=$2,500 risk
	// existing 1% risk: shares=50, atr=10 → 2*10*50 = $1,000
	// proposed 1% risk: shares=50, atr=10 → 2*10*50 = $1,000
	// total = $2,000 ≤ $2,500 → false
	open := []*models.DBTrendLedgerEntry{mkOpenLedger("TLT", 50, 10.0)}
	if wouldExceedAggregateRiskCap(open, 10.0, 50, 100_000) {
		t.Errorf("$1k existing + $1k proposed should be under $2.5k cap")
	}
}

func TestAggRiskCap_AtBoundary(t *testing.T) {
	// portfolio=$100k, cap=2.5%=$2,500
	// existing $1,500, proposed $1,000 → exactly $2,500 → not exceeded
	open := []*models.DBTrendLedgerEntry{mkOpenLedger("TLT", 75, 10.0)} // 2*10*75 = 1500
	if wouldExceedAggregateRiskCap(open, 10.0, 50, 100_000) {
		t.Errorf("exactly at cap (2.5%%) should NOT be exceeded (strict >)")
	}
}

func TestAggRiskCap_ExceedsCap(t *testing.T) {
	// portfolio=$100k, cap=$2,500
	// existing $1,500 + proposed $1,500 = $3,000 → true
	open := []*models.DBTrendLedgerEntry{mkOpenLedger("TLT", 75, 10.0)}
	if !wouldExceedAggregateRiskCap(open, 10.0, 75, 100_000) {
		t.Errorf("$3k total should exceed $2.5k cap")
	}
}

func TestAggRiskCap_ZeroPortfolioFailsClosed(t *testing.T) {
	if !wouldExceedAggregateRiskCap(nil, 1.0, 10, 0) {
		t.Errorf("portfolio=0 must fail-closed (return true)")
	}
}

func TestAggRiskCap_EmptyLedger(t *testing.T) {
	// no existing positions, proposed $1k risk on $100k → 1% → false
	if wouldExceedAggregateRiskCap(nil, 10.0, 50, 100_000) {
		t.Errorf("empty ledger + small proposed should be under cap")
	}
}

// ---- helpers for RunHeartbeat tests ----

// fullStubs creates a baseline set of working stubs that allow RunHeartbeat
// to proceed cleanly: empty ledger, no signals (each test provides its own),
// trader with healthy account, segment-PnL healthy, regime green, guard allows.
func fullStubs() (*stubSignals, *stubBars, *stubTrader, *stubSegmentPnL, *stubRegime, *stubGuard) {
	sigs := &stubSignals{signals: map[string]*TrendSignal{}, errs: map[string]error{}}
	bars := &stubBars{bars: map[string]*interfaces.Bar{}, errs: map[string]error{}}
	trader := &stubTrader{
		account:           &interfaces.Account{PortfolioValue: 100_000, LastEquity: 100_000},
		getOrderResponses: map[string]*interfaces.Order{},
	}
	seg := &stubSegmentPnL{res: &SegmentPnL{UnrealizedPnLPct: 0, DeployedPercent: 0}}
	regime := &stubRegime{status: RegimeGateStatus{SizingMultiplier: 1.0, BlockNewEntries: false}}
	guard := &stubGuard{errBySymbol: map[string]error{}}
	return sigs, bars, trader, seg, regime, guard
}

// goodEntrySignal returns a TrendSignal that passes evaluateEntry with
// coldStart=true (within ATR proximity of breakout).
func goodEntrySignal(ticker string) *TrendSignal {
	return &TrendSignal{
		Ticker:          ticker,
		LastClose:       100.0,
		Donchian100High: 99.0,
		SMA200:          90.0,
		Donchian50Low:   80.0,
		ATR20:           5.0,
		BarsCount:       300,
	}
}

// ---- RunHeartbeat: preloop short-circuits ----

func TestRunHeartbeat_OutOfWindowReturnsImmediately(t *testing.T) {
	sigs, bars, trader, seg, regime, guard := fullStubs()
	exe, ledger := newTestExecutor(t, sigs, bars, trader, seg, regime, guard)

	now := atTime(t, "2026-05-15", "14:00")
	res, err := exe.RunHeartbeat(context.Background(), now)
	if err != nil {
		t.Fatalf("RunHeartbeat err: %v", err)
	}
	if res.Skipped == "" {
		t.Errorf("expected non-empty Skipped reason for out-of-window")
	}
	if len(trader.placedOrders) != 0 {
		t.Errorf("no orders should be placed when out of window, got %d", len(trader.placedOrders))
	}
	// Session must NOT be saved.
	sess, _ := ledger.Session()
	if sess != nil {
		t.Errorf("session should not be created when out of window, got %+v", sess)
	}
}

func TestRunHeartbeat_DuplicateReturnsImmediately(t *testing.T) {
	sigs, bars, trader, seg, regime, guard := fullStubs()
	exe, ledger := newTestExecutor(t, sigs, bars, trader, seg, regime, guard)

	now := at1700(t, "2026-05-15")
	pre := &models.DBTurtleSession{SessionID: "singleton", LastHeartbeatDate: "2026-05-15"}
	if err := ledger.SaveSession(pre); err != nil {
		t.Fatalf("SaveSession: %v", err)
	}

	res, err := exe.RunHeartbeat(context.Background(), now)
	if err != nil {
		t.Fatalf("RunHeartbeat err: %v", err)
	}
	if res.Skipped == "" {
		t.Errorf("expected non-empty Skipped reason for duplicate")
	}
	if len(trader.placedOrders) != 0 {
		t.Errorf("no orders on duplicate, got %d", len(trader.placedOrders))
	}
}

// ---- Exit loop ----

func TestRunExits_TrailingStopFiresPlacesMarketSell(t *testing.T) {
	sigs, bars, trader, seg, regime, guard := fullStubs()
	// Single open TLT row at entry 95, ATR 1.5, 100 shares.
	exe, ledger := newTestExecutor(t, sigs, bars, trader, seg, regime, guard)
	row := &models.DBTrendLedgerEntry{
		Ticker: "TLT", Status: "open", Strategy: "trend",
		EntryPrice: 95.0, Shares: 100, ATRAtEntry: 1.5, InitialStop: 92.0,
		EntryDate: at1700(t, "2026-04-10"),
	}
	if err := ledger.Save(row); err != nil {
		t.Fatalf("Save: %v", err)
	}
	// Trailing stop fires when today_open <= Donchian50Low.
	sigs.signals["TLT"] = &TrendSignal{Ticker: "TLT", Donchian50Low: 91, ATR20: 1.5, BarsCount: 300}
	bars.bars["TLT"] = &interfaces.Bar{Open: 90.5}
	// Other universe tickers — ineligible so no entries placed (focus on exits).
	for _, sym := range universeTickers() {
		if sym == "TLT" {
			continue
		}
		sigs.signals[sym] = &TrendSignal{Ticker: sym, LastClose: 50, Donchian100High: 60, BarsCount: 300}
		bars.bars[sym] = &interfaces.Bar{Open: 50}
	}

	now := at1700(t, "2026-05-15")
	if _, err := exe.RunHeartbeat(context.Background(), now); err != nil {
		t.Fatalf("RunHeartbeat: %v", err)
	}

	// Find the sell order.
	var sellOrder *interfaces.Order
	for _, o := range trader.placedOrders {
		if o.Symbol == "TLT" && o.Side == "sell" {
			sellOrder = o
			break
		}
	}
	if sellOrder == nil {
		t.Fatalf("expected a TLT sell order, got %d orders", len(trader.placedOrders))
	}
	if sellOrder.Type != "market" {
		t.Errorf("Type: got %q, want market", sellOrder.Type)
	}
	if sellOrder.TimeInForce != "day" {
		t.Errorf("TimeInForce: got %q, want day", sellOrder.TimeInForce)
	}
	if sellOrder.Qty != 100 {
		t.Errorf("Qty: got %v, want 100", sellOrder.Qty)
	}
	if sellOrder.Strategy != "trend" {
		t.Errorf("Strategy: got %q, want trend", sellOrder.Strategy)
	}
	got, _ := ledger.GetByID(row.ID)
	if got.Status != "closed" {
		t.Errorf("ledger row status: got %q, want closed", got.Status)
	}
	if got.ExitReason != "trailing_stop" {
		t.Errorf("ExitReason: got %q, want trailing_stop", got.ExitReason)
	}
	if got.ExitOrderID == "" {
		t.Errorf("ExitOrderID must be set after sell placed")
	}
}

func TestRunExits_HoldAboveStop(t *testing.T) {
	sigs, bars, trader, seg, regime, guard := fullStubs()
	exe, ledger := newTestExecutor(t, sigs, bars, trader, seg, regime, guard)
	row := &models.DBTrendLedgerEntry{
		Ticker: "TLT", Status: "open", Strategy: "trend",
		EntryPrice: 95, Shares: 100, ATRAtEntry: 1.5, InitialStop: 92.0,
		EntryDate: at1700(t, "2026-04-10"),
	}
	if err := ledger.Save(row); err != nil {
		t.Fatalf("Save: %v", err)
	}
	sigs.signals["TLT"] = &TrendSignal{Donchian50Low: 91}
	bars.bars["TLT"] = &interfaces.Bar{Open: 96}
	// Universe ineligibility (focus on exits).
	for _, sym := range universeTickers() {
		if sym == "TLT" {
			continue
		}
		sigs.signals[sym] = &TrendSignal{Ticker: sym, LastClose: 50, Donchian100High: 60, BarsCount: 300}
		bars.bars[sym] = &interfaces.Bar{Open: 50}
	}

	if _, err := exe.RunHeartbeat(context.Background(), at1700(t, "2026-05-15")); err != nil {
		t.Fatalf("RunHeartbeat: %v", err)
	}

	for _, o := range trader.placedOrders {
		if o.Side == "sell" {
			t.Fatalf("no sell expected, got %+v", o)
		}
	}
	got, _ := ledger.GetByID(row.ID)
	if got.Status != "open" {
		t.Errorf("row status: got %q, want open", got.Status)
	}
}

func TestRunExits_SignalFetchErrorAppendsErrorAndContinues(t *testing.T) {
	sigs, bars, trader, seg, regime, guard := fullStubs()
	exe, ledger := newTestExecutor(t, sigs, bars, trader, seg, regime, guard)
	// Two open rows. First (TLT) errors on signal fetch; second (GLD) succeeds
	// and fires trailing stop.
	row1 := &models.DBTrendLedgerEntry{Ticker: "TLT", Status: "open", Strategy: "trend", EntryPrice: 95, Shares: 100, ATRAtEntry: 1.5, EntryDate: at1700(t, "2026-04-10")}
	row2 := &models.DBTrendLedgerEntry{Ticker: "GLD", Status: "open", Strategy: "trend", EntryPrice: 200, Shares: 50, ATRAtEntry: 2.0, EntryDate: at1700(t, "2026-04-10")}
	_ = ledger.Save(row1)
	_ = ledger.Save(row2)

	// Other-universe ineligible fixtures (avoid overwriting TLT/GLD below).
	for _, sym := range universeTickers() {
		if sym == "TLT" || sym == "GLD" {
			continue
		}
		sigs.signals[sym] = &TrendSignal{Ticker: sym, LastClose: 50, Donchian100High: 60, BarsCount: 300}
		bars.bars[sym] = &interfaces.Bar{Open: 50}
	}
	sigs.errs["TLT"] = fmt.Errorf("upstream down")
	sigs.signals["GLD"] = &TrendSignal{Donchian50Low: 195}
	bars.bars["GLD"] = &interfaces.Bar{Open: 190} // fires trailing

	res, err := exe.RunHeartbeat(context.Background(), at1700(t, "2026-05-15"))
	if err != nil {
		t.Fatalf("RunHeartbeat: %v", err)
	}
	if len(res.Errors) == 0 {
		t.Errorf("expected at least one error in res.Errors")
	}
	// GLD should have been processed despite TLT's error.
	got, _ := ledger.GetByID(row2.ID)
	if got.Status != "closed" {
		t.Errorf("GLD row not processed; status got %q, want closed", got.Status)
	}
}

func TestRunExits_OrderPlacementErrorAppendsErrorContinuesOtherRows(t *testing.T) {
	sigs, bars, trader, seg, regime, guard := fullStubs()
	exe, ledger := newTestExecutor(t, sigs, bars, trader, seg, regime, guard)
	// Two open rows; both fire trailing. Trader errors on TLT, succeeds on GLD.
	row1 := &models.DBTrendLedgerEntry{Ticker: "TLT", Status: "open", Strategy: "trend", EntryPrice: 95, Shares: 100, ATRAtEntry: 1.5, EntryDate: at1700(t, "2026-04-10")}
	row2 := &models.DBTrendLedgerEntry{Ticker: "GLD", Status: "open", Strategy: "trend", EntryPrice: 200, Shares: 50, ATRAtEntry: 2.0, EntryDate: at1700(t, "2026-04-10")}
	_ = ledger.Save(row1)
	_ = ledger.Save(row2)
	// Other-universe ineligible fixtures.
	for _, sym := range universeTickers() {
		if sym == "TLT" || sym == "GLD" {
			continue
		}
		sigs.signals[sym] = &TrendSignal{Ticker: sym, LastClose: 50, Donchian100High: 60, BarsCount: 300}
		bars.bars[sym] = &interfaces.Bar{Open: 50}
	}
	sigs.signals["TLT"] = &TrendSignal{Donchian50Low: 91}
	bars.bars["TLT"] = &interfaces.Bar{Open: 90}
	sigs.signals["GLD"] = &TrendSignal{Donchian50Low: 195}
	bars.bars["GLD"] = &interfaces.Bar{Open: 190}
	trader.placeErrs = map[string]error{"TLT": fmt.Errorf("broker rejected")}

	res, _ := exe.RunHeartbeat(context.Background(), at1700(t, "2026-05-15"))

	if len(res.Errors) == 0 {
		t.Errorf("expected an error for TLT placement, got none")
	}
	got2, _ := ledger.GetByID(row2.ID)
	if got2.Status != "closed" {
		t.Errorf("GLD must still be closed after TLT error; got %q", got2.Status)
	}
	got1, _ := ledger.GetByID(row1.ID)
	if got1.Status != "open" {
		t.Errorf("TLT must remain open after broker error (not closed); got %q", got1.Status)
	}
}

func TestRunExits_SkipsPendingFillRows(t *testing.T) {
	sigs, bars, trader, seg, regime, guard := fullStubs()
	exe, ledger := newTestExecutor(t, sigs, bars, trader, seg, regime, guard)
	openRow := &models.DBTrendLedgerEntry{Ticker: "TLT", Status: "open", Strategy: "trend", EntryPrice: 95, Shares: 100, ATRAtEntry: 1.5, EntryDate: at1700(t, "2026-04-10")}
	pendingRow := &models.DBTrendLedgerEntry{Ticker: "GLD", Status: "pending_fill", Strategy: "trend", EntryOrderID: "ord-gld"}
	_ = ledger.Save(openRow)
	_ = ledger.Save(pendingRow)

	// Set up ineligible signals for OTHER universe tickers (skip TLT/GLD so
	// we don't overwrite the exit-loop fixtures below).
	for _, sym := range universeTickers() {
		if sym == "TLT" || sym == "GLD" {
			continue
		}
		sigs.signals[sym] = &TrendSignal{Ticker: sym, LastClose: 50, Donchian100High: 60, BarsCount: 300}
		bars.bars[sym] = &interfaces.Bar{Open: 50}
	}

	// Open row: trailing fires.
	sigs.signals["TLT"] = &TrendSignal{Donchian50Low: 91}
	bars.bars["TLT"] = &interfaces.Bar{Open: 90}
	// Pending order resolves to still-working (no exit attempted regardless).
	trader.getOrderResponses["ord-gld"] = &interfaces.Order{Status: "new"}

	if _, err := exe.RunHeartbeat(context.Background(), at1700(t, "2026-05-15")); err != nil {
		t.Fatalf("RunHeartbeat: %v", err)
	}

	// The exit loop must not have queried signals for GLD (it's pending_fill);
	// the only sell order should be TLT.
	var sellSyms []string
	for _, o := range trader.placedOrders {
		if o.Side == "sell" {
			sellSyms = append(sellSyms, o.Symbol)
		}
	}
	if len(sellSyms) != 1 || sellSyms[0] != "TLT" {
		t.Errorf("expected exactly one sell for TLT, got %v (all orders: %+v)", sellSyms, trader.placedOrders)
	}
	gotGLD, _ := ledger.GetByID(pendingRow.ID)
	if gotGLD.Status != "pending_fill" {
		t.Errorf("GLD pending_fill must be untouched by exit loop, got %q", gotGLD.Status)
	}
}

func TestRunExits_DaysSinceEntryComputed(t *testing.T) {
	sigs, bars, trader, seg, regime, guard := fullStubs()
	exe, ledger := newTestExecutor(t, sigs, bars, trader, seg, regime, guard)
	// EntryDate 25 days before now → hard stop inactive (only fires up to 20).
	// Set up so ONLY hard stop would fire (initial_stop > today_open) but
	// trailing does NOT (today_open > donchian_50_low). With days=25, neither
	// fires → row stays open.
	now := at1700(t, "2026-05-15")
	row := &models.DBTrendLedgerEntry{
		Ticker: "TLT", Status: "open", Strategy: "trend",
		EntryPrice: 95, Shares: 100, ATRAtEntry: 1.5, InitialStop: 92.0,
		EntryDate: now.Add(-25 * 24 * time.Hour),
	}
	if err := ledger.Save(row); err != nil {
		t.Fatalf("Save: %v", err)
	}
	sigs.signals["TLT"] = &TrendSignal{Donchian50Low: 80} // trailing far below
	bars.bars["TLT"] = &interfaces.Bar{Open: 91}          // below initial stop, above donchian
	for _, sym := range universeTickers() {
		if sym == "TLT" {
			continue
		}
		sigs.signals[sym] = &TrendSignal{Ticker: sym, LastClose: 50, Donchian100High: 60, BarsCount: 300}
		bars.bars[sym] = &interfaces.Bar{Open: 50}
	}

	if _, err := exe.RunHeartbeat(context.Background(), now); err != nil {
		t.Fatalf("RunHeartbeat: %v", err)
	}
	for _, o := range trader.placedOrders {
		if o.Side == "sell" {
			t.Fatalf("no sell expected at 25 days (hard stop inactive); got %+v", o)
		}
	}
	got, _ := ledger.GetByID(row.ID)
	if got.Status != "open" {
		t.Errorf("row status: got %q, want open (hard stop inactive past 20d)", got.Status)
	}
}

// ---- Entry loop ----

// universeIneligibleExcept sets up ineligible signals/bars for every universe
// ticker EXCEPT the given exclusion list. Helper to keep tests focused on a
// single entry candidate.
func universeIneligibleExcept(sigs *stubSignals, bars *stubBars, except ...string) {
	skip := map[string]struct{}{}
	for _, s := range except {
		skip[s] = struct{}{}
	}
	for _, sym := range universeTickers() {
		if _, ok := skip[sym]; ok {
			continue
		}
		sigs.signals[sym] = &TrendSignal{Ticker: sym, LastClose: 50, Donchian100High: 60, BarsCount: 300}
		bars.bars[sym] = &interfaces.Bar{Open: 50}
	}
}

func TestRunEntries_PlacesLimitOrderAtLastClose1005(t *testing.T) {
	sigs, bars, trader, seg, regime, guard := fullStubs()
	universeIneligibleExcept(sigs, bars, "TLT")
	// TLT: valid breakout signal close=100, donchian=99, sma=90, atr=5
	sigs.signals["TLT"] = goodEntrySignal("TLT")
	bars.bars["TLT"] = &interfaces.Bar{Open: 99, Close: 100}
	exe, ledger := newTestExecutor(t, sigs, bars, trader, seg, regime, guard)

	if _, err := exe.RunHeartbeat(context.Background(), at1700(t, "2026-05-15")); err != nil {
		t.Fatalf("RunHeartbeat: %v", err)
	}

	// Find the TLT buy.
	var buy *interfaces.Order
	for _, o := range trader.placedOrders {
		if o.Symbol == "TLT" && o.Side == "buy" {
			buy = o
			break
		}
	}
	if buy == nil {
		t.Fatalf("expected TLT buy order, got %d total orders", len(trader.placedOrders))
	}
	if buy.Type != "limit" {
		t.Errorf("Type: got %q, want limit", buy.Type)
	}
	if buy.TimeInForce != "day" {
		t.Errorf("TimeInForce: got %q, want day", buy.TimeInForce)
	}
	if buy.Strategy != "trend" {
		t.Errorf("Strategy: got %q, want trend", buy.Strategy)
	}
	if buy.LimitPrice == nil {
		t.Fatalf("LimitPrice must be set")
	}
	wantLP := 100.0 * 1.005
	if math.Abs(*buy.LimitPrice-wantLP) > 0.001 {
		t.Errorf("LimitPrice: got %.4f, want %.4f", *buy.LimitPrice, wantLP)
	}

	// Ledger row created with pending_fill status.
	open, err := ledger.ListOpen()
	if err != nil {
		t.Fatalf("ListOpen: %v", err)
	}
	var ledgerTLT *models.DBTrendLedgerEntry
	for _, r := range open {
		if r.Ticker == "TLT" {
			ledgerTLT = r
			break
		}
	}
	if ledgerTLT == nil {
		t.Fatal("no TLT ledger row after entry")
	}
	if ledgerTLT.Status != "pending_fill" {
		t.Errorf("Status: got %q, want pending_fill", ledgerTLT.Status)
	}
	if ledgerTLT.ATRAtEntry != 5.0 {
		t.Errorf("ATRAtEntry: got %v, want 5.0", ledgerTLT.ATRAtEntry)
	}
	wantStop := 100.0 - 2*5.0
	if math.Abs(ledgerTLT.InitialStop-wantStop) > 0.001 {
		t.Errorf("InitialStop: got %v, want %v", ledgerTLT.InitialStop, wantStop)
	}
	if ledgerTLT.EntryOrderID == "" {
		t.Errorf("EntryOrderID must be set")
	}
	if ledgerTLT.Strategy != "trend" {
		t.Errorf("ledger Strategy: got %q, want trend", ledgerTLT.Strategy)
	}
}

// Regression: 2026-05-19 USO entry was rejected by Alpaca with HTTP 422
// code 42210000 ("sub-penny increment") because 152.96 * 1.005 = 153.7248.
// Submitted limit price must snap to $0.01 for prices >= $1.
func TestRunEntries_LimitPriceRoundedToPenny(t *testing.T) {
	sigs, bars, trader, seg, regime, guard := fullStubs()
	universeIneligibleExcept(sigs, bars, "USO")
	usoSig := goodEntrySignal("USO")
	usoSig.LastClose = 152.96
	usoSig.Donchian100High = 150.0
	usoSig.SMA200 = 140.0
	usoSig.Donchian50Low = 120.0
	usoSig.ATR20 = 5.0
	sigs.signals["USO"] = usoSig
	bars.bars["USO"] = &interfaces.Bar{Open: 152.0, Close: 152.96}
	exe, _ := newTestExecutor(t, sigs, bars, trader, seg, regime, guard)

	if _, err := exe.RunHeartbeat(context.Background(), at1700(t, "2026-05-15")); err != nil {
		t.Fatalf("RunHeartbeat: %v", err)
	}

	var buy *interfaces.Order
	for _, o := range trader.placedOrders {
		if o.Symbol == "USO" && o.Side == "buy" {
			buy = o
			break
		}
	}
	if buy == nil {
		t.Fatalf("expected USO buy order, got %d total orders", len(trader.placedOrders))
	}
	if buy.LimitPrice == nil {
		t.Fatalf("LimitPrice must be set")
	}
	got := *buy.LimitPrice
	if got != 153.72 {
		t.Errorf("LimitPrice: got %.6f, want exactly 153.72 (penny-rounded)", got)
	}
	// Defensive: assert no sub-penny precision regardless of value.
	if math.Abs(got*100-math.Round(got*100)) > 1e-9 {
		t.Errorf("LimitPrice %.6f has sub-penny precision; Alpaca rejects with HTTP 422 code 42210000", got)
	}
}

// When the broker rejects an entry order (validation error, transient,
// or anything else), a structured MissedEntry record is added to the
// heartbeat result so /api/v1/turtle/status surfaces the miss without
// requiring callers to pattern-match the Errors string array.
func TestRunEntries_PlaceOrderFailureRecordedInMissedEntries(t *testing.T) {
	sigs, bars, trader, seg, regime, guard := fullStubs()
	universeIneligibleExcept(sigs, bars, "TLT")
	sigs.signals["TLT"] = goodEntrySignal("TLT")
	bars.bars["TLT"] = &interfaces.Bar{Open: 99, Close: 100}
	trader.placeErrs = map[string]error{
		"TLT": fmt.Errorf("invalid limit_price: sub-penny increment"),
	}
	exe, _ := newTestExecutor(t, sigs, bars, trader, seg, regime, guard)

	res, err := exe.RunHeartbeat(context.Background(), at1700(t, "2026-05-15"))
	if err != nil {
		t.Fatalf("RunHeartbeat: %v", err)
	}
	if len(res.MissedEntries) != 1 {
		t.Fatalf("MissedEntries: got %d, want 1 (Errors=%v)", len(res.MissedEntries), res.Errors)
	}
	me := res.MissedEntries[0]
	if me.Ticker != "TLT" {
		t.Errorf("Ticker: got %q, want TLT", me.Ticker)
	}
	if me.Stage != "entry_limit_buy" {
		t.Errorf("Stage: got %q, want entry_limit_buy", me.Stage)
	}
	if !strings.Contains(me.Error, "sub-penny") {
		t.Errorf("Error: got %q, want contains 'sub-penny'", me.Error)
	}
	// Backward-compat: Errors still includes the human-readable entry.
	foundInErrors := false
	for _, e := range res.Errors {
		if strings.Contains(e, "TLT") && strings.Contains(e, "place buy") {
			foundInErrors = true
			break
		}
	}
	if !foundInErrors {
		t.Errorf("Errors should still include the entry-failure string; got %v", res.Errors)
	}
}

func TestRunEntries_RegimeBlockSkipsAllEntries(t *testing.T) {
	sigs, bars, trader, seg, regime, guard := fullStubs()
	universeIneligibleExcept(sigs, bars, "TLT")
	sigs.signals["TLT"] = goodEntrySignal("TLT")
	bars.bars["TLT"] = &interfaces.Bar{Open: 99, Close: 100}
	regime.status.BlockNewEntries = true
	exe, ledger := newTestExecutor(t, sigs, bars, trader, seg, regime, guard)

	// Existing open position fires trailing stop — verify exits still run.
	row := &models.DBTrendLedgerEntry{Ticker: "GLD", Status: "open", Strategy: "trend",
		EntryPrice: 200, Shares: 50, ATRAtEntry: 2.0, EntryDate: at1700(t, "2026-04-10")}
	_ = ledger.Save(row)
	sigs.signals["GLD"] = &TrendSignal{Donchian50Low: 195}
	bars.bars["GLD"] = &interfaces.Bar{Open: 190}

	res, _ := exe.RunHeartbeat(context.Background(), at1700(t, "2026-05-15"))

	if !res.SkipEntries {
		t.Errorf("SkipEntries must be true under regime block")
	}
	for _, o := range trader.placedOrders {
		if o.Side == "buy" {
			t.Errorf("no buy expected under regime block, got %+v", o)
		}
	}
	got, _ := ledger.GetByID(row.ID)
	if got.Status != "closed" {
		t.Errorf("exits must still run under regime block; GLD status got %q, want closed", got.Status)
	}
}

func TestRunEntries_SegmentCircuitBreakerSkipsEntries(t *testing.T) {
	sigs, bars, trader, seg, regime, guard := fullStubs()
	universeIneligibleExcept(sigs, bars, "TLT")
	sigs.signals["TLT"] = goodEntrySignal("TLT")
	bars.bars["TLT"] = &interfaces.Bar{Open: 99, Close: 100}
	seg.res = &SegmentPnL{UnrealizedPnLPct: -2.5, DeployedPercent: 0}
	exe, _ := newTestExecutor(t, sigs, bars, trader, seg, regime, guard)

	res, _ := exe.RunHeartbeat(context.Background(), at1700(t, "2026-05-15"))

	if !res.CircuitBreaker {
		t.Errorf("CircuitBreaker must be true at -2.5%% segment PnL")
	}
	if !res.SkipEntries {
		t.Errorf("SkipEntries must be true when circuit tripped")
	}
	for _, o := range trader.placedOrders {
		if o.Side == "buy" {
			t.Errorf("no buy expected when circuit tripped, got %+v", o)
		}
	}
}

func TestRunEntries_DeployedCapAt18PctSkipsEntries(t *testing.T) {
	sigs, bars, trader, seg, regime, guard := fullStubs()
	universeIneligibleExcept(sigs, bars, "TLT")
	sigs.signals["TLT"] = goodEntrySignal("TLT")
	bars.bars["TLT"] = &interfaces.Bar{Open: 99, Close: 100}
	seg.res = &SegmentPnL{UnrealizedPnLPct: 0, DeployedPercent: 18.5}
	exe, _ := newTestExecutor(t, sigs, bars, trader, seg, regime, guard)

	res, _ := exe.RunHeartbeat(context.Background(), at1700(t, "2026-05-15"))

	if !res.SkipEntries {
		t.Errorf("SkipEntries must be true at deployed >= 18%%")
	}
	for _, o := range trader.placedOrders {
		if o.Side == "buy" {
			t.Errorf("no buy expected at deployed cap, got %+v", o)
		}
	}
}

func TestRunEntries_PositionCountCapBlocksSeventh(t *testing.T) {
	sigs, bars, trader, seg, regime, guard := fullStubs()
	exe, ledger := newTestExecutor(t, sigs, bars, trader, seg, regime, guard)
	// Six open positions, one per cluster, each with negligible risk so the
	// 2.5% aggregate-risk cap does not pre-empt the count cap.
	for _, sym := range []string{"TLT", "GLD", "USO", "DBC", "UUP", "EEM"} {
		row := &models.DBTrendLedgerEntry{Ticker: sym, Status: "open", Strategy: "trend",
			EntryPrice: 100, Shares: 1, ATRAtEntry: 0.01, EntryDate: at1700(t, "2026-04-10")}
		_ = ledger.Save(row)
		// Hold (no exit) for these tickers.
		sigs.signals[sym] = &TrendSignal{Donchian50Low: 50}
		bars.bars[sym] = &interfaces.Bar{Open: 200}
	}
	// IEF is a valid breakout candidate; with 6 positions already open the
	// position-count cap (6) blocks any 7th entry.
	universeIneligibleExcept(sigs, bars, "TLT", "GLD", "USO", "DBC", "UUP", "EEM", "IEF")
	sigs.signals["IEF"] = goodEntrySignal("IEF")
	bars.bars["IEF"] = &interfaces.Bar{Open: 99, Close: 100}

	if _, err := exe.RunHeartbeat(context.Background(), at1700(t, "2026-05-15")); err != nil {
		t.Fatalf("RunHeartbeat: %v", err)
	}
	for _, o := range trader.placedOrders {
		if o.Side == "buy" {
			t.Errorf("no 7th buy expected at the position-count cap, got %+v", o)
		}
	}
}

func TestRunEntries_AggregateRiskCapBlocks(t *testing.T) {
	sigs, bars, trader, seg, regime, guard := fullStubs()
	exe, ledger := newTestExecutor(t, sigs, bars, trader, seg, regime, guard)
	universeIneligibleExcept(sigs, bars, "TLT", "GLD", "USO", "DBC", "UUP", "EEM")
	// 4 open rows each at 0.5% risk (sum 2.0%). Universe candidate EEM
	// would add 0.7% → projected 2.7% > 2.5% cap → skip.
	// portfolio = $100k, cap = $2,500. Each existing risk = 2*atr*shares = $500
	//   → atr=5, shares=50.
	for _, sym := range []string{"TLT", "GLD", "USO", "DBC"} {
		row := &models.DBTrendLedgerEntry{Ticker: sym, Status: "open", Strategy: "trend",
			EntryPrice: 100, Shares: 50, ATRAtEntry: 5.0, EntryDate: at1700(t, "2026-04-10")}
		_ = ledger.Save(row)
		sigs.signals[sym] = &TrendSignal{Donchian50Low: 50}
		bars.bars[sym] = &interfaces.Bar{Open: 200} // no exit
	}
	// UUP held but no signal needed; mark it ineligible for entry universe
	sigs.signals["UUP"] = &TrendSignal{Ticker: "UUP", LastClose: 50, Donchian100High: 60, BarsCount: 300}
	bars.bars["UUP"] = &interfaces.Bar{Open: 50}

	// EEM candidate: valid breakout. proposed risk = 2*atr*shares.
	// With portfolio=$100k, computePositionDollars(100k, lastClose=100, atr=7, mult=1.0)
	//   risk_budget=$500, raw=$500/($14/$100)=$3,571.43 vs cap $4,000 → $3,571.43
	//   proposedShares = 35. proposed risk = 2*7*35 = $490.
	// Existing risk = 4*$500 = $2,000. Projected = $2,490 → 2.49% → UNDER cap. Bad test.
	// Recompute: we need proposed risk to push us OVER $2,500. With shares=50, atr=10:
	//   risk = 2*10*50 = $1,000 → projected $3,000 → over.
	// But to force shares=50 with cap-bound dollars: computePositionDollars(100k, 100, 10, 1.0)
	//   = $500 / ($20/$100) = $2,500. /price=100 → 25 shares. risk = 2*10*25=$500. NOT enough.
	// We need bigger ATR/shares. Try lastClose=20, atr=10:
	//   raw = $500/($20/$20) = $500 → /price=20 → 25 shares. risk = 2*10*25=$500. Still $500.
	//
	// The math: dollars = portfolio*0.005 / (2*atr/lastClose). shares = dollars/lastClose.
	//   risk = 2*atr*shares = 2*atr*(dollars/lastClose) = 2*atr*portfolio*0.005/(2*atr) = portfolio*0.005 = $500.
	// So per-trade risk is ALWAYS exactly 0.5% when not cap-clipped — by design.
	// To exceed the 2.5% aggregate, we need 5 such trades. With 4 existing at $500
	// each = $2,000, plus a proposed $500 = $2,500 → at-cap (not over). So we
	// need existing rows at >0.5% each. Bump shares.
	// Redo: 4 existing rows at 0.6% risk each = $2,400; proposed 0.5% → $2,900 > cap.
	// 0.6% risk on $100k = $600 = 2*atr*shares; with atr=10 → shares=30.
	// Updating the 4 existing rows below.
	for _, sym := range []string{"TLT", "GLD", "USO", "DBC"} {
		open, _ := ledger.ListOpen()
		for _, r := range open {
			if r.Ticker == sym {
				r.Shares = 30
				r.ATRAtEntry = 10.0 // 2*10*30 = $600 risk on $100k
				_ = ledger.Save(r)
			}
		}
	}
	sigs.signals["EEM"] = &TrendSignal{
		Ticker: "EEM", LastClose: 100, Donchian100High: 99,
		SMA200: 90, Donchian50Low: 80, ATR20: 10, BarsCount: 300,
	}
	bars.bars["EEM"] = &interfaces.Bar{Open: 99, Close: 100}

	res, _ := exe.RunHeartbeat(context.Background(), at1700(t, "2026-05-15"))

	for _, o := range trader.placedOrders {
		if o.Side == "buy" {
			t.Errorf("no buy expected when aggregate risk would exceed cap, got %+v", o)
		}
	}
	// Should appear in skips with a risk-related reason.
	foundRisk := false
	for _, s := range res.Skips {
		if containsCaseInsensitive(s, "risk") {
			foundRisk = true
			break
		}
	}
	if !foundRisk {
		t.Errorf("expected an aggregate-risk skip in res.Skips, got %v", res.Skips)
	}
}

func containsCaseInsensitive(s, substr string) bool {
	return strings.Contains(strings.ToLower(s), strings.ToLower(substr))
}

func TestRunEntries_TradeGuardSectorCapBlocksOneTickerContinuesOthers(t *testing.T) {
	sigs, bars, trader, seg, regime, guard := fullStubs()
	// Both TLT and GLD have valid entry signals; guard rejects TLT only.
	universeIneligibleExcept(sigs, bars, "TLT", "GLD")
	sigs.signals["TLT"] = goodEntrySignal("TLT")
	bars.bars["TLT"] = &interfaces.Bar{Open: 99, Close: 100}
	sigs.signals["GLD"] = goodEntrySignal("GLD")
	bars.bars["GLD"] = &interfaces.Bar{Open: 99, Close: 100}
	guard.errBySymbol["TLT"] = errors.New("sector cap exceeded")
	exe, _ := newTestExecutor(t, sigs, bars, trader, seg, regime, guard)

	if _, err := exe.RunHeartbeat(context.Background(), at1700(t, "2026-05-15")); err != nil {
		t.Fatalf("RunHeartbeat: %v", err)
	}

	hasTLT, hasGLD := false, false
	for _, o := range trader.placedOrders {
		if o.Side != "buy" {
			continue
		}
		if o.Symbol == "TLT" {
			hasTLT = true
		}
		if o.Symbol == "GLD" {
			hasGLD = true
		}
	}
	if hasTLT {
		t.Errorf("TLT must be skipped by guard, but a buy was placed")
	}
	if !hasGLD {
		t.Errorf("GLD must still be bought despite TLT guard rejection")
	}
}

func TestRunEntries_SkippedWhenExitLoopHadErrors(t *testing.T) {
	sigs, bars, trader, seg, regime, guard := fullStubs()
	exe, ledger := newTestExecutor(t, sigs, bars, trader, seg, regime, guard)
	// One open row whose signal fetch fails → exit error.
	row := &models.DBTrendLedgerEntry{Ticker: "USO", Status: "open", Strategy: "trend",
		EntryPrice: 70, Shares: 50, ATRAtEntry: 1, EntryDate: at1700(t, "2026-04-10")}
	_ = ledger.Save(row)
	sigs.errs["USO"] = errors.New("signal down")
	// Universe candidate TLT WOULD entry, but exits errored → entry loop aborted.
	universeIneligibleExcept(sigs, bars, "TLT", "USO")
	sigs.signals["TLT"] = goodEntrySignal("TLT")
	bars.bars["TLT"] = &interfaces.Bar{Open: 99, Close: 100}

	res, _ := exe.RunHeartbeat(context.Background(), at1700(t, "2026-05-15"))

	if len(res.Errors) == 0 {
		t.Errorf("expected exit errors")
	}
	if len(res.Entries) != 0 {
		t.Errorf("entries must be empty when exit errors occurred, got %v", res.Entries)
	}
	for _, o := range trader.placedOrders {
		if o.Side == "buy" {
			t.Errorf("no buy expected when exits errored, got %+v", o)
		}
	}
}

func TestRunEntries_TickerAlreadyHeldIsSkipped(t *testing.T) {
	sigs, bars, trader, seg, regime, guard := fullStubs()
	exe, ledger := newTestExecutor(t, sigs, bars, trader, seg, regime, guard)
	// TLT already open (no exit signal).
	row := &models.DBTrendLedgerEntry{Ticker: "TLT", Status: "open", Strategy: "trend",
		EntryPrice: 100, Shares: 10, ATRAtEntry: 1.0, EntryDate: at1700(t, "2026-04-10")}
	_ = ledger.Save(row)
	sigs.signals["TLT"] = &TrendSignal{Donchian50Low: 50}
	bars.bars["TLT"] = &interfaces.Bar{Open: 200}
	// Universe ineligible elsewhere.
	universeIneligibleExcept(sigs, bars, "TLT")

	if _, err := exe.RunHeartbeat(context.Background(), at1700(t, "2026-05-15")); err != nil {
		t.Fatalf("RunHeartbeat: %v", err)
	}
	for _, o := range trader.placedOrders {
		if o.Side == "buy" && o.Symbol == "TLT" {
			t.Errorf("TLT already held — entry loop must skip; got buy %+v", o)
		}
	}
}

func TestRunEntries_ColdStartProximityAppliedWhenNotComplete(t *testing.T) {
	sigs, bars, trader, seg, regime, guard := fullStubs()
	exe, ledger := newTestExecutor(t, sigs, bars, trader, seg, regime, guard)
	// session.ColdStartCompleted=false (default for fresh DB → executor sets to false on first run).
	// Signal: close=100, donchian=92 → distance 8, atr=1.5 → 8 > 1.5 → ineligible under coldStart.
	universeIneligibleExcept(sigs, bars, "TLT")
	sigs.signals["TLT"] = &TrendSignal{
		Ticker: "TLT", LastClose: 100, Donchian100High: 92,
		SMA200: 90, ATR20: 1.5, BarsCount: 300, Donchian50Low: 80,
	}
	bars.bars["TLT"] = &interfaces.Bar{Open: 99, Close: 100}

	if _, err := exe.RunHeartbeat(context.Background(), at1700(t, "2026-05-15")); err != nil {
		t.Fatalf("RunHeartbeat: %v", err)
	}
	for _, o := range trader.placedOrders {
		if o.Side == "buy" {
			t.Errorf("cold-start proximity must reject; got buy %+v", o)
		}
	}
	// Sanity: ledger still empty.
	open, _ := ledger.ListOpen()
	for _, r := range open {
		if r.Ticker == "TLT" {
			t.Errorf("TLT should not be in ledger under coldStart proximity reject; got %+v", r)
		}
	}
}

func TestRunEntries_ColdStartProximityNotAppliedWhenComplete(t *testing.T) {
	sigs, bars, trader, seg, regime, guard := fullStubs()
	exe, ledger := newTestExecutor(t, sigs, bars, trader, seg, regime, guard)
	// Pre-populate session with ColdStartCompleted=true.
	if err := ledger.SaveSession(&models.DBTurtleSession{
		SessionID: "singleton", LastHeartbeatDate: "2026-05-14", ColdStartCompleted: true,
	}); err != nil {
		t.Fatalf("SaveSession: %v", err)
	}
	universeIneligibleExcept(sigs, bars, "TLT")
	// Same signal as the previous test (far-above-breakout).
	sigs.signals["TLT"] = &TrendSignal{
		Ticker: "TLT", LastClose: 100, Donchian100High: 92,
		SMA200: 90, ATR20: 1.5, BarsCount: 300, Donchian50Low: 80,
	}
	bars.bars["TLT"] = &interfaces.Bar{Open: 99, Close: 100}

	if _, err := exe.RunHeartbeat(context.Background(), at1700(t, "2026-05-15")); err != nil {
		t.Fatalf("RunHeartbeat: %v", err)
	}
	var buy *interfaces.Order
	for _, o := range trader.placedOrders {
		if o.Side == "buy" && o.Symbol == "TLT" {
			buy = o
			break
		}
	}
	if buy == nil {
		t.Errorf("after coldStart complete, far-above-breakout entries proceed; got no buy")
	}
}

func TestRunEntries_RegimeZeroMultiplierSkips(t *testing.T) {
	sigs, bars, trader, seg, regime, guard := fullStubs()
	// SizingMultiplier=0 but BlockNewEntries=false (hypothetical) — entries proceed
	// past the regime gate, but computePositionDollars returns 0 → skip.
	regime.status.SizingMultiplier = 0.0
	universeIneligibleExcept(sigs, bars, "TLT")
	sigs.signals["TLT"] = goodEntrySignal("TLT")
	bars.bars["TLT"] = &interfaces.Bar{Open: 99, Close: 100}
	exe, _ := newTestExecutor(t, sigs, bars, trader, seg, regime, guard)

	if _, err := exe.RunHeartbeat(context.Background(), at1700(t, "2026-05-15")); err != nil {
		t.Fatalf("RunHeartbeat: %v", err)
	}
	for _, o := range trader.placedOrders {
		if o.Side == "buy" {
			t.Errorf("zero multiplier must skip entries, got %+v", o)
		}
	}
}

func TestRunEntries_TooSmallToBuyOneShareSkips(t *testing.T) {
	sigs, bars, trader, seg, regime, guard := fullStubs()
	// Portfolio too small for even 1 share at $100 last_close: $100 portfolio
	// → 0.5% risk = $0.50; with ATR=5 → dollars = $0.50/($10/$100) = $5;
	// shares = $5/$100 = 0. Skip.
	trader.account = &interfaces.Account{PortfolioValue: 100, LastEquity: 100}
	universeIneligibleExcept(sigs, bars, "TLT")
	sigs.signals["TLT"] = goodEntrySignal("TLT")
	bars.bars["TLT"] = &interfaces.Bar{Open: 99, Close: 100}
	exe, _ := newTestExecutor(t, sigs, bars, trader, seg, regime, guard)

	if _, err := exe.RunHeartbeat(context.Background(), at1700(t, "2026-05-15")); err != nil {
		t.Fatalf("RunHeartbeat: %v", err)
	}
	for _, o := range trader.placedOrders {
		if o.Side == "buy" {
			t.Errorf("too small to buy 1 share should skip, got %+v", o)
		}
	}
}

// ---- Full RunHeartbeat happy path ----

func TestRunHeartbeat_HappyPath_OneEntryOneExit(t *testing.T) {
	sigs, bars, trader, seg, regime, guard := fullStubs()
	exe, ledger := newTestExecutor(t, sigs, bars, trader, seg, regime, guard)
	// Existing GLD position fires trailing exit.
	exitRow := &models.DBTrendLedgerEntry{Ticker: "GLD", Status: "open", Strategy: "trend",
		EntryPrice: 200, Shares: 50, ATRAtEntry: 2.0, EntryDate: at1700(t, "2026-04-10")}
	_ = ledger.Save(exitRow)
	sigs.signals["GLD"] = &TrendSignal{Donchian50Low: 195}
	bars.bars["GLD"] = &interfaces.Bar{Open: 190}
	// TLT entry candidate.
	sigs.signals["TLT"] = goodEntrySignal("TLT")
	bars.bars["TLT"] = &interfaces.Bar{Open: 99, Close: 100}
	universeIneligibleExcept(sigs, bars, "TLT", "GLD")

	now := at1700(t, "2026-05-15")
	res, err := exe.RunHeartbeat(context.Background(), now)
	if err != nil {
		t.Fatalf("RunHeartbeat: %v", err)
	}

	var hasSell, hasBuy bool
	for _, o := range trader.placedOrders {
		if o.Symbol == "GLD" && o.Side == "sell" && o.Strategy == "trend" {
			hasSell = true
		}
		if o.Symbol == "TLT" && o.Side == "buy" && o.Strategy == "trend" {
			hasBuy = true
		}
	}
	if !hasSell {
		t.Errorf("expected GLD sell")
	}
	if !hasBuy {
		t.Errorf("expected TLT buy")
	}
	if len(res.Exits) != 1 || res.Exits[0] != "GLD" {
		t.Errorf("res.Exits got %v, want [GLD]", res.Exits)
	}
	if len(res.Entries) != 1 || res.Entries[0] != "TLT" {
		t.Errorf("res.Entries got %v, want [TLT]", res.Entries)
	}
	// Session row created with today.
	sess, _ := ledger.Session()
	if sess == nil || sess.LastHeartbeatDate != "2026-05-15" {
		t.Errorf("session not updated; got %+v", sess)
	}
}

// ---- Cold-start completion ----

func TestColdStartFlippedToTrueAfterFirstEntry(t *testing.T) {
	sigs, bars, trader, seg, regime, guard := fullStubs()
	exe, ledger := newTestExecutor(t, sigs, bars, trader, seg, regime, guard)
	universeIneligibleExcept(sigs, bars, "TLT")
	sigs.signals["TLT"] = goodEntrySignal("TLT")
	bars.bars["TLT"] = &interfaces.Bar{Open: 99, Close: 100}

	if _, err := exe.RunHeartbeat(context.Background(), at1700(t, "2026-05-15")); err != nil {
		t.Fatalf("RunHeartbeat: %v", err)
	}
	sess, _ := ledger.Session()
	if sess == nil {
		t.Fatal("session must exist")
	}
	if !sess.ColdStartCompleted {
		t.Errorf("ColdStartCompleted must flip to true after first successful entry placement")
	}
}

func TestColdStartStaysFalseWhenNoEntryPlaced(t *testing.T) {
	sigs, bars, trader, seg, regime, guard := fullStubs()
	exe, ledger := newTestExecutor(t, sigs, bars, trader, seg, regime, guard)
	// All universe tickers ineligible.
	for _, sym := range universeTickers() {
		sigs.signals[sym] = &TrendSignal{Ticker: sym, LastClose: 50, Donchian100High: 60, BarsCount: 300}
		bars.bars[sym] = &interfaces.Bar{Open: 50}
	}

	if _, err := exe.RunHeartbeat(context.Background(), at1700(t, "2026-05-15")); err != nil {
		t.Fatalf("RunHeartbeat: %v", err)
	}
	sess, _ := ledger.Session()
	if sess == nil {
		t.Fatal("session must exist")
	}
	if sess.ColdStartCompleted {
		t.Errorf("ColdStartCompleted must stay false when no entry placed")
	}
}

// ---- Reconciliation ----

// fp returns a pointer to a float64 — used for FilledAvgPrice fields.
func fp(v float64) *float64 { return &v }

func TestReconcile_FilledFlipsToOpen(t *testing.T) {
	sigs, bars, trader, seg, regime, guard := fullStubs()
	for _, sym := range universeTickers() {
		sigs.signals[sym] = &TrendSignal{Ticker: sym, LastClose: 50, Donchian100High: 60, BarsCount: 300}
		bars.bars[sym] = &interfaces.Bar{Open: 50, Close: 50}
	}
	exe, ledger := newTestExecutor(t, sigs, bars, trader, seg, regime, guard)

	pending := &models.DBTrendLedgerEntry{
		Ticker: "TLT", Status: "pending_fill", Strategy: "trend",
		EntryOrderID: "ord-mon", ATRAtEntry: 1.5, EntryPrice: 90.0, Shares: 100,
	}
	if err := ledger.Save(pending); err != nil {
		t.Fatalf("Save pending: %v", err)
	}
	trader.getOrderResponses["ord-mon"] = &interfaces.Order{
		Status: "filled", FilledQty: 100, FilledAvgPrice: fp(92.62),
	}

	now := at1700(t, "2026-05-15")
	if _, err := exe.RunHeartbeat(context.Background(), now); err != nil {
		t.Fatalf("RunHeartbeat: %v", err)
	}

	got, err := ledger.GetByID(pending.ID)
	if err != nil {
		t.Fatalf("GetByID: %v", err)
	}
	if got.Status != "open" {
		t.Errorf("Status: got %q, want open", got.Status)
	}
	if got.EntryPrice != 92.62 {
		t.Errorf("EntryPrice: got %v, want 92.62", got.EntryPrice)
	}
	if got.Shares != 100 {
		t.Errorf("Shares: got %d, want 100", got.Shares)
	}
	wantStop := 92.62 - 2*1.5
	if math.Abs(got.InitialStop-wantStop) > 0.001 {
		t.Errorf("InitialStop: got %v, want %v", got.InitialStop, wantStop)
	}
}

func TestReconcile_PartiallyFilledFlipsToOpenWithReducedShares(t *testing.T) {
	sigs, bars, trader, seg, regime, guard := fullStubs()
	for _, sym := range universeTickers() {
		sigs.signals[sym] = &TrendSignal{Ticker: sym, LastClose: 50, Donchian100High: 60, BarsCount: 300}
		bars.bars[sym] = &interfaces.Bar{Open: 50, Close: 50}
	}
	exe, ledger := newTestExecutor(t, sigs, bars, trader, seg, regime, guard)

	pending := &models.DBTrendLedgerEntry{
		Ticker: "GLD", Status: "pending_fill", Strategy: "trend",
		EntryOrderID: "ord-gld", ATRAtEntry: 2.0, EntryPrice: 200.0, Shares: 100,
	}
	if err := ledger.Save(pending); err != nil {
		t.Fatalf("Save: %v", err)
	}
	trader.getOrderResponses["ord-gld"] = &interfaces.Order{
		Status: "partially_filled", FilledQty: 60, FilledAvgPrice: fp(199.50),
	}

	if _, err := exe.RunHeartbeat(context.Background(), at1700(t, "2026-05-15")); err != nil {
		t.Fatalf("RunHeartbeat: %v", err)
	}

	got, _ := ledger.GetByID(pending.ID)
	if got.Status != "open" {
		t.Errorf("Status: got %q, want open", got.Status)
	}
	if got.Shares != 60 {
		t.Errorf("Shares: got %d, want 60", got.Shares)
	}
	if got.EntryPrice != 199.50 {
		t.Errorf("EntryPrice: got %v, want 199.50", got.EntryPrice)
	}
}

func TestReconcile_ExpiredClosesAsMissedEntry(t *testing.T) {
	sigs, bars, trader, seg, regime, guard := fullStubs()
	exe, ledger := newTestExecutor(t, sigs, bars, trader, seg, regime, guard)

	pending := &models.DBTrendLedgerEntry{
		Ticker: "USO", Status: "pending_fill", Strategy: "trend",
		EntryOrderID: "ord-uso",
	}
	if err := ledger.Save(pending); err != nil {
		t.Fatalf("Save: %v", err)
	}
	trader.getOrderResponses["ord-uso"] = &interfaces.Order{Status: "expired"}

	if _, err := exe.RunHeartbeat(context.Background(), at1700(t, "2026-05-15")); err != nil {
		t.Fatalf("RunHeartbeat: %v", err)
	}

	got, _ := ledger.GetByID(pending.ID)
	if got.Status != "closed" {
		t.Errorf("Status: got %q, want closed", got.Status)
	}
	if got.ExitReason != "missed_entry" {
		t.Errorf("ExitReason: got %q, want missed_entry", got.ExitReason)
	}
	if got.ExitDate == nil {
		t.Errorf("ExitDate must be set")
	}
}

func TestReconcile_CanceledClosesAsMissedEntry(t *testing.T) {
	sigs, bars, trader, seg, regime, guard := fullStubs()
	exe, ledger := newTestExecutor(t, sigs, bars, trader, seg, regime, guard)

	pending := &models.DBTrendLedgerEntry{
		Ticker: "DBC", Status: "pending_fill", Strategy: "trend",
		EntryOrderID: "ord-dbc",
	}
	if err := ledger.Save(pending); err != nil {
		t.Fatalf("Save: %v", err)
	}
	trader.getOrderResponses["ord-dbc"] = &interfaces.Order{Status: "canceled"}

	if _, err := exe.RunHeartbeat(context.Background(), at1700(t, "2026-05-15")); err != nil {
		t.Fatalf("RunHeartbeat: %v", err)
	}
	got, _ := ledger.GetByID(pending.ID)
	if got.Status != "closed" || got.ExitReason != "missed_entry" {
		t.Errorf("got status=%q reason=%q, want closed/missed_entry", got.Status, got.ExitReason)
	}
}

func TestReconcile_WorkingLeavesPending(t *testing.T) {
	sigs, bars, trader, seg, regime, guard := fullStubs()
	exe, ledger := newTestExecutor(t, sigs, bars, trader, seg, regime, guard)

	pending := &models.DBTrendLedgerEntry{
		Ticker: "TLT", Status: "pending_fill", Strategy: "trend",
		EntryOrderID: "ord-tlt",
	}
	if err := ledger.Save(pending); err != nil {
		t.Fatalf("Save: %v", err)
	}
	trader.getOrderResponses["ord-tlt"] = &interfaces.Order{Status: "new"}

	if _, err := exe.RunHeartbeat(context.Background(), at1700(t, "2026-05-15")); err != nil {
		t.Fatalf("RunHeartbeat: %v", err)
	}
	got, _ := ledger.GetByID(pending.ID)
	if got.Status != "pending_fill" {
		t.Errorf("Status: got %q, want pending_fill (still working)", got.Status)
	}
}

func TestReconcile_NilFilledAvgPriceSkipsUpdate(t *testing.T) {
	sigs, bars, trader, seg, regime, guard := fullStubs()
	exe, ledger := newTestExecutor(t, sigs, bars, trader, seg, regime, guard)

	pending := &models.DBTrendLedgerEntry{
		Ticker: "TLT", Status: "pending_fill", Strategy: "trend",
		EntryOrderID: "ord-tlt", ATRAtEntry: 1.5,
	}
	if err := ledger.Save(pending); err != nil {
		t.Fatalf("Save: %v", err)
	}
	trader.getOrderResponses["ord-tlt"] = &interfaces.Order{
		Status: "filled", FilledQty: 100, FilledAvgPrice: nil,
	}

	res, err := exe.RunHeartbeat(context.Background(), at1700(t, "2026-05-15"))
	if err != nil {
		t.Fatalf("RunHeartbeat: %v", err)
	}
	got, _ := ledger.GetByID(pending.ID)
	if got.Status != "pending_fill" {
		t.Errorf("Status: got %q, want pending_fill (malformed response → skip update)", got.Status)
	}
	if len(res.Errors) == 0 {
		t.Errorf("expected an error entry for nil FilledAvgPrice, got none")
	}
}

func TestReconcile_MissedDayRecoversNextDay(t *testing.T) {
	// Operator-requested test: Monday 17:00 ET placed order ord-mon.
	// Tuesday's beat is missed entirely (bot down). Wednesday 17:00 ET, the
	// previously placed order is now "expired". Verify the reconciliation
	// step closes the row cleanly.
	sigs, bars, trader, seg, regime, guard := fullStubs()
	exe, ledger := newTestExecutor(t, sigs, bars, trader, seg, regime, guard)

	monday, _ := time.Parse(time.RFC3339, "2026-05-11T17:00:00-04:00")
	pending := &models.DBTrendLedgerEntry{
		Ticker: "TLT", Status: "pending_fill", Strategy: "trend",
		EntryOrderID: "ord-mon", EntryDate: monday,
	}
	if err := ledger.Save(pending); err != nil {
		t.Fatalf("Save: %v", err)
	}
	trader.getOrderResponses["ord-mon"] = &interfaces.Order{Status: "expired"}

	wednesday := at1700(t, "2026-05-13")
	if _, err := exe.RunHeartbeat(context.Background(), wednesday); err != nil {
		t.Fatalf("RunHeartbeat: %v", err)
	}

	got, _ := ledger.GetByID(pending.ID)
	if got.Status != "closed" {
		t.Errorf("missed-day recovery: status got %q, want closed", got.Status)
	}
	if got.ExitReason != "missed_entry" {
		t.Errorf("ExitReason: got %q, want missed_entry", got.ExitReason)
	}
}

func TestRunHeartbeat_FirstRunCreatesSession(t *testing.T) {
	sigs, bars, trader, seg, regime, guard := fullStubs()
	// All universe tickers produce ineligible signals so no entry is placed —
	// keeps the test focused on the session-creation behavior.
	for _, sym := range universeTickers() {
		sigs.signals[sym] = &TrendSignal{Ticker: sym, LastClose: 50, Donchian100High: 60, BarsCount: 300}
		bars.bars[sym] = &interfaces.Bar{Open: 50, Close: 50}
	}
	exe, ledger := newTestExecutor(t, sigs, bars, trader, seg, regime, guard)

	now := at1700(t, "2026-05-15")
	res, err := exe.RunHeartbeat(context.Background(), now)
	if err != nil {
		t.Fatalf("RunHeartbeat err: %v", err)
	}
	if res.Skipped != "" {
		t.Errorf("first-run in-window should not skip, got %q", res.Skipped)
	}

	sess, err := ledger.Session()
	if err != nil {
		t.Fatalf("Session: %v", err)
	}
	if sess == nil {
		t.Fatal("session should be created on first run")
	}
	if sess.SessionID != "singleton" {
		t.Errorf("SessionID: got %q, want singleton", sess.SessionID)
	}
	if sess.LastHeartbeatDate != "2026-05-15" {
		t.Errorf("LastHeartbeatDate: got %q, want 2026-05-15", sess.LastHeartbeatDate)
	}
}

// synthCloses builds a price series of len(rets)+1 starting at 100 whose
// per-step simple returns equal sign*rets[i]. Using sign=+1 vs sign=-1 on the
// same rets yields two series that are perfectly (anti-)correlated.
func synthCloses(rets []float64, sign float64) []float64 {
	closes := make([]float64, len(rets)+1)
	closes[0] = 100.0
	for i, r := range rets {
		closes[i+1] = closes[i] * (1 + sign*r)
	}
	return closes
}

// varyingReturns returns n deterministic, non-constant daily returns (so the
// resulting close series has non-zero variance and a defined correlation).
func varyingReturns(n int) []float64 {
	out := make([]float64, n)
	for i := range out {
		out[i] = 0.006 + 0.004*math.Sin(float64(i)) // ranges ~[0.002, 0.010]
	}
	return out
}

// corrEntrySignal returns a valid breakout signal (passes evaluateEntry with
// coldStart, anti-cap sizing) carrying the given close series for the
// correlation guard.
func corrEntrySignal(ticker string, closes []float64) *TrendSignal {
	sig := goodEntrySignal(ticker)
	sig.Closes = closes
	return sig
}

func TestRunEntries_SecondSameClusterBreakoutBlockedByClusterCap(t *testing.T) {
	sigs, bars, trader, seg, regime, guard := fullStubs()
	exe, ledger := newTestExecutor(t, sigs, bars, trader, seg, regime, guard)
	// One open rates position (TLT); IEF is also rates → cluster slot taken.
	row := &models.DBTrendLedgerEntry{Ticker: "TLT", Status: "open", Strategy: "trend",
		EntryPrice: 100, Shares: 1, ATRAtEntry: 0.01, EntryDate: at1700(t, "2026-04-10")}
	_ = ledger.Save(row)
	sigs.signals["TLT"] = &TrendSignal{Donchian50Low: 50} // hold, no exit
	bars.bars["TLT"] = &interfaces.Bar{Open: 200}
	universeIneligibleExcept(sigs, bars, "TLT", "IEF")
	sigs.signals["IEF"] = goodEntrySignal("IEF")
	bars.bars["IEF"] = &interfaces.Bar{Open: 99, Close: 100}

	res, err := exe.RunHeartbeat(context.Background(), at1700(t, "2026-05-15"))
	if err != nil {
		t.Fatalf("RunHeartbeat: %v", err)
	}
	for _, o := range trader.placedOrders {
		if o.Side == "buy" && o.Symbol == "IEF" {
			t.Errorf("IEF (rates) must be blocked — rates cluster already holds TLT")
		}
	}
	foundCluster := false
	for _, s := range res.Skips {
		if strings.Contains(s, "IEF") && containsCaseInsensitive(s, "cluster") {
			foundCluster = true
		}
	}
	if !foundCluster {
		t.Errorf("expected an IEF cluster-cap skip, got %v", res.Skips)
	}
}

func TestRunEntries_DifferentClusterBreakoutAllowed(t *testing.T) {
	sigs, bars, trader, seg, regime, guard := fullStubs()
	exe, ledger := newTestExecutor(t, sigs, bars, trader, seg, regime, guard)
	// One open rates position (TLT); GLD is metals → different cluster → allowed.
	row := &models.DBTrendLedgerEntry{Ticker: "TLT", Status: "open", Strategy: "trend",
		EntryPrice: 100, Shares: 1, ATRAtEntry: 0.01, EntryDate: at1700(t, "2026-04-10")}
	_ = ledger.Save(row)
	sigs.signals["TLT"] = &TrendSignal{Donchian50Low: 50}
	bars.bars["TLT"] = &interfaces.Bar{Open: 200}
	universeIneligibleExcept(sigs, bars, "TLT", "GLD")
	sigs.signals["GLD"] = goodEntrySignal("GLD")
	bars.bars["GLD"] = &interfaces.Bar{Open: 99, Close: 100}

	if _, err := exe.RunHeartbeat(context.Background(), at1700(t, "2026-05-15")); err != nil {
		t.Fatalf("RunHeartbeat: %v", err)
	}
	hasGLD := false
	for _, o := range trader.placedOrders {
		if o.Side == "buy" && o.Symbol == "GLD" {
			hasGLD = true
		}
	}
	if !hasGLD {
		t.Errorf("GLD (metals) must be allowed — different cluster from open TLT (rates)")
	}
}

func TestRunEntries_SameBeatSecondSameClusterBlocked(t *testing.T) {
	sigs, bars, trader, seg, regime, guard := fullStubs()
	exe, _ := newTestExecutor(t, sigs, bars, trader, seg, regime, guard)
	// No open positions. TLT and IEF are both rates and both break out this
	// beat. The first by iteration order (TLT) enters; the second (IEF) is
	// blocked by the cluster cap counting the same-beat entry.
	universeIneligibleExcept(sigs, bars, "TLT", "IEF")
	sigs.signals["TLT"] = goodEntrySignal("TLT")
	bars.bars["TLT"] = &interfaces.Bar{Open: 99, Close: 100}
	sigs.signals["IEF"] = goodEntrySignal("IEF")
	bars.bars["IEF"] = &interfaces.Bar{Open: 99, Close: 100}

	if _, err := exe.RunHeartbeat(context.Background(), at1700(t, "2026-05-15")); err != nil {
		t.Fatalf("RunHeartbeat: %v", err)
	}
	var ratesBuys []string
	for _, o := range trader.placedOrders {
		if o.Side == "buy" && (o.Symbol == "TLT" || o.Symbol == "IEF") {
			ratesBuys = append(ratesBuys, o.Symbol)
		}
	}
	if len(ratesBuys) != 1 {
		t.Errorf("exactly one rates entry expected this beat, got %v", ratesBuys)
	}
}

func TestRunEntries_HighlyCorrelatedCrossClusterBreakoutSkipped(t *testing.T) {
	sigs, bars, trader, seg, regime, guard := fullStubs()
	exe, ledger := newTestExecutor(t, sigs, bars, trader, seg, regime, guard)
	rets := varyingReturns(80)
	// Open EEM (intl_equity) with a known return series; DBC (commodity) is a
	// DIFFERENT cluster (cluster cap won't fire) but perfectly +correlated.
	row := &models.DBTrendLedgerEntry{Ticker: "EEM", Status: "open", Strategy: "trend",
		EntryPrice: 100, Shares: 1, ATRAtEntry: 0.01, EntryDate: at1700(t, "2026-04-10")}
	_ = ledger.Save(row)
	eemSig := &TrendSignal{Donchian50Low: 50, Closes: synthCloses(rets, +1)} // hold, no exit
	sigs.signals["EEM"] = eemSig
	bars.bars["EEM"] = &interfaces.Bar{Open: 200}
	universeIneligibleExcept(sigs, bars, "EEM", "DBC")
	sigs.signals["DBC"] = corrEntrySignal("DBC", synthCloses(rets, +1)) // identical returns → ρ=+1
	bars.bars["DBC"] = &interfaces.Bar{Open: 99, Close: 100}

	res, err := exe.RunHeartbeat(context.Background(), at1700(t, "2026-05-15"))
	if err != nil {
		t.Fatalf("RunHeartbeat: %v", err)
	}
	for _, o := range trader.placedOrders {
		if o.Side == "buy" && o.Symbol == "DBC" {
			t.Errorf("DBC must be blocked by the correlation guard (ρ=+1 vs open EEM)")
		}
	}
	foundCorr := false
	for _, s := range res.Skips {
		if strings.Contains(s, "DBC") && containsCaseInsensitive(s, "correlation") {
			foundCorr = true
		}
	}
	if !foundCorr {
		t.Errorf("expected a DBC correlation-guard skip, got %v", res.Skips)
	}
}

func TestRunEntries_AntiCorrelatedBreakoutAllowed(t *testing.T) {
	sigs, bars, trader, seg, regime, guard := fullStubs()
	exe, ledger := newTestExecutor(t, sigs, bars, trader, seg, regime, guard)
	rets := varyingReturns(80)
	// Open EEM with a return series; UUP (fx) is anti-correlated → allowed.
	row := &models.DBTrendLedgerEntry{Ticker: "EEM", Status: "open", Strategy: "trend",
		EntryPrice: 100, Shares: 1, ATRAtEntry: 0.01, EntryDate: at1700(t, "2026-04-10")}
	_ = ledger.Save(row)
	sigs.signals["EEM"] = &TrendSignal{Donchian50Low: 50, Closes: synthCloses(rets, +1)}
	bars.bars["EEM"] = &interfaces.Bar{Open: 200}
	universeIneligibleExcept(sigs, bars, "EEM", "UUP")
	sigs.signals["UUP"] = corrEntrySignal("UUP", synthCloses(rets, -1)) // negated returns → ρ=-1
	bars.bars["UUP"] = &interfaces.Bar{Open: 99, Close: 100}

	if _, err := exe.RunHeartbeat(context.Background(), at1700(t, "2026-05-15")); err != nil {
		t.Fatalf("RunHeartbeat: %v", err)
	}
	hasUUP := false
	for _, o := range trader.placedOrders {
		if o.Side == "buy" && o.Symbol == "UUP" {
			hasUUP = true
		}
	}
	if !hasUUP {
		t.Errorf("UUP must be allowed — anti-correlated (ρ=-1) with open EEM is diversifying")
	}
}

func TestRunEntries_InsufficientCorrelationHistoryAllowsEntry(t *testing.T) {
	sigs, bars, trader, seg, regime, guard := fullStubs()
	exe, ledger := newTestExecutor(t, sigs, bars, trader, seg, regime, guard)
	// Open EEM whose Closes series is too short to assess (< window+1). The
	// candidate DBC has a full series, but with no assessable open pair the
	// guard cannot block → DBC enters (cluster + agg-risk still bound it).
	row := &models.DBTrendLedgerEntry{Ticker: "EEM", Status: "open", Strategy: "trend",
		EntryPrice: 100, Shares: 1, ATRAtEntry: 0.01, EntryDate: at1700(t, "2026-04-10")}
	_ = ledger.Save(row)
	sigs.signals["EEM"] = &TrendSignal{Donchian50Low: 50, Closes: []float64{100, 101, 102}}
	bars.bars["EEM"] = &interfaces.Bar{Open: 200}
	universeIneligibleExcept(sigs, bars, "EEM", "DBC")
	sigs.signals["DBC"] = corrEntrySignal("DBC", synthCloses(varyingReturns(80), +1))
	bars.bars["DBC"] = &interfaces.Bar{Open: 99, Close: 100}

	if _, err := exe.RunHeartbeat(context.Background(), at1700(t, "2026-05-15")); err != nil {
		t.Fatalf("RunHeartbeat: %v", err)
	}
	hasDBC := false
	for _, o := range trader.placedOrders {
		if o.Side == "buy" && o.Symbol == "DBC" {
			hasDBC = true
		}
	}
	if !hasDBC {
		t.Errorf("DBC must enter — open EEM history too short to assess correlation")
	}
}

func TestRunEntries_PopulatesReasoningForEntry(t *testing.T) {
	sigs, bars, trader, seg, regime, guard := fullStubs()
	universeIneligibleExcept(sigs, bars, "TLT")
	sigs.signals["TLT"] = goodEntrySignal("TLT")
	bars.bars["TLT"] = &interfaces.Bar{Open: 99, Close: 100}
	exe, _ := newTestExecutor(t, sigs, bars, trader, seg, regime, guard)

	res, err := exe.RunHeartbeat(context.Background(), at1700(t, "2026-05-15"))
	if err != nil {
		t.Fatalf("RunHeartbeat: %v", err)
	}

	var tlt *TickerRationale
	for i := range res.Reasoning {
		if res.Reasoning[i].Ticker == "TLT" {
			tlt = &res.Reasoning[i]
			break
		}
	}
	if tlt == nil {
		t.Fatalf("expected a TLT rationale, got %d entries", len(res.Reasoning))
	}
	if !tlt.SetupQualified {
		t.Error("TLT SetupQualified = false, want true")
	}
	if !tlt.Taken {
		t.Error("TLT Taken = false, want true")
	}
	if !strings.Contains(tlt.Line, "ENTER") {
		t.Errorf("TLT Line = %q, want it to contain ENTER", tlt.Line)
	}
}
