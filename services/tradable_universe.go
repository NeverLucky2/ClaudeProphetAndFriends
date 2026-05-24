package services

import (
	"os"
	"strings"
)

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
