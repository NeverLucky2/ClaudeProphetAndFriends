// agent/prophet-beat-decision.js
// Pure decision logic for the Prophet (v2-options) bounded-staleness holding-beat
// skip + beat-context band labels. No I/O — the caller (preflight.js) fetches and
// passes data in. See docs/superpowers/specs/2026-05-27-prophet-beat-skip-enrich-design.md.

// OCC option symbol → underlying ticker. `TSLA260529C00442500` → `TSLA`. A plain
// stock symbol or anything that doesn't match the OCC layout passes through
// unchanged (the caller then finds no signal for it → treated as not-quiet → run).
export function occUnderlying(symbol) {
  if (typeof symbol !== 'string') return symbol;
  const m = symbol.match(/^([A-Z]+)\d{6}[CP]\d{8}$/);
  return m ? m[1] : symbol;
}
