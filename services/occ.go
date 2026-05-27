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

// IsOptionSymbol reports whether symbol is an OCC-format option symbol
// (e.g. "TSLA251219C00400000"): an alphabetic underlying root, then a 6-digit
// expiration (YYMMDD), then a single 'C' or 'P', then an 8-digit strike. Bare
// equity tickers ("QQQ") and empty strings return false. Used to gate
// equity-only paths (e.g. managed positions, the stock quote endpoint) away
// from option symbols, which those endpoints reject as "invalid symbol".
func IsOptionSymbol(symbol string) bool {
	root := ParseOCCUnderlying(symbol)
	if root == "" {
		return false
	}
	rest := symbol[len(root):] // ASCII root, so byte len == rune count
	if len(rest) != 15 {       // 6 (date) + 1 (C/P) + 8 (strike)
		return false
	}
	for i := 0; i < 6; i++ {
		if rest[i] < '0' || rest[i] > '9' {
			return false
		}
	}
	if rest[6] != 'C' && rest[6] != 'P' {
		return false
	}
	for i := 7; i < 15; i++ {
		if rest[i] < '0' || rest[i] > '9' {
			return false
		}
	}
	return true
}
