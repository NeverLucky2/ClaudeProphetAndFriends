// scripts/ema-signal.mjs
// Deterministic EMA-pullback signal. Episode-welded (the dip and the reclaim must be the
// same pullback) and lookahead-free (the historical dip close is compared to the EMA as of
// that bar, never as of today). direction: +1 long, -1 short.
import { ema } from './ema-indicators.mjs';

export function signalContext(bars, fast, slow) {
  const closes = bars.map(b => b.close);
  return { fast: ema(closes, fast), slow: ema(closes, slow), closes };
}

function ready(ctx, i) { return ctx.fast[i] != null && ctx.slow[i] != null; }

// First reclaim of EMA_fast at idx in `direction`, with EMA ready and trend intact.
function reclaimedAt(ctx, i, direction) {
  if (!ready(ctx, i) || !ready(ctx, i - 1)) return false;
  const c = ctx.closes[i], cPrev = ctx.closes[i - 1];
  if (direction === 1) return c > ctx.fast[i] && cPrev <= ctx.fast[i - 1] && ctx.fast[i] > ctx.slow[i];
  return c < ctx.fast[i] && cPrev >= ctx.fast[i - 1] && ctx.fast[i] < ctx.slow[i];
}

// Most-recent bar in [idx-W, idx-1] whose close pierced BOTH EMAs (as of that bar), in the
// pullback direction (long: below min; short: above max). Returns its index or -1.
function lastPierceBar(ctx, idx, W, direction) {
  for (let d = idx - 1; d >= Math.max(0, idx - W); d -= 1) {
    if (!ready(ctx, d)) continue;
    const c = ctx.closes[d];
    if (direction === 1 && c < Math.min(ctx.fast[d], ctx.slow[d])) return d;
    if (direction === -1 && c > Math.max(ctx.fast[d], ctx.slow[d])) return d;
  }
  return -1;
}

// True iff today is a reclaim, there is a qualifying pierce in window, but an INTERVENING
// reclaim already consumed it (so today is a stale pairing). Reported for the sanity count.
export function isStalePair(bars, idx, { fast, slow, W, direction, ctx }) {
  const cx = ctx || signalContext(bars, fast, slow);
  if (!reclaimedAt(cx, idx, direction)) return false;
  const d = lastPierceBar(cx, idx, W, direction);
  if (d < 0) return false;
  for (let j = d + 1; j < idx; j += 1) if (reclaimedAt(cx, j, direction)) return true;
  return false;
}

export function emaPullbackFiresAt(bars, idx, { fast, slow, W, direction, ctx }) {
  const cx = ctx || signalContext(bars, fast, slow);
  if (!reclaimedAt(cx, idx, direction)) return false;
  const d = lastPierceBar(cx, idx, W, direction);
  if (d < 0) return false;
  for (let j = d + 1; j < idx; j += 1) if (reclaimedAt(cx, j, direction)) return false; // welded: first reclaim only
  return true;
}
