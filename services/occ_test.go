package services

import "testing"

func TestParseOCCUnderlying(t *testing.T) {
	cases := []struct{ in, want string }{
		{"TSLA251219C00400000", "TSLA"},
		{"SPY251219P00500000", "SPY"},
		{"F251219C00012000", "F"},      // 1-char root
		{"GOOGL251219C00150000", "GOOGL"},
		{"NVDA", "NVDA"},               // bare underlying (no option suffix)
		{"", ""},                       // empty
		{"123456C00010000", ""},        // no alpha root -> unresolved
	}
	for _, c := range cases {
		if got := ParseOCCUnderlying(c.in); got != c.want {
			t.Errorf("ParseOCCUnderlying(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestIsOptionSymbol(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		{"TSLA251219C00400000", true},
		{"QQQ260717C00728000", true},    // the contract that failed in production
		{"F251219C00012000", true},      // 1-char root
		{"SPXW260320P05000000", true},   // longer root, put
		{"QQQ", false},                  // bare ticker
		{"AAPL", false},
		{"", false},
		{"123456C00010000", false},      // no alpha root
		{"TSLA251219X00400000", false},  // bad option-type char
		{"TSLA2512X9C00400000", false},  // non-digit in expiration
		{"TSLA25121C00400000", false},   // 5-digit date (wrong length)
		{"TSLA251219C0040000", false},   // 7-digit strike (wrong length)
		{"TSLA251219C004000000", false}, // 9-digit strike (wrong length)
	}
	for _, c := range cases {
		if got := IsOptionSymbol(c.in); got != c.want {
			t.Errorf("IsOptionSymbol(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}
