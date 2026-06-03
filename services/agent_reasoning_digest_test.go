package services

import (
	"strings"
	"testing"
)

// The reasoning digest renders deterministic, zero-LLM-token "why" lines for the
// mechanical agents (Coil, Turtle). The functions only FORMAT real signal values
// plus the agent's actual decision — they never re-derive the decision, so the
// explanation can never contradict what the agent did.

func TestExplainMeanRev_EntryEligible(t *testing.T) {
	sig := MeanRevSignal{
		Ticker: "AAPL", LastClose: 212.40, RSI2: 3.1, SMA200: 198.10, SMA5: 214.90,
		EarningsWithin5d: false, EntrySignal: true,
	}
	got := ExplainMeanRevEntry(sig)
	for _, want := range []string{"Coil", "AAPL", "RSI(2)=3.1", "ENTER"} {
		if !strings.Contains(got, want) {
			t.Fatalf("missing %q in:\n%s", want, got)
		}
	}
	if strings.Contains(got, "no entry") {
		t.Fatalf("eligible signal must not say 'no entry':\n%s", got)
	}
}

func TestExplainMeanRev_BlockedByRSI(t *testing.T) {
	// RSI(2) above the 5 threshold is the first failing gate.
	sig := MeanRevSignal{
		Ticker: "NVDA", LastClose: 229.0, RSI2: 8.2, SMA200: 180.0, SMA5: 225.0,
		EarningsWithin5d: false, EntrySignal: false,
	}
	got := ExplainMeanRevEntry(sig)
	if !strings.Contains(got, "no entry") {
		t.Fatalf("blocked signal must say 'no entry':\n%s", got)
	}
	if !strings.Contains(got, "RSI(2)=8.2") || !strings.Contains(got, ">= 5") {
		t.Fatalf("must name the RSI block reason:\n%s", got)
	}
}

func TestExplainMeanRev_BlockedByEarnings(t *testing.T) {
	// RSI/uptrend/pullback all pass; earnings is the only failing gate.
	sig := MeanRevSignal{
		Ticker: "MSFT", LastClose: 446.0, RSI2: 3.0, SMA200: 405.0, SMA5: 452.0,
		EarningsWithin5d: true, EntrySignal: false,
	}
	got := ExplainMeanRevEntry(sig)
	if !strings.Contains(got, "no entry") || !strings.Contains(strings.ToLower(got), "earnings") {
		t.Fatalf("must name the earnings block reason:\n%s", got)
	}
}

func TestExplainTrend_Entered(t *testing.T) {
	sig := TrendSignal{
		Ticker: "GLD", LastClose: 250.0, Donchian100High: 248.0, Donchian50Low: 235.0,
		SMA200: 230.0, ATR20: 3.0,
	}
	got := ExplainTrendEntry(sig, true, "")
	for _, want := range []string{"Turtle", "GLD", "breakout", "ENTER"} {
		if !strings.Contains(got, want) {
			t.Fatalf("missing %q in:\n%s", want, got)
		}
	}
}

func TestExplainTrend_BlockedReasonVerbatim(t *testing.T) {
	// The formatter must surface the executor's authoritative reason verbatim,
	// never a re-derived one.
	sig := TrendSignal{
		Ticker: "TLT", LastClose: 90.0, Donchian100High: 95.0, Donchian50Low: 88.0,
		SMA200: 92.0, ATR20: 1.0,
	}
	reason := "last_close not above Donchian-100 high"
	got := ExplainTrendEntry(sig, false, reason)
	if !strings.Contains(got, "no entry") || !strings.Contains(got, reason) {
		t.Fatalf("must surface the verbatim block reason %q in:\n%s", reason, got)
	}
}
