package services

import (
	"os"
	"strings"
)

// SymbolSet builds an upper-cased membership set from a ticker slice, trimming
// whitespace and dropping empty entries. Used to turn the Go-constant agent
// universes (MeanRevUniverse, DriftUniverse) into the map form the trade guard
// consumes.
func SymbolSet(tickers []string) map[string]bool {
	out := make(map[string]bool, len(tickers))
	for _, t := range tickers {
		if s := strings.ToUpper(strings.TrimSpace(t)); s != "" {
			out[s] = true
		}
	}
	return out
}

// LoadTradableUniverse reads a tradable-floor file (one ticker per line, '#'
// comments and blank lines ignored, inline '#...' trimmed, upper-cased) into a
// membership set. A missing file returns an empty map and NO error: absence
// means "not configured yet", and the universe gate treats an empty set as
// disabled (fail open). Only a genuine read error (permissions, etc.) returns
// an error.
func LoadTradableUniverse(path string) (map[string]bool, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]bool{}, nil
		}
		return nil, err
	}
	out := map[string]bool{}
	for _, raw := range strings.Split(string(data), "\n") {
		line := raw
		if i := strings.Index(line, "#"); i >= 0 {
			line = line[:i]
		}
		if t := strings.ToUpper(strings.TrimSpace(line)); t != "" {
			out[t] = true
		}
	}
	return out, nil
}
