package services

import (
	"context"
	"testing"
	"time"

	"prophet-trader/interfaces"
)

// chainStubTrading embeds the shared stubTrading and overrides GetOptionsChain
// to return a caller-supplied slice — modeling AlpacaTradingService.GetOptionsChain,
// whose snapshot-built contracts carry pricing/greeks but leave ContractType and
// StrikePrice unset (only the OCC Symbol encodes them).
type chainStubTrading struct {
	*stubTrading
	chain []*interfaces.OptionContract
}

func (c *chainStubTrading) GetOptionsChain(_ context.Context, _ string, _ time.Time) ([]*interfaces.OptionContract, error) {
	return c.chain, nil
}

func TestChainSourceAdapter_ChainMap_populatesOCCMetadata(t *testing.T) {
	stub := &chainStubTrading{
		stubTrading: &stubTrading{},
		chain: []*interfaces.OptionContract{
			// Type/strike unset, as the real snapshot-based chain returns them.
			{Symbol: "QQQ260717C00728000", Bid: 12.0, Ask: 12.5},
			{Symbol: "QQQ260717P00700000", Bid: 3.0, Ask: 3.2},
			// A fractional ($0.50) strike.
			{Symbol: "AMZN251219C00131500", Bid: 5.0, Ask: 5.3},
			// Already-populated fields must NOT be clobbered.
			{Symbol: "SPY260320P05000000", ContractType: "put", StrikePrice: 4999.0, Bid: 1.0, Ask: 1.1},
		},
	}
	a := NewChainSourceAdapter(stub, nil) // ds unused by ChainMap

	m, err := a.ChainMap(context.Background(), "QQQ", time.Now())
	if err != nil {
		t.Fatalf("ChainMap: %v", err)
	}

	if c := m["QQQ260717C00728000"]; c.ContractType != "call" || c.StrikePrice != 728.0 {
		t.Errorf("call leg: type=%q strike=%v, want call/728", c.ContractType, c.StrikePrice)
	}
	if c := m["QQQ260717P00700000"]; c.ContractType != "put" || c.StrikePrice != 700.0 {
		t.Errorf("put leg: type=%q strike=%v, want put/700", c.ContractType, c.StrikePrice)
	}
	if c := m["AMZN251219C00131500"]; c.ContractType != "call" || c.StrikePrice != 131.5 {
		t.Errorf("fractional leg: type=%q strike=%v, want call/131.5", c.ContractType, c.StrikePrice)
	}
	// Pre-populated fields preserved (no clobber).
	if c := m["SPY260320P05000000"]; c.ContractType != "put" || c.StrikePrice != 4999.0 {
		t.Errorf("pre-set leg clobbered: type=%q strike=%v, want put/4999", c.ContractType, c.StrikePrice)
	}
}
