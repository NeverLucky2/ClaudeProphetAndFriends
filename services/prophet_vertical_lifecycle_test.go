package services

import (
	"testing"
	"time"
)

func TestVerticalDTE(t *testing.T) {
	now := time.Date(2026, 6, 11, 12, 0, 0, 0, time.UTC)
	exp := now.Add(5 * 24 * time.Hour)
	if got := verticalDTE(exp, now); got != 5 {
		t.Fatalf("dte = %d, want 5", got)
	}
}

func TestShouldTakeProfit(t *testing.T) {
	if !shouldTakeProfit(750, 1000, 0.75) {
		t.Fatal("750 >= 75% of 1000 -> take profit")
	}
	if shouldTakeProfit(700, 1000, 0.75) {
		t.Fatal("700 < 75% of 1000 -> no")
	}
	if shouldTakeProfit(900, 0, 0.75) {
		t.Fatal("zero max gain -> no")
	}
}

func TestShouldSalvageStop(t *testing.T) {
	if !shouldSalvageStop(100, 700, 0.20) {
		t.Fatal("residual at/under floor -> salvage")
	}
	if shouldSalvageStop(200, 700, 0.20) {
		t.Fatal("200 > 140 floor -> no")
	}
}

func TestShouldForceCloseBeforeExpiry(t *testing.T) {
	if !shouldForceCloseBeforeExpiry(2, 2) {
		t.Fatal("dte 2 <= forceDTE 2 -> force")
	}
	if shouldForceCloseBeforeExpiry(3, 2) {
		t.Fatal("dte 3 > 2 -> no")
	}
}

func TestShortLegITM(t *testing.T) {
	if !shortLegITM(CallDebit, 261, 260) {
		t.Fatal("call-debit short ITM when spot above short strike")
	}
	if shortLegITM(CallDebit, 259, 260) {
		t.Fatal("call-debit short OTM when spot below short strike")
	}
	if !shortLegITM(PutDebit, 219, 220) {
		t.Fatal("put-debit short ITM when spot below short strike")
	}
}

func TestBothLegsOTM(t *testing.T) {
	if !bothLegsOTM(CallDebit, 239, 240, 260) {
		t.Fatal("call-debit both OTM below long strike")
	}
	if bothLegsOTM(CallDebit, 245, 240, 260) {
		t.Fatal("spot between strikes -> long ITM, not both-OTM")
	}
	if !bothLegsOTM(PutDebit, 231, 230, 220) {
		t.Fatal("put-debit both OTM above long strike")
	}
	if bothLegsOTM(PutDebit, 225, 230, 220) {
		t.Fatal("spot between strikes -> long put ITM, not both-OTM")
	}
}

func baseExitCfg() VerticalExitConfig {
	return VerticalExitConfig{SalvageFloorFrac: 0.20, ForceDTE: 2, CaptureDTE: 3, ExpectedExitCost: 5}
}

func baseCallState() VerticalState {
	return VerticalState{
		Direction: CallDebit, Spot: 250, LongStrike: 240, ShortStrike: 260,
		CurrentValueTotal: 800, MaxGainTotal: 1300, TotalDebit: 700, DTE: 20,
	}
}

func TestSelectVerticalExit_HoldsWhenNoTrigger(t *testing.T) {
	if reason, act := selectVerticalExit(baseCallState(), baseExitCfg()); act || reason != "" {
		t.Fatalf("expected hold, got (%q,%v)", reason, act)
	}
}

func TestSelectVerticalExit_SalvageWinsOverForceClose(t *testing.T) {
	s := baseCallState()
	s.CurrentValueTotal = 100
	s.DTE = 1
	if reason, act := selectVerticalExit(s, baseExitCfg()); !act || reason != "salvage_stop" {
		t.Fatalf("expected salvage_stop, got (%q,%v)", reason, act)
	}
}

func TestSelectVerticalExit_ProfitCaptureOnShortITMNearExpiry(t *testing.T) {
	s := baseCallState()
	s.Spot = 261
	s.DTE = 3
	if reason, act := selectVerticalExit(s, baseExitCfg()); !act || reason != "profit_capture" {
		t.Fatalf("expected profit_capture, got (%q,%v)", reason, act)
	}
}

func TestSelectVerticalExit_ForceCloseCatchAll(t *testing.T) {
	s := baseCallState()
	s.Spot = 250
	s.DTE = 2
	if reason, act := selectVerticalExit(s, baseExitCfg()); !act || reason != "force_close" {
		t.Fatalf("expected force_close, got (%q,%v)", reason, act)
	}
}

func TestSelectVerticalExit_WorthlessCarveOut_LetsExpire(t *testing.T) {
	s := baseCallState()
	s.Spot = 235
	s.CurrentValueTotal = 4
	s.DTE = 2
	if reason, act := selectVerticalExit(s, baseExitCfg()); act || reason != "let_expire" {
		t.Fatalf("expected let_expire/hold, got (%q,%v)", reason, act)
	}
}

func TestSelectVerticalExit_NotWorthlessEnough_ForceCloses(t *testing.T) {
	s := baseCallState()
	s.Spot = 235
	s.CurrentValueTotal = 9
	s.DTE = 2
	if reason, act := selectVerticalExit(s, baseExitCfg()); !act || reason != "force_close" {
		t.Fatalf("expected force_close, got (%q,%v)", reason, act)
	}
}
