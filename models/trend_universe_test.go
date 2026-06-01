package models

import "testing"

func TestTrendUniverse_FifteenInstrumentsSixClusters(t *testing.T) {
	if len(TrendUniverse) != 15 {
		t.Fatalf("TrendUniverse: got %d instruments, want 15", len(TrendUniverse))
	}
	wantClusters := map[string]int{
		"rates": 3, "metals": 2, "energy": 2, "commodity": 3, "fx": 3, "intl_equity": 2,
	}
	got := map[string]int{}
	seen := map[string]bool{}
	for _, inst := range TrendUniverse {
		if inst.Ticker == "" || inst.Cluster == "" {
			t.Errorf("instrument missing field: %+v", inst)
		}
		if seen[inst.Ticker] {
			t.Errorf("duplicate ticker %q in TrendUniverse", inst.Ticker)
		}
		seen[inst.Ticker] = true
		got[inst.Cluster]++
	}
	for cluster, want := range wantClusters {
		if got[cluster] != want {
			t.Errorf("cluster %q: got %d members, want %d", cluster, got[cluster], want)
		}
	}
	if len(got) != len(wantClusters) {
		t.Errorf("got %d clusters, want %d (%v)", len(got), len(wantClusters), got)
	}
}

func TestClusterOf(t *testing.T) {
	cases := map[string]string{
		"TLT": "rates", "IEF": "rates", "TIP": "rates",
		"GLD": "metals", "SLV": "metals",
		"USO": "energy", "UNG": "energy",
		"DBC": "commodity", "DBA": "commodity", "DBB": "commodity",
		"UUP": "fx", "FXE": "fx", "FXY": "fx",
		"EEM": "intl_equity", "EFA": "intl_equity",
	}
	for ticker, want := range cases {
		if got := ClusterOf(ticker); got != want {
			t.Errorf("ClusterOf(%q): got %q, want %q", ticker, got, want)
		}
	}
	if got := ClusterOf("tlt"); got != "rates" {
		t.Errorf("ClusterOf must be case-insensitive: ClusterOf(\"tlt\")=%q, want rates", got)
	}
	if got := ClusterOf("SPY"); got != "" {
		t.Errorf("ClusterOf(\"SPY\"): got %q, want \"\" (not in universe)", got)
	}
}

func TestTrendUniverseTickers(t *testing.T) {
	tickers := TrendUniverseTickers()
	if len(tickers) != len(TrendUniverse) {
		t.Fatalf("TrendUniverseTickers: got %d, want %d", len(tickers), len(TrendUniverse))
	}
	for i, inst := range TrendUniverse {
		if tickers[i] != inst.Ticker {
			t.Errorf("ticker[%d]: got %q, want %q", i, tickers[i], inst.Ticker)
		}
	}
}

func TestInTrendUniverse(t *testing.T) {
	if !InTrendUniverse("EEM") {
		t.Errorf("EEM must be in the universe")
	}
	if !InTrendUniverse("eem") {
		t.Errorf("InTrendUniverse must be case-insensitive")
	}
	if InTrendUniverse("TSLA") {
		t.Errorf("TSLA must not be in the universe")
	}
}
