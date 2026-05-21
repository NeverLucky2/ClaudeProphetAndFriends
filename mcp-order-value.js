// computeOrderValue returns the dollar value used for the maxOrderValue cap.
// Extracted from mcp-server.js enforcePermissions so it can be unit-tested
// (mcp-server.js self-runs main() on import). Options single-leg orders carry a
// per-contract limit_price; real cash outlay is ×100 (OCC multiplier). Iron
// condors are excluded — they are credit spreads with their own sizing.
const OPTIONS_SINGLE_LEG_TOOLS = new Set(['place_options_order']);

export function computeOrderValue(toolName, args = {}) {
  const allocValue = args.allocation_dollars || 0;
  if (allocValue > 0) return allocValue;
  const price = args.limit_price || args.entry_price || 0;
  const qty = args.quantity || args.qty || 0;
  let value = price * qty;
  if (OPTIONS_SINGLE_LEG_TOOLS.has(toolName)) value *= 100;
  return value;
}
