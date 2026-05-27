// Per-beat token/cost accounting for the LLM heartbeat. opencode's step_finish
// event carries token usage as { input, output, reasoning, cache: { read, write } }
// (sst/opencode AssistantMessageTokens — note there is NO `total` field, so the
// total must be computed from the parts). Split out as pure functions so the
// math + formatting are unit-testable without the harness, mirroring
// fills-summary.js / prophet-beat-decision.js.

// Pull a normalized token delta out of one step_finish `part.tokens` object.
// Every field defaults to 0 and non-finite values coerce to 0 (defensive against
// provider/shape drift). Pure.
export function extractTokenDelta(partTokens) {
  const t = partTokens || {};
  const cache = t.cache || {};
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    input: num(t.input),
    output: num(t.output),
    reasoning: num(t.reasoning),
    cacheRead: num(cache.read),
    cacheWrite: num(cache.write),
  };
}

// Compact human count: 800 → "800", 1200 → "1.2k", 42000 → "42.0k".
function fmtK(n) {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(Math.round(v));
}

// Render the one-line beat cost recap. `total` is computed from the parts (input
// + output + both cache buckets; reasoning excluded to avoid double-counting
// output). The cache-hit % is the share of *input* tokens served from cache —
// cacheRead / (cacheRead + cacheWrite + input) — which is the number to watch to
// confirm prompt caching is actually landing on the hot beats. Zero input → n/a
// (no division). Pure.
export function formatBeatCostLine({ cost = 0, input = 0, output = 0, cacheRead = 0, cacheWrite = 0 } = {}) {
  const total = input + output + cacheRead + cacheWrite;
  const inputTotal = cacheRead + cacheWrite + input;
  const hit = inputTotal > 0 ? `${Math.round((cacheRead / inputTotal) * 100)}%` : 'n/a';
  return `Beat cost: $${Number(cost).toFixed(4)} | tokens ${fmtK(total)} `
    + `(in ${fmtK(input)} · out ${fmtK(output)} · cache ${fmtK(cacheRead)} read / ${fmtK(cacheWrite)} write) `
    + `| cache hit ${hit}`;
}
