package services

import (
	"prophet-trader/interfaces"
	"testing"
	"time"
)

// TestAgentForStrategy_ProphetDefensive verifies the agent routing for the defensive hedge.
func TestAgentForStrategy_ProphetDefensive(t *testing.T) {
	agent := AgentForStrategy("prophet-defensive")
	if agent != AgentProphetDefensive {
		t.Errorf("AgentForStrategy(\"prophet-defensive\") = %v, want %v", agent, AgentProphetDefensive)
	}
}

// TestCheckOptionsOpen_DefensiveAgent verifies that the defensive prophet agent
// is subject to the options spread/liquidity gate, not bypassed like non-main agents.
func TestCheckOptionsOpen_DefensiveAgent(t *testing.T) {
	now := time.Date(2026, 5, 24, 14, 30, 0, 0, time.UTC)
	cfg := TradeGuardConfig{
		EnableOptionsSpreadGate: true,
		SpreadMaxPct:            0.10,
		OptionsQuoteMaxAge:      60 * time.Second,
	}
	g := NewTradeGuard(nil, nil, cfg)

	// Fresh quote helper
	fresh := func(bid, ask float64) *interfaces.OptionsQuote {
		return &interfaces.OptionsQuote{BidPrice: bid, AskPrice: ask, Timestamp: now}
	}

	// Test 1: Nil quote with spread gate enabled should fail closed for defensive agent.
	if err := g.CheckOptionsOpen(AgentProphetDefensive, "QQQ", "QQQ251219P00380000", nil, now); err == nil {
		t.Error("defensive agent: nil quote should fail closed (gate enforced)")
	}

	// Test 2: Valid tight spread should pass for defensive agent.
	if err := g.CheckOptionsOpen(AgentProphetDefensive, "QQQ", "QQQ251219P00380000", fresh(1.50, 1.65), now); err != nil {
		t.Errorf("defensive agent: tight spread should pass, got %v", err)
	}

	// Test 3: Wide spread should fail for defensive agent.
	if err := g.CheckOptionsOpen(AgentProphetDefensive, "QQQ", "QQQ251219P00380000", fresh(1.00, 1.50), now); err == nil {
		t.Error("defensive agent: wide spread should be rejected (gate enforced)")
	}
}
