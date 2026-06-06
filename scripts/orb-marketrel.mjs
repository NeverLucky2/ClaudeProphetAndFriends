// scripts/orb-marketrel.mjs
// Per-trade R-unit conversions for the ORB gates. SPY window return matches the trade's fills
// (entry = open, exit = close). Market-relative uses a per-name sign-aware hedge (ema-beta).
import { residual } from './ema-beta.mjs';

export function spyWindowReturn(spyByKey, date, entryMinutes, exitMinutes) {
  const a = spyByKey.get(`${date}|${entryMinutes}`), b = spyByKey.get(`${date}|${exitMinutes}`);
  if (!a || !b) return null;
  return b.close / a.open - 1;
}

export function netR(trade, frictionBps) {
  const Rpct = trade.R / trade.entry;
  if (Rpct <= 0) return null;
  return trade.rMultiple - (frictionBps / 10000) / Rpct;
}

export function mktRelR(trade, frictionBps, beta, spyWindowRet) {
  const Rpct = trade.R / trade.entry;
  if (Rpct <= 0 || spyWindowRet == null) return null;
  const relPct = residual(trade.retPct, { direction: trade.direction, beta, benchRet: spyWindowRet });
  return (relPct - frictionBps / 10000) / Rpct;
}
