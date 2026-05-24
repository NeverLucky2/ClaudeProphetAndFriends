// Pure builder for decisive_actions records. Stamps the ruleset epoch.
// Spec: docs/superpowers/specs/2026-05-23-trade-ruleset-epoch-stamp-design.md
export function buildDecisionRecord(args, ctx, now = new Date()) {
  return {
    timestamp: now.toISOString(),
    sandbox_id: ctx.sandboxId,
    account_id: ctx.accountId,
    // harness exports '' (not undefined) when unset; `|| null` normalises both
    // '' and undefined to null — the sentinel Spec C uses for un-stamped records.
    // Do NOT change to `??`: that would let '' through and break the un-stamped check.
    strategyId: ctx.strategyId || null,
    strategyVersion: ctx.strategyVersion || null,
    action: args.action,
    symbol: args.symbol || null,
    reasoning: args.reasoning,
    market_data: args.market_data || {},
  };
}
