package services

import (
	"context"
	"testing"

	"prophet-trader/interfaces"
	"prophet-trader/models"
)

type fakeOptionPricer struct {
	prices map[string]float64 // symbol -> mid
	err    error
}

func (f *fakeOptionPricer) GetOptionSnapshot(_ context.Context, symbol string) (*interfaces.OptionContract, error) {
	if f.err != nil {
		return nil, f.err
	}
	mid, ok := f.prices[symbol]
	if !ok {
		return &interfaces.OptionContract{Symbol: symbol, Premium: 0, Bid: 0, Ask: 0}, nil
	}
	return &interfaces.OptionContract{Symbol: symbol, Premium: mid, Bid: mid - 0.01, Ask: mid + 0.01}, nil
}

func TestHarvestPricer_CostToCloseHappyPath(t *testing.T) {
	condor := &models.DBHarvestCondor{
		ShortPutSymbol:  "P_short",
		LongPutSymbol:   "P_long",
		ShortCallSymbol: "C_short",
		LongCallSymbol:  "C_long",
	}
	pricer := NewHarvestPricer(&fakeOptionPricer{prices: map[string]float64{
		"P_short": 0.40,
		"P_long":  0.10,
		"C_short": 0.50,
		"C_long":  0.15,
	}})
	cost, err := pricer.CostToClosePerContract(context.Background(), condor)
	if err != nil {
		t.Fatal(err)
	}
	// (short_put_mid + short_call_mid) - (long_put_mid + long_call_mid)
	want := (0.40 + 0.50) - (0.10 + 0.15)
	if abs(cost-want) > 1e-9 {
		t.Errorf("got %.4f, want %.4f", cost, want)
	}
}

func TestHarvestPricer_ReturnsErrIfAnyLegMissing(t *testing.T) {
	condor := &models.DBHarvestCondor{
		ShortPutSymbol:  "P_short",
		LongPutSymbol:   "P_long",
		ShortCallSymbol: "C_short",
		LongCallSymbol:  "C_long",
	}
	pricer := NewHarvestPricer(&fakeOptionPricer{prices: map[string]float64{
		"P_short": 0.40, "P_long": 0.10, "C_short": 0.50, // C_long missing → premium 0
	}})
	_, err := pricer.CostToClosePerContract(context.Background(), condor)
	if err == nil {
		t.Fatal("expected error when a leg has zero/missing price")
	}
}

func abs(x float64) float64 {
	if x < 0 {
		return -x
	}
	return x
}
