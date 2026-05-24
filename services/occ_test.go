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
