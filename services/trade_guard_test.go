package services

import (
	"context"
	"errors"
	"prophet-trader/interfaces"
	"testing"
	"time"

	"github.com/sirupsen/logrus/hooks/test"
)

// --- stubs ---

type stubLister struct {
	positions []*ManagedPosition
}

type stubOptionsProvider struct {
	exposure map[SectorBucket]float64
}

func (s *stubOptionsProvider) BucketExposureDollars() map[SectorBucket]float64 {
	return s.exposure
}

func (s *stubLister) ListManagedPositions(_ string) []*ManagedPosition {
	return s.positions
}

type stubTrading struct {
	portfolio    float64
	lastEquity   float64
	cash         float64
	getAcctCalls int
	getAcctErr   error
}

func (s *stubTrading) GetAccount(_ context.Context) (*interfaces.Account, error) {
	s.getAcctCalls++
	if s.getAcctErr != nil {
		return nil, s.getAcctErr
	}
	return &interfaces.Account{PortfolioValue: s.portfolio, LastEquity: s.lastEquity, Cash: s.cash}, nil
}
func (s *stubTrading) PlaceOrder(_ context.Context, _ *interfaces.Order) (*interfaces.OrderResult, error) {
	return nil, nil
}
func (s *stubTrading) CancelOrder(_ context.Context, _ string) error { return nil }
func (s *stubTrading) GetOrder(_ context.Context, _ string) (*interfaces.Order, error) {
	return nil, nil
}
func (s *stubTrading) ListOrders(_ context.Context, _ string) ([]*interfaces.Order, error) {
	return nil, nil
}
func (s *stubTrading) GetPositions(_ context.Context) ([]*interfaces.Position, error) {
	return nil, nil
}
func (s *stubTrading) ClosePosition(_ context.Context, _ string, _ float64) (*interfaces.OrderResult, error) {
	return &interfaces.OrderResult{}, nil
}
func (s *stubTrading) PlaceOptionsOrder(_ context.Context, _ *interfaces.OptionsOrder) (*interfaces.OrderResult, error) {
	return nil, nil
}
func (s *stubTrading) GetOptionsChain(_ context.Context, _ string, _ time.Time) ([]*interfaces.OptionContract, error) {
	return nil, nil
}
func (s *stubTrading) GetOptionsQuote(_ context.Context, _ string) (*interfaces.OptionsQuote, error) {
	return nil, nil
}
func (s *stubTrading) GetOptionsPosition(_ context.Context, _ string) (*interfaces.OptionsPosition, error) {
	return nil, nil
}
func (s *stubTrading) ListOptionsPositions(_ context.Context) ([]*interfaces.OptionsPosition, error) {
	return nil, nil
}

// --- helpers ---

func managedPos(symbol string, agent AgentSource, status string, allocation float64) *ManagedPosition {
	return &ManagedPosition{
		Symbol:            symbol,
		Status:            status,
		AllocationDollars: allocation,
		Tags:              []string{AgentTag(agent)},
	}
}

func defaultConfig() TradeGuardConfig {
	return TradeGuardConfig{}
}

func sectorConfig() TradeGuardConfig {
	cfg := defaultConfig()
	cfg.EnableSectorAggregation = true
	cfg.SectorMaxExposurePct = map[string]float64{
		"TECH":       0.20,
		"INDEX_BETA": 0.25,
		"ENERGY":     0.15,
		"FINANCIALS": 0.15,
		"HEALTHCARE": 0.15,
		"OTHER":      0.15,
	}
	cfg.DefaultSectorMaxPct = 0.15
	return cfg
}

// --- tests ---

func TestGuard_ClosedPositionNotConflict(t *testing.T) {
	lister := &stubLister{
		positions: []*ManagedPosition{
			managedPos("AAPL", AgentMain, "CLOSED", 1000),
		},
	}
	g := NewTradeGuard(lister, &stubTrading{portfolio: 10000}, defaultConfig())
	err := g.CheckBuy(context.Background(), AgentMain, "AAPL", 100)
	if err != nil {
		t.Fatalf("closed position should not block: %v", err)
	}
}

func TestGuard_SellAllowedWhenOwned(t *testing.T) {
	lister := &stubLister{
		positions: []*ManagedPosition{
			managedPos("TSLA", AgentMain, "ACTIVE", 1000),
		},
	}
	g := NewTradeGuard(lister, nil, defaultConfig())
	err := g.CheckSell(context.Background(), AgentMain, "TSLA")
	if err != nil {
		t.Fatalf("expected no error when agent sells owned symbol: %v", err)
	}
}

func TestGuard_RawOrderTracking(t *testing.T) {
	g := NewTradeGuard(&stubLister{}, nil, defaultConfig())
	g.RecordRawBuy(AgentMain, "NVDA")

	// Drift should not be able to buy NVDA now (Main owns it)
	err := g.CheckBuy(context.Background(), AgentDrift, "NVDA", 100)
	if err == nil {
		t.Fatal("expected error: drift cannot buy raw-main symbol")
	}

	// After main sells, drift should be able to buy
	g.RecordRawSell(AgentMain, "NVDA")
	err = g.CheckBuy(context.Background(), AgentDrift, "NVDA", 100)
	if err != nil {
		t.Fatalf("expected no error after raw sell: %v", err)
	}
}

func TestGuard_UntaggedPositionTreatedAsMain(t *testing.T) {
	// Legacy position with no agent tag should be owned by main
	lister := &stubLister{
		positions: []*ManagedPosition{
			{Symbol: "IBM", Status: "ACTIVE", AllocationDollars: 500, Tags: []string{}},
		},
	}
	g := NewTradeGuard(lister, nil, defaultConfig())
	// Drift should not be able to buy IBM (Main owns it via untagged position)
	err := g.CheckBuy(context.Background(), AgentDrift, "IBM", 100)
	if err == nil {
		t.Fatal("expected error: untagged position should block drift")
	}
}

func TestGuard_EmptyAgentSourceDefaultsToMain(t *testing.T) {
	lister := &stubLister{
		positions: []*ManagedPosition{
			managedPos("GOOG", AgentMain, "ACTIVE", 200),
		},
	}
	g := NewTradeGuard(lister, nil, defaultConfig())
	// Empty agent source = main; drift holds GOOG → should block
	err := g.CheckBuy(context.Background(), AgentDrift, "GOOG", 500)
	if err == nil {
		t.Fatal("expected error: empty agent treated as main, drift cannot buy main symbol")
	}
}

func TestGuard_DailyLossCircuitBreakerTriggers(t *testing.T) {
	cfg := defaultConfig()
	cfg.MaxDailyLossPct = 5.0
	// Down 6% from previous close: 100000 → 94000
	g := NewTradeGuard(&stubLister{}, &stubTrading{portfolio: 94000, lastEquity: 100000}, cfg)
	if err := g.CheckBuy(context.Background(), AgentMain, "AAPL", 500); err == nil {
		t.Fatal("expected error: daily loss circuit breaker should block at -6% with 5% limit")
	}
	if err := g.CheckBuy(context.Background(), AgentDrift, "ABCD", 100); err == nil {
		t.Fatal("expected error: circuit breaker also applies to drift agent")
	}
}

func TestGuard_DailyLossWithinLimitAllowed(t *testing.T) {
	cfg := defaultConfig()
	cfg.MaxDailyLossPct = 5.0
	// Down 3% — within limit
	g := NewTradeGuard(&stubLister{}, &stubTrading{portfolio: 97000, lastEquity: 100000}, cfg)
	if err := g.CheckBuy(context.Background(), AgentMain, "AAPL", 500); err != nil {
		t.Fatalf("unexpected error within daily-loss limit: %v", err)
	}
}

func TestGuard_DailyLossDisabledWhenZero(t *testing.T) {
	cfg := defaultConfig() // MaxDailyLossPct defaults to 0
	g := NewTradeGuard(&stubLister{}, &stubTrading{portfolio: 50000, lastEquity: 100000}, cfg)
	// Down 50%, but check is disabled — should pass
	if err := g.CheckBuy(context.Background(), AgentMain, "AAPL", 500); err != nil {
		t.Fatalf("daily loss check should be disabled when MaxDailyLossPct is 0: %v", err)
	}
}

func TestGuard_DailyLossSkippedWhenLastEquityMissing(t *testing.T) {
	cfg := defaultConfig()
	cfg.MaxDailyLossPct = 5.0
	// LastEquity = 0 (e.g. brand-new account); fail-open
	g := NewTradeGuard(&stubLister{}, &stubTrading{portfolio: 50000, lastEquity: 0}, cfg)
	if err := g.CheckBuy(context.Background(), AgentMain, "AAPL", 500); err != nil {
		t.Fatalf("daily loss check should fail-open when LastEquity is unknown: %v", err)
	}
}

func TestGuard_DailyLossSkippedWhenTradingServiceNil(t *testing.T) {
	cfg := defaultConfig()
	cfg.MaxDailyLossPct = 5.0
	// No trading service available — must not block trades
	g := NewTradeGuard(&stubLister{}, nil, cfg)
	if err := g.CheckBuy(context.Background(), AgentMain, "AAPL", 0); err != nil {
		t.Fatalf("daily loss check should be skipped when tradingService is nil: %v", err)
	}
}

func TestGuard_CheckBuyFetchesAccountAtMostOnce(t *testing.T) {
	cfg := defaultConfig()
	cfg.MaxDailyLossPct = 5.0
	stub := &stubTrading{portfolio: 100000, lastEquity: 100000}
	g := NewTradeGuard(&stubLister{}, stub, cfg)
	// CheckBuy with sector cap enabled goes through both checkDailyLoss AND checkSectorCap —
	// without the single-fetch refactor, this would call GetAccount twice.
	if err := g.CheckBuy(context.Background(), AgentMain, "ABCD", 100); err != nil {
		t.Fatalf("unexpected error on healthy buy: %v", err)
	}
	if stub.getAcctCalls != 1 {
		t.Errorf("expected exactly 1 GetAccount call per CheckBuy, got %d", stub.getAcctCalls)
	}
}

func TestGuard_MainCheckBuyFetchesAccountAtMostOnce(t *testing.T) {
	cfg := defaultConfig()
	cfg.MaxDailyLossPct = 5.0
	stub := &stubTrading{portfolio: 100000, lastEquity: 100000}
	g := NewTradeGuard(&stubLister{}, stub, cfg)
	// Main buy only triggers checkDailyLoss — no sector-cap check here, so 1 fetch.
	if err := g.CheckBuy(context.Background(), AgentMain, "AAPL", 1000); err != nil {
		t.Fatalf("unexpected error on healthy main buy: %v", err)
	}
	if stub.getAcctCalls != 1 {
		t.Errorf("expected exactly 1 GetAccount call per main CheckBuy, got %d", stub.getAcctCalls)
	}
}

// ── Sector aggregation (Item 1: cross-agent sector & beta-bucket cap) ──

func TestGuard_BucketFor_CoversMegaCaps(t *testing.T) {
	// The cross-agent sector cap is only useful if common underlyings actually
	// resolve to their real bucket — leaving most equities in OTHER would make
	// the OTHER cap bind on unrelated trades. Sample a representative slice of
	// the universe that various agents might trade.
	cases := []struct {
		symbol string
		want   SectorBucket
	}{
		// Tech (XLK / SMH / SOXX consolidation)
		{"AAPL", "TECH"}, {"MSFT", "TECH"}, {"NVDA", "TECH"}, {"AMD", "TECH"},
		{"AVGO", "TECH"}, {"ORCL", "TECH"}, {"CRM", "TECH"}, {"ADBE", "TECH"},
		{"PLTR", "TECH"}, {"MSTR", "TECH"}, {"SMCI", "TECH"}, {"ASML", "TECH"},
		// Communications
		{"GOOG", "COMMUNICATIONS"}, {"GOOGL", "COMMUNICATIONS"},
		{"META", "COMMUNICATIONS"}, {"NFLX", "COMMUNICATIONS"},
		// Consumer discretionary
		{"AMZN", "CONSUMER_DISCRETIONARY"}, {"TSLA", "CONSUMER_DISCRETIONARY"},
		{"HD", "CONSUMER_DISCRETIONARY"}, {"BKNG", "CONSUMER_DISCRETIONARY"},
		// Financials
		{"JPM", "FINANCIALS"}, {"BAC", "FINANCIALS"}, {"GS", "FINANCIALS"},
		{"V", "FINANCIALS"}, {"COIN", "FINANCIALS"},
		// Healthcare
		{"UNH", "HEALTHCARE"}, {"LLY", "HEALTHCARE"}, {"JNJ", "HEALTHCARE"},
		// Energy
		{"XOM", "ENERGY"}, {"CVX", "ENERGY"},
		// Staples / Industrials / Utilities / Materials
		{"WMT", "STAPLES"}, {"COST", "STAPLES"},
		{"CAT", "INDUSTRIALS"}, {"BA", "INDUSTRIALS"},
		{"NEE", "UTILITIES"},
		{"LIN", "MATERIALS"},
		// Index ETFs (direct via etfToBucket)
		{"SPY", "INDEX_BETA"}, {"QQQ", "INDEX_BETA"}, {"IWM", "INDEX_BETA"},
		// Truly unmapped → OTHER
		{"FOOBAR_UNKNOWN", "OTHER"},
	}
	g := NewTradeGuard(&stubLister{}, nil, defaultConfig())
	for _, tc := range cases {
		if got := g.bucketFor(tc.symbol); got != tc.want {
			t.Errorf("bucketFor(%q) = %q, want %q", tc.symbol, got, tc.want)
		}
	}
}

func TestGuard_SectorCap_BlocksOverConcentration(t *testing.T) {
	// Existing TECH exposure (NVDA + AMD both map to SMH → TECH) at $18K.
	// Portfolio $100K, TECH cap 20% = $20K. A new $3K NVDA buy pushes TECH to
	// $21K → must block.
	lister := &stubLister{
		positions: []*ManagedPosition{
			managedPos("NVDA", AgentMain, "ACTIVE", 10000),
			managedPos("AMD", AgentMain, "ACTIVE", 8000),
		},
	}
	g := NewTradeGuard(lister, &stubTrading{portfolio: 100000, lastEquity: 100000}, sectorConfig())
	err := g.CheckBuy(context.Background(), AgentMain, "NVDA", 3000)
	if err == nil {
		t.Fatal("expected error: TECH sector cap exceeded")
	}
}

func TestGuard_SectorCap_AllowsUnderCap(t *testing.T) {
	// Same TECH positions as the over-concentration test ($18K of $20K cap), but
	// the new buy is small enough to stay under the $20K cap.
	lister := &stubLister{
		positions: []*ManagedPosition{
			managedPos("NVDA", AgentMain, "ACTIVE", 10000),
			managedPos("AMD", AgentMain, "ACTIVE", 8000),
		},
	}
	g := NewTradeGuard(lister, &stubTrading{portfolio: 100000, lastEquity: 100000}, sectorConfig())
	if err := g.CheckBuy(context.Background(), AgentMain, "NVDA", 1500); err != nil {
		t.Fatalf("unexpected error under sector cap: %v", err)
	}
}

func TestGuard_SectorCap_DisabledWhenFlagOff(t *testing.T) {
	// Same over-cap setup as TestGuard_SectorCap_BlocksOverConcentration, but
	// EnableSectorAggregation defaults to false → check must be bypassed.
	cfg := sectorConfig()
	cfg.EnableSectorAggregation = false
	lister := &stubLister{
		positions: []*ManagedPosition{
			managedPos("NVDA", AgentMain, "ACTIVE", 10000),
			managedPos("AMD", AgentMain, "ACTIVE", 8000),
		},
	}
	g := NewTradeGuard(lister, &stubTrading{portfolio: 100000, lastEquity: 100000}, cfg)
	if err := g.CheckBuy(context.Background(), AgentMain, "NVDA", 3000); err != nil {
		t.Fatalf("flag-off should bypass sector cap, got: %v", err)
	}
}

func TestGuard_SectorCap_DefaultBucketForUnmappedSymbol(t *testing.T) {
	// A symbol absent from etfToBucket and sectorETFMap (e.g. "FOOBAR") must
	// fall to the OTHER bucket and inherit DefaultSectorMaxPct when OTHER is
	// not explicitly set in SectorMaxExposurePct.
	cfg := sectorConfig()
	delete(cfg.SectorMaxExposurePct, "OTHER") // force fallback path
	cfg.DefaultSectorMaxPct = 0.15            // $15K cap on $100K portfolio
	lister := &stubLister{
		positions: []*ManagedPosition{
			managedPos("FOOBAR", AgentMain, "ACTIVE", 14000),
		},
	}
	g := NewTradeGuard(lister, &stubTrading{portfolio: 100000, lastEquity: 100000}, cfg)
	if err := g.CheckBuy(context.Background(), AgentMain, "FOOBAR", 2000); err == nil {
		t.Fatal("expected error: OTHER bucket exceeds DefaultSectorMaxPct")
	}
}

func TestGuard_SectorCap_FailsClosedOnFetchError(t *testing.T) {
	// Fail-closed policy: a transient API failure must NOT silently let a buy
	// bypass the concentration limit.
	cfg := sectorConfig()
	cfg.MaxDailyLossPct = 0 // disable daily-loss path so it doesn't short-circuit
	stub := &stubTrading{getAcctErr: errors.New("alpaca timeout")}
	g := NewTradeGuard(&stubLister{}, stub, cfg)
	err := g.CheckBuy(context.Background(), AgentMain, "NVDA", 1000)
	if err == nil {
		t.Fatal("expected error: sector-cap check must fail-closed on fetch error")
	}
}

func TestGuard_SectorCap_IncludesOptionsProviderContribution(t *testing.T) {
	// A registered OptionsExposureProvider contributes
	// $15K to INDEX_BETA. Cap = 25% × $100K = $25K. A new $11K SPY buy pushes
	// total to $26K and must be blocked.
	g := NewTradeGuard(&stubLister{}, &stubTrading{portfolio: 100000, lastEquity: 100000}, sectorConfig())
	g.SetOptionsExposureProvider(&stubOptionsProvider{
		exposure: map[SectorBucket]float64{"INDEX_BETA": 15000},
	})
	if err := g.CheckBuy(context.Background(), AgentMain, "SPY", 11000); err == nil {
		t.Fatal("expected error: options-provider exposure must count toward INDEX_BETA cap")
	}
}

func TestGuard_Status_ReportsSectorExposure(t *testing.T) {
	// Two managed positions (NVDA → TECH via SMH, XLF → FINANCIALS direct) and
	// an options-provider INDEX_BETA contribution must all appear in Status().
	// SectorMaxByBucket reflects per-bucket caps × portfolio value.
	lister := &stubLister{
		positions: []*ManagedPosition{
			managedPos("NVDA", AgentMain, "ACTIVE", 10000),
			managedPos("XLF", AgentMain, "ACTIVE", 5000),
		},
	}
	g := NewTradeGuard(lister, &stubTrading{portfolio: 100000, lastEquity: 100000}, sectorConfig())
	g.SetOptionsExposureProvider(&stubOptionsProvider{
		exposure: map[SectorBucket]float64{"INDEX_BETA": 7500},
	})
	status := g.Status(context.Background())

	if got := status.SectorExposure["TECH"]; got != 10000 {
		t.Errorf("TECH exposure: want $10000, got $%.2f", got)
	}
	if got := status.SectorExposure["FINANCIALS"]; got != 5000 {
		t.Errorf("FINANCIALS exposure: want $5000, got $%.2f", got)
	}
	if got := status.SectorExposure["INDEX_BETA"]; got != 7500 {
		t.Errorf("INDEX_BETA exposure: want $7500, got $%.2f", got)
	}
	if got := status.SectorMaxByBucket["TECH"]; got != 20000 {
		t.Errorf("TECH cap: want $20000, got $%.2f", got)
	}
	if got := status.SectorMaxByBucket["INDEX_BETA"]; got != 25000 {
		t.Errorf("INDEX_BETA cap: want $25000, got $%.2f", got)
	}
}

func TestGuard_DailyLoss_FailsClosedOnFetchError(t *testing.T) {
	cfg := defaultConfig()
	cfg.MaxDailyLossPct = 5
	g := NewTradeGuard(&stubLister{}, &stubTrading{getAcctErr: errors.New("alpaca 503")}, cfg)
	if err := g.CheckBuy(context.Background(), AgentMain, "AAPL", 0); err == nil {
		t.Fatal("expected buy blocked when account fetch errors (fail closed)")
	}
}

func TestGuard_DailyLoss_NilTradingServiceAllows(t *testing.T) {
	cfg := defaultConfig()
	cfg.MaxDailyLossPct = 5
	g := NewTradeGuard(&stubLister{}, nil, cfg) // no account context
	if err := g.CheckBuy(context.Background(), AgentMain, "AAPL", 0); err != nil {
		t.Fatalf("nil trading service should fail open: %v", err)
	}
}

func TestGuard_DailyLoss_RecoversAfterTransientError(t *testing.T) {
	cfg := defaultConfig()
	cfg.MaxDailyLossPct = 5
	stub := &stubTrading{portfolio: 100000, lastEquity: 100000, getAcctErr: errors.New("503")}
	g := NewTradeGuard(&stubLister{}, stub, cfg)
	if err := g.CheckBuy(context.Background(), AgentMain, "AAPL", 0); err == nil {
		t.Fatal("first call should block on error")
	}
	stub.getAcctErr = nil // API recovers
	if err := g.CheckBuy(context.Background(), AgentMain, "AAPL", 0); err != nil {
		t.Fatalf("second call should allow once API recovers (no latch): %v", err)
	}
}

func TestGuard_RecordRaw_NewAgentsDoNotPanic(t *testing.T) {
	// The branch added AgentTrend/AgentMeanRev/AgentDrift and routes raw orders
	// for them (meanrev/drift are live stock agents). NewTradeGuard must
	// initialize rawSymbols for every agent or RecordRawBuy panics on a nil-map
	// write — a phantom-position hazard since the broker order is already placed.
	g := NewTradeGuard(&stubLister{}, &stubTrading{portfolio: 100000}, defaultConfig())
	g.RecordRawBuy(AgentTrend, "TLT")
	g.RecordRawBuy(AgentMeanRev, "GLD")
	g.RecordRawBuy(AgentDrift, "USO")
	g.RecordRawSell(AgentMeanRev, "GLD") // must not panic either

	// Recorded ownership must also feed the N-way overlap check.
	if err := g.CheckBuy(context.Background(), AgentMain, "TLT", 0); err == nil {
		t.Fatal("expected trend's raw TLT to block a main buy")
	}
}

func TestGuard_NWayOverlap_BlocksAnyOtherAgent(t *testing.T) {
	// A trend-tagged position on TLT must block a main buy of TLT — the old
	// main-only logic would have allowed it.
	lister := &stubLister{positions: []*ManagedPosition{
		managedPos("TLT", AgentTrend, "ACTIVE", 1000),
	}}
	g := NewTradeGuard(lister, &stubTrading{portfolio: 100000}, defaultConfig())
	if err := g.CheckBuy(context.Background(), AgentMain, "TLT", 0); err == nil {
		t.Fatal("expected main buy of TLT blocked by trend's holding")
	}
	if err := g.CheckBuy(context.Background(), AgentMain, "SPY", 0); err != nil {
		t.Fatalf("unrelated symbol should pass: %v", err)
	}
}

func TestAgentForStrategy(t *testing.T) {
	cases := map[string]AgentSource{
		"v2-options": AgentMain, "unknown-strategy": AgentMain,
		"trend": AgentTrend, "mean-rev-rsi2": AgentMeanRev, "mean-rev-rsi2-live": AgentMeanRev,
		"earnings-drift": AgentDrift,
		"": AgentMain, "unknown-xyz": AgentMain,
	}
	for strat, want := range cases {
		if got := AgentForStrategy(strat); got != want {
			t.Errorf("AgentForStrategy(%q) = %q, want %q", strat, got, want)
		}
	}
}

func capCfg() TradeGuardConfig {
	c := defaultConfig()
	c.EnablePositionCaps = true
	c.MaxPositionPct = 0.12
	c.MaxDeployedPct = 0.50
	return c
}

func TestGuard_PositionCap_BlocksOversizedTrade(t *testing.T) {
	g := NewTradeGuard(&stubLister{}, &stubTrading{portfolio: 100000, cash: 100000}, capCfg())
	if err := g.CheckBuy(context.Background(), AgentMain, "SPY", 13000); err == nil {
		t.Fatal("expected per-position cap to block $13k on $100k portfolio")
	}
	if err := g.CheckBuy(context.Background(), AgentMain, "SPY", 11000); err != nil {
		t.Fatalf("$11k under 12%% cap should pass: %v", err)
	}
}

func TestGuard_DeployedCap_ProjectsPostTrade(t *testing.T) {
	// 49% deployed (cash 51k of 100k); a $5k order projects to 54% > 50%.
	g := NewTradeGuard(&stubLister{}, &stubTrading{portfolio: 100000, cash: 51000}, capCfg())
	if err := g.CheckBuy(context.Background(), AgentMain, "SPY", 5000); err == nil {
		t.Fatal("expected projected-deployed cap to block (49%+5% > 50%)")
	}
}

func TestGuard_PositionCaps_FailClosedOnIndeterminateNotional(t *testing.T) {
	g := NewTradeGuard(&stubLister{}, &stubTrading{portfolio: 100000, cash: 100000}, capCfg())
	if err := g.CheckBuy(context.Background(), AgentMain, "SPY", 0); err == nil {
		t.Fatal("expected fail-closed when caps enabled and notional indeterminate")
	}
}

func TestGuard_PositionCaps_DisabledIsNoop(t *testing.T) {
	cfg := capCfg()
	cfg.EnablePositionCaps = false
	g := NewTradeGuard(&stubLister{}, &stubTrading{portfolio: 100000, cash: 100000}, cfg)
	if err := g.CheckBuy(context.Background(), AgentMain, "SPY", 0); err != nil {
		t.Fatalf("caps disabled → notional 0 must not block: %v", err)
	}
}

func TestCheckOptionsOpen_SpreadGate(t *testing.T) {
	now := time.Date(2026, 5, 24, 14, 30, 0, 0, time.UTC)
	base := TradeGuardConfig{
		EnableOptionsSpreadGate: true,
		SpreadMaxPct:            0.10,
		OptionsQuoteMaxAge:      60 * time.Second,
	}
	g := NewTradeGuard(nil, nil, base)

	fresh := func(bid, ask float64) *interfaces.OptionsQuote {
		return &interfaces.OptionsQuote{BidPrice: bid, AskPrice: ask, Timestamp: now}
	}

	if err := g.CheckOptionsOpen(AgentMain, "NVDA", "NVDA251219C00400000", fresh(5.00, 5.20), now); err != nil {
		t.Errorf("tight spread should pass, got %v", err)
	}
	if err := g.CheckOptionsOpen(AgentMain, "NVDA", "NVDA251219C00400000", fresh(1.00, 1.30), now); err == nil {
		t.Error("wide spread should be rejected")
	}
	if err := g.CheckOptionsOpen(AgentMain, "NVDA", "NVDA251219C00400000", nil, now); err == nil {
		t.Error("nil quote should fail closed")
	}
	stale := &interfaces.OptionsQuote{BidPrice: 5.00, AskPrice: 5.20, Timestamp: now.Add(-5 * time.Minute)}
	if err := g.CheckOptionsOpen(AgentMain, "NVDA", "NVDA251219C00400000", stale, now); err == nil {
		t.Error("stale quote should fail closed")
	}
	if err := g.CheckOptionsOpen(AgentMain, "NVDA", "NVDA251219C00400000", fresh(0, 5.20), now); err == nil {
		t.Error("zero bid should fail closed")
	}
	gOff := NewTradeGuard(nil, nil, TradeGuardConfig{EnableOptionsSpreadGate: false})
	if err := gOff.CheckOptionsOpen(AgentMain, "NVDA", "NVDA251219C00400000", nil, now); err != nil {
		t.Errorf("gate off must not block on nil quote, got %v", err)
	}
}

func TestCheckOptionsOpen_DistinctReasonCodes(t *testing.T) {
	now := time.Date(2026, 5, 24, 14, 30, 0, 0, time.UTC)
	g := NewTradeGuard(nil, nil, TradeGuardConfig{
		EnableOptionsSpreadGate: true,
		SpreadMaxPct:            0.10,
		OptionsQuoteMaxAge:      60 * time.Second,
	})
	hook := test.NewLocal(g.logger)

	// Wide spread -> spread_exceeded, NOT quote_unavailable.
	g.CheckOptionsOpen(AgentMain, "NVDA", "NVDA251219C00400000",
		&interfaces.OptionsQuote{BidPrice: 1.0, AskPrice: 1.3, Timestamp: now}, now)
	e := hook.LastEntry()
	if e == nil || e.Data["guard_options_spread_exceeded"] != true {
		t.Fatalf("wide spread must log guard_options_spread_exceeded, got %+v", e)
	}
	if _, ok := e.Data["guard_options_quote_unavailable"]; ok {
		t.Error("wide spread must NOT log guard_options_quote_unavailable")
	}
	hook.Reset()

	// Nil quote -> quote_unavailable, NOT spread_exceeded.
	g.CheckOptionsOpen(AgentMain, "NVDA", "NVDA251219C00400000", nil, now)
	e = hook.LastEntry()
	if e == nil || e.Data["guard_options_quote_unavailable"] != true {
		t.Fatalf("nil quote must log guard_options_quote_unavailable, got %+v", e)
	}
	if _, ok := e.Data["guard_options_spread_exceeded"]; ok {
		t.Error("nil quote must NOT log guard_options_spread_exceeded")
	}
}

func TestCheckOptionsOpen_StalenessCeiling(t *testing.T) {
	now := time.Date(2026, 5, 24, 14, 30, 0, 0, time.UTC)
	// Config sets a huge max age (2000s), but the 1020s ceiling must cap it:
	// a 1200s-old quote is within config (2000) but beyond the ceiling -> rejected.
	g := NewTradeGuard(nil, nil, TradeGuardConfig{
		EnableOptionsSpreadGate: true,
		SpreadMaxPct:            0.10,
		OptionsQuoteMaxAge:      2000 * time.Second,
	})
	old := &interfaces.OptionsQuote{BidPrice: 5.0, AskPrice: 5.1, Timestamp: now.Add(-1200 * time.Second)}
	if err := g.CheckOptionsOpen(AgentMain, "NVDA", "NVDA251219C00400000", old, now); err == nil {
		t.Error("ceiling must cap max age: a 1200s-old quote should be rejected even though config allows 2000s")
	}
	// A quote within the ceiling passes.
	fresh := &interfaces.OptionsQuote{BidPrice: 5.0, AskPrice: 5.1, Timestamp: now.Add(-30 * time.Second)}
	if err := g.CheckOptionsOpen(AgentMain, "NVDA", "NVDA251219C00400000", fresh, now); err != nil {
		t.Errorf("a 30s-old quote should pass, got %v", err)
	}
}

func TestCheckOptionsOpen_CrossedQuote(t *testing.T) {
	now := time.Date(2026, 5, 24, 14, 30, 0, 0, time.UTC)
	g := NewTradeGuard(nil, nil, TradeGuardConfig{
		EnableOptionsSpreadGate: true, SpreadMaxPct: 0.10, OptionsQuoteMaxAge: 60 * time.Second,
	})
	crossed := &interfaces.OptionsQuote{BidPrice: 5.2, AskPrice: 5.0, Timestamp: now} // ask < bid
	if err := g.CheckOptionsOpen(AgentMain, "NVDA", "NVDA251219C00400000", crossed, now); err == nil {
		t.Error("crossed quote (ask<bid) must be rejected as unusable")
	}
}

func TestCheckOptionsOpen_UniverseGate(t *testing.T) {
	floor := map[string]bool{"NVDA": true, "SPY": true}
	g := NewTradeGuard(nil, nil, TradeGuardConfig{
		EnableUniverseGate:  true,
		TradableUnderlyings: floor,
	})

	if err := g.CheckOptionsOpen(AgentMain, "NVDA", "NVDA251219C00400000", nil, time.Now()); err != nil {
		t.Errorf("on-floor NVDA should pass universe gate, got %v", err)
	}
	if err := g.CheckOptionsOpen(AgentMain, "PLUG", "PLUG251219C00010000", nil, time.Now()); err == nil {
		t.Error("off-floor PLUG should be rejected by universe gate")
	}
	if err := g.CheckOptionsOpen(AgentMain, "", "SPY251219C00500000", nil, time.Now()); err != nil {
		t.Errorf("blank underlying with on-floor OCC root should pass, got %v", err)
	}
	if err := g.CheckOptionsOpen(AgentMain, "", "PLUG251219C00010000", nil, time.Now()); err == nil {
		t.Error("blank underlying with off-floor OCC root should be rejected")
	}
	gOff := NewTradeGuard(nil, nil, TradeGuardConfig{EnableUniverseGate: false, TradableUnderlyings: floor})
	if err := gOff.CheckOptionsOpen(AgentMain, "PLUG", "PLUG251219C00010000", nil, time.Now()); err != nil {
		t.Errorf("gate off must not block, got %v", err)
	}
	gEmpty := NewTradeGuard(nil, nil, TradeGuardConfig{EnableUniverseGate: true, TradableUnderlyings: map[string]bool{}})
	if err := gEmpty.CheckOptionsOpen(AgentMain, "PLUG", "PLUG251219C00010000", nil, time.Now()); err != nil {
		t.Errorf("empty floor must fail open, got %v", err)
	}
}

// agentUniverseConfig builds a config with the per-agent equity universe gate
// enabled and MeanRev/Drift each given a one-symbol allowlist.
func agentUniverseConfig() TradeGuardConfig {
	cfg := defaultConfig()
	cfg.EnableAgentUniverseGate = true
	cfg.AgentUniverses = map[AgentSource]map[string]bool{
		AgentMeanRev: {"AAPL": true},
		AgentDrift:   {"MSFT": true},
	}
	return cfg
}

func TestCheckBuy_AgentUniverseGate_BlocksOffUniverse(t *testing.T) {
	g := NewTradeGuard(nil, &stubTrading{portfolio: 100000}, agentUniverseConfig())

	if err := g.CheckBuy(context.Background(), AgentMeanRev, "AAPL", 1000); err != nil {
		t.Errorf("on-universe AAPL should pass for Coil, got %v", err)
	}
	if err := g.CheckBuy(context.Background(), AgentMeanRev, "TSLA", 1000); err == nil {
		t.Error("off-universe TSLA should be rejected for Coil")
	}
	if err := g.CheckBuy(context.Background(), AgentDrift, "MSFT", 1000); err != nil {
		t.Errorf("on-universe MSFT should pass for Drift, got %v", err)
	}
	if err := g.CheckBuy(context.Background(), AgentDrift, "AAPL", 1000); err == nil {
		t.Error("AAPL is Coil's symbol, not Drift's — should be rejected for Drift")
	}
}

func TestCheckBuy_AgentUniverseGate_CaseInsensitive(t *testing.T) {
	g := NewTradeGuard(nil, &stubTrading{portfolio: 100000}, agentUniverseConfig())
	if err := g.CheckBuy(context.Background(), AgentMeanRev, "aapl", 1000); err != nil {
		t.Errorf("lower-case aapl should normalize and pass, got %v", err)
	}
}

func TestCheckBuy_AgentUniverseGate_UnconfiguredAgentFailsOpen(t *testing.T) {
	g := NewTradeGuard(nil, &stubTrading{portfolio: 100000}, agentUniverseConfig())
	// Trend and Main have no configured universe in the map → fail open.
	if err := g.CheckBuy(context.Background(), AgentTrend, "TSLA", 1000); err != nil {
		t.Errorf("unconfigured Trend must not be universe-gated, got %v", err)
	}
	if err := g.CheckBuy(context.Background(), AgentMain, "TSLA", 1000); err != nil {
		t.Errorf("unconfigured Main must not be universe-gated, got %v", err)
	}
}

func TestCheckBuy_AgentUniverseGate_DisabledNoOp(t *testing.T) {
	cfg := agentUniverseConfig()
	cfg.EnableAgentUniverseGate = false
	g := NewTradeGuard(nil, &stubTrading{portfolio: 100000}, cfg)
	if err := g.CheckBuy(context.Background(), AgentMeanRev, "TSLA", 1000); err != nil {
		t.Errorf("gate disabled must not block off-universe buy, got %v", err)
	}
}

func TestCheckBuy_AgentUniverseGate_EmptyUniverseFailsOpen(t *testing.T) {
	cfg := defaultConfig()
	cfg.EnableAgentUniverseGate = true
	cfg.AgentUniverses = map[AgentSource]map[string]bool{AgentMeanRev: {}}
	g := NewTradeGuard(nil, &stubTrading{portfolio: 100000}, cfg)
	if err := g.CheckBuy(context.Background(), AgentMeanRev, "TSLA", 1000); err != nil {
		t.Errorf("empty universe for an agent must fail open, got %v", err)
	}
}
