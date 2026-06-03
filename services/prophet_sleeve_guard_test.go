package services

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"prophet-trader/interfaces"
)

type stubReader struct {
	acct    *interfaces.Account
	acctErr error
	opt     []*interfaces.OptionsPosition
	optErr  error
	eq      []*interfaces.Position
	eqErr   error
}

func (s *stubReader) GetAccount(_ context.Context) (*interfaces.Account, error) {
	return s.acct, s.acctErr
}
func (s *stubReader) ListOptionsPositions(_ context.Context) ([]*interfaces.OptionsPosition, error) {
	return s.opt, s.optErr
}
func (s *stubReader) GetPositions(_ context.Context) ([]*interfaces.Position, error) {
	return s.eq, s.eqErr
}

func armedCfg(t *testing.T) ProphetSleeveConfig {
	t.Helper()
	return ProphetSleeveConfig{
		Enabled:         true,
		BaselineUSD:     1000,
		MaxPositionFrac: 0.25,
		MaxPositions:    5,
		LossBudgetFrac:  0.50,
		Deadline:        "2099-12-31",
		DisarmDir:       t.TempDir(),
	}
}

func healthyReader(baseline float64) *stubReader {
	return &stubReader{
		acct: &interfaces.Account{PortfolioValue: baseline, DayTradeCount: 0},
	}
}

func lossReader(_, equity float64) *stubReader {
	return &stubReader{acct: &interfaces.Account{PortfolioValue: equity}}
}

func TestEvaluateOpen_DisabledIsNoOp(t *testing.T) {
	cfg := armedCfg(t)
	cfg.Enabled = false
	cfg.BaselineUSD = 0
	g := NewProphetSleeveGuard(cfg, &stubReader{})
	if err := g.EvaluateOpen(context.Background(), 10_000, time.Now()); err != nil {
		t.Fatalf("disabled guard should no-op, got %v", err)
	}
}

func TestEvaluateOpen_BaselineUnconfiguredFailsClosed(t *testing.T) {
	cfg := armedCfg(t)
	cfg.BaselineUSD = 0
	g := NewProphetSleeveGuard(cfg, healthyReader(0))
	if err := g.EvaluateOpen(context.Background(), 1, time.Now()); err == nil {
		t.Fatal("baseline<=0 while enabled must fail closed")
	}
}

func TestEvaluateOpen_DeadlineGates(t *testing.T) {
	base := healthyReader(1000)
	now := time.Date(2026, 6, 3, 12, 0, 0, 0, time.UTC)

	cfg := armedCfg(t)
	cfg.Deadline = ""
	if err := NewProphetSleeveGuard(cfg, base).EvaluateOpen(context.Background(), 1, now); err == nil {
		t.Error("missing deadline must fail closed")
	}
	cfg = armedCfg(t)
	cfg.Deadline = "not-a-date"
	if err := NewProphetSleeveGuard(cfg, base).EvaluateOpen(context.Background(), 1, now); err == nil {
		t.Error("invalid deadline must fail closed")
	}
	cfg = armedCfg(t)
	cfg.Deadline = "2026-06-01"
	if err := NewProphetSleeveGuard(cfg, base).EvaluateOpen(context.Background(), 1, now); err == nil {
		t.Error("past deadline must block")
	}
	cfg = armedCfg(t)
	cfg.Deadline = "2026-12-31"
	if err := NewProphetSleeveGuard(cfg, base).EvaluateOpen(context.Background(), 1, now); err != nil {
		t.Errorf("future deadline + healthy should allow, got %v", err)
	}
}

func TestEvaluateOpen_KillFileBlocks(t *testing.T) {
	cfg := armedCfg(t)
	g := NewProphetSleeveGuard(cfg, healthyReader(1000))
	if err := g.EvaluateOpen(context.Background(), 1, time.Now()); err != nil {
		t.Fatalf("precondition: should allow, got %v", err)
	}
	if err := os.WriteFile(filepath.Join(cfg.DisarmDir, "KILL_PROPHET_SLEEVE"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := g.EvaluateOpen(context.Background(), 1, time.Now()); err == nil {
		t.Error("kill file present must block")
	}
}

func TestEvaluateOpen_LossLatchFileBlocks(t *testing.T) {
	cfg := armedCfg(t)
	g := NewProphetSleeveGuard(cfg, healthyReader(1000))
	if err := os.WriteFile(filepath.Join(cfg.DisarmDir, "sleeve_disarm.json"), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := g.EvaluateOpen(context.Background(), 1, time.Now()); err == nil {
		t.Error("loss latch file present must block")
	}
}

func TestComputeMetrics_RealizedLossFormula(t *testing.T) {
	const B = 1000.0
	cases := []struct {
		name       string
		equity     float64
		opt        []*interfaces.OptionsPosition
		wantLoss   float64
		wantDeploy float64
		wantOpen   int
	}{
		{
			name:     "buy $200 no move -> 0 realized",
			equity:   1000,
			opt:      []*interfaces.OptionsPosition{{CostBasis: 200, UnrealizedPL: 0}},
			wantLoss: 0, wantDeploy: 200, wantOpen: 1,
		},
		{
			name:     "open position down $150 still open -> 0 realized",
			equity:   850,
			opt:      []*interfaces.OptionsPosition{{CostBasis: 200, UnrealizedPL: -150}},
			wantLoss: 0, wantDeploy: 200, wantOpen: 1,
		},
		{
			name:     "closed one for -$150, flat -> 150 realized",
			equity:   850,
			opt:      nil,
			wantLoss: 150, wantDeploy: 0, wantOpen: 0,
		},
		{
			name:     "closed -$150 + open winner +$60 -> 150 realized",
			equity:   910,
			opt:      []*interfaces.OptionsPosition{{CostBasis: 200, UnrealizedPL: 60}},
			wantLoss: 150, wantDeploy: 200, wantOpen: 1,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg := armedCfg(t)
			cfg.BaselineUSD = B
			r := &stubReader{acct: &interfaces.Account{PortfolioValue: tc.equity}, opt: tc.opt}
			g := NewProphetSleeveGuard(cfg, r)
			m, err := g.computeMetrics(context.Background())
			if err != nil {
				t.Fatalf("computeMetrics: %v", err)
			}
			if m.realizedLoss != tc.wantLoss {
				t.Errorf("realizedLoss = %v, want %v", m.realizedLoss, tc.wantLoss)
			}
			if m.deployed != tc.wantDeploy {
				t.Errorf("deployed = %v, want %v", m.deployed, tc.wantDeploy)
			}
			if m.openCount != tc.wantOpen {
				t.Errorf("openCount = %v, want %v", m.openCount, tc.wantOpen)
			}
		})
	}
}

func TestEvaluateOpen_AccountReadErrorFailsClosed(t *testing.T) {
	cfg := armedCfg(t)
	r := &stubReader{acctErr: errors.New("boom")}
	g := NewProphetSleeveGuard(cfg, r)
	if err := g.EvaluateOpen(context.Background(), 1, time.Now()); err == nil {
		t.Error("account read error must fail closed")
	}
}

func TestEvaluateOpen_PDTBackstop(t *testing.T) {
	mk := func(dtc int, equity float64) *ProphetSleeveGuard {
		cfg := armedCfg(t)
		r := &stubReader{acct: &interfaces.Account{PortfolioValue: equity, DayTradeCount: dtc}}
		return NewProphetSleeveGuard(cfg, r)
	}
	if err := mk(3, 24999).EvaluateOpen(context.Background(), 1, time.Now()); err == nil {
		t.Error("dtc=3 & equity<25k must block (PDT)")
	}
	if err := mk(2, 24999).EvaluateOpen(context.Background(), 1, time.Now()); err != nil {
		t.Errorf("dtc=2 should not trip PDT, got %v", err)
	}
	if err := mk(3, 25001).EvaluateOpen(context.Background(), 1, time.Now()); err != nil {
		t.Errorf("equity>=25k should not trip PDT, got %v", err)
	}
}

func TestEvaluateOpen_LossBudgetTripsLatchAndPersists(t *testing.T) {
	cfg := armedCfg(t)
	g := NewProphetSleeveGuard(cfg, lossReader(1000, 500))
	if err := g.EvaluateOpen(context.Background(), 1, time.Now()); err == nil {
		t.Fatal("realized loss at budget must block")
	}
	if !sleeveFileExists(filepath.Join(cfg.DisarmDir, "sleeve_disarm.json")) {
		t.Fatal("loss latch file should have been written")
	}
	g2 := NewProphetSleeveGuard(cfg, healthyReader(1000))
	if err := g2.EvaluateOpen(context.Background(), 1, time.Now()); err == nil {
		t.Error("after latch, a healthy-account restart must still block (no auto-rearm)")
	}
}

func TestEvaluateOpen_BelowBudgetDoesNotLatch(t *testing.T) {
	cfg := armedCfg(t)
	g := NewProphetSleeveGuard(cfg, lossReader(1000, 600))
	if err := g.EvaluateOpen(context.Background(), 1, time.Now()); err != nil {
		t.Errorf("below budget should allow, got %v", err)
	}
	if sleeveFileExists(filepath.Join(cfg.DisarmDir, "sleeve_disarm.json")) {
		t.Error("below budget must NOT write a latch file")
	}
}

func TestEvaluateOpen_PerPositionCap(t *testing.T) {
	cfg := armedCfg(t)
	g := NewProphetSleeveGuard(cfg, healthyReader(1000))
	if err := g.EvaluateOpen(context.Background(), 250.01, time.Now()); err == nil {
		t.Error("premium 250.01 > 250 cap must block")
	}
	if err := g.EvaluateOpen(context.Background(), 250.0, time.Now()); err != nil {
		t.Errorf("premium 250.0 == cap should allow, got %v", err)
	}
}

func TestEvaluateOpen_ConcurrencyCap(t *testing.T) {
	cfg := armedCfg(t)
	opt := make([]*interfaces.OptionsPosition, 5)
	for i := range opt {
		opt[i] = &interfaces.OptionsPosition{CostBasis: 1}
	}
	r := &stubReader{acct: &interfaces.Account{PortfolioValue: 1000}, opt: opt}
	g := NewProphetSleeveGuard(cfg, r)
	if err := g.EvaluateOpen(context.Background(), 1, time.Now()); err == nil {
		t.Error("openCount 5 >= MaxPositions 5 must block")
	}
}

func TestEvaluateOpen_ExposureCap(t *testing.T) {
	cfg := armedCfg(t)
	r := &stubReader{acct: &interfaces.Account{PortfolioValue: 1000},
		opt: []*interfaces.OptionsPosition{{CostBasis: 900}}}
	g := NewProphetSleeveGuard(cfg, r)
	if err := g.EvaluateOpen(context.Background(), 150, time.Now()); err == nil {
		t.Error("deployed 900 + new 150 > available 1000 must block")
	}
	if err := g.EvaluateOpen(context.Background(), 100, time.Now()); err != nil {
		t.Errorf("deployed 900 + new 100 == available 1000 should allow, got %v", err)
	}
}

func TestEvaluateOpen_ExposureRatchetsWithRealizedLoss(t *testing.T) {
	cfg := armedCfg(t)
	r := &stubReader{
		acct: &interfaces.Account{PortfolioValue: 700},
		opt:  []*interfaces.OptionsPosition{{CostBasis: 500, UnrealizedPL: 0}},
	}
	g := NewProphetSleeveGuard(cfg, r)
	if err := g.EvaluateOpen(context.Background(), 250, time.Now()); err == nil {
		t.Error("exposure must use ratcheted Available (B - realized_loss)")
	}
}

func TestStatus_ArmedHealthy(t *testing.T) {
	cfg := armedCfg(t)
	now := time.Date(2026, 6, 3, 12, 0, 0, 0, time.UTC)
	g := NewProphetSleeveGuard(cfg, healthyReader(1000))
	s := g.Status(context.Background(), now)
	if !s.Armed {
		t.Errorf("healthy guard should be armed; reasons=%v", s.DisarmReasons)
	}
	if s.AvailableUSD != 1000 {
		t.Errorf("AvailableUSD = %v, want 1000", s.AvailableUSD)
	}
	if s.LossBudgetUSD != 500 {
		t.Errorf("LossBudgetUSD = %v, want 500", s.LossBudgetUSD)
	}
}

func TestStatus_DisarmedByKill(t *testing.T) {
	cfg := armedCfg(t)
	g := NewProphetSleeveGuard(cfg, healthyReader(1000))
	if err := g.EngageManualKill("operator test"); err != nil {
		t.Fatalf("EngageManualKill: %v", err)
	}
	s := g.Status(context.Background(), time.Now())
	if s.Armed {
		t.Error("kill engaged -> should be disarmed")
	}
	if err := g.EvaluateOpen(context.Background(), 1, time.Now()); err == nil {
		t.Error("after EngageManualKill, opens must block")
	}
}
