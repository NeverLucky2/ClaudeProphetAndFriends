package services

import "testing"

func TestIsPaperBaseURL(t *testing.T) {
	cases := []struct {
		url         string
		wantPaper   bool
		wantKnown   bool
	}{
		{"https://paper-api.alpaca.markets", true, true},
		{"https://paper-api.alpaca.markets/", true, true},
		{"https://api.alpaca.markets", false, true},
		{"https://api.alpaca.markets/v2", false, true},
		{"HTTPS://API.ALPACA.MARKETS", false, true},
		{"", false, false},
		{"https://example.com", false, false},
	}
	for _, c := range cases {
		gotPaper, gotKnown := IsPaperBaseURL(c.url)
		if gotPaper != c.wantPaper || gotKnown != c.wantKnown {
			t.Errorf("IsPaperBaseURL(%q) = (%v,%v), want (%v,%v)",
				c.url, gotPaper, gotKnown, c.wantPaper, c.wantKnown)
		}
	}
}

// A live URL flagged as paper is the false-comfort failure the spec names:
// real money traded while every log line reports "paper". Must refuse to start.
func TestNewAlpacaTradingService_RejectsModeMismatch(t *testing.T) {
	if _, err := NewAlpacaTradingService("k", "s", "https://api.alpaca.markets", true); err == nil {
		t.Fatal("live baseURL with isPaper=true must return an error, got nil")
	}
	if _, err := NewAlpacaTradingService("k", "s", "https://paper-api.alpaca.markets", false); err == nil {
		t.Fatal("paper baseURL with isPaper=false must return an error, got nil")
	}
}

func TestNewAlpacaTradingService_RejectsUnknownBaseURL(t *testing.T) {
	if _, err := NewAlpacaTradingService("k", "s", "https://example.com", true); err == nil {
		t.Fatal("unrecognized baseURL must fail closed, got nil error")
	}
}

func TestNewAlpacaTradingService_AcceptsConsistentModes(t *testing.T) {
	s, err := NewAlpacaTradingService("k", "s", "https://paper-api.alpaca.markets", true)
	if err != nil {
		t.Fatalf("consistent paper config must succeed, got %v", err)
	}
	if !s.IsPaper() {
		t.Error("IsPaper() = false, want true")
	}

	live, err := NewAlpacaTradingService("k", "s", "https://api.alpaca.markets", false)
	if err != nil {
		t.Fatalf("consistent live config must succeed, got %v", err)
	}
	if live.IsPaper() {
		t.Error("IsPaper() = true for live account, want false")
	}
}
