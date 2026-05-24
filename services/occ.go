package services

import "unicode"

// ParseOCCUnderlying extracts the underlying root from an OCC option symbol
// (e.g. "TSLA251219C00400000" -> "TSLA"). The root is the leading run of
// ASCII letters before the 6-digit expiration date. A bare ticker with no
// option suffix returns itself. Returns "" when no leading-letter root exists.
//
// Limitation (see spec): assumes an all-letter root. Roots containing digits
// or non-standard broker formats are not handled; the universe gate fails
// closed when the resolved root is empty, so an unparseable symbol is rejected
// rather than silently allowed.
func ParseOCCUnderlying(symbol string) string {
	end := 0
	for _, r := range symbol {
		if !unicode.IsLetter(r) || r > unicode.MaxASCII {
			break
		}
		end++
	}
	return symbol[:end]
}
