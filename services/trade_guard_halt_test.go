package services

import (
	"context"
	"errors"
	"testing"
)

type stubHalter struct{ err error }

func (s *stubHalter) EvaluateEntry(_ context.Context) error { return s.err }

func TestCheckBuy_ConsultsHaltGuard(t *testing.T) {
	g := NewTradeGuard(&stubLister{}, nil, TradeGuardConfig{})
	g.SetHaltGuard(&stubHalter{err: errors.New("drawdown halt latched")})

	err := g.CheckBuy(context.Background(), AgentMeanRev, "AAPL", 600)
	if err == nil {
		t.Fatal("CheckBuy must block when the halt guard blocks, got nil")
	}
}

func TestCheckBuy_AllowsWhenHaltArmed(t *testing.T) {
	g := NewTradeGuard(&stubLister{}, nil, TradeGuardConfig{})
	g.SetHaltGuard(&stubHalter{err: nil})

	if err := g.CheckBuy(context.Background(), AgentMeanRev, "AAPL", 600); err != nil {
		t.Fatalf("CheckBuy must allow when the halt is armed, got %v", err)
	}
}

func TestCheckBuy_NoHaltGuardIsNoOp(t *testing.T) {
	g := NewTradeGuard(&stubLister{}, nil, TradeGuardConfig{})
	if err := g.CheckBuy(context.Background(), AgentMeanRev, "AAPL", 600); err != nil {
		t.Fatalf("a guard with no halt wired must allow, got %v", err)
	}
}
