// scripts/coil-stop-portfolio.mjs
// The Coil book engine is strategy-agnostic (candidate-based), so the timeout study's
// simulateTimeoutPortfolio is reused verbatim as the stop study's book sim. The only new piece
// is admittedByTightening — the mirror of blockedByExtension (opportunity BENEFIT, not cost).
import { simulateTimeoutPortfolio, deepestDD } from './coil-timeout-portfolio.mjs';

export { simulateTimeoutPortfolio as simulateStopPortfolio, deepestDD };

// Signals filled under the TIGHTER stop but NOT under baseline — the realized opportunity benefit
// of a tighter stop freeing slots faster. Keyed by ticker@date (mirror of blockedByExtension).
export function admittedByTightening(pBase, pTight) {
  const key = (f) => `${f.ticker}@${f.date}`;
  const filledBase = new Set(pBase.fills.map(key));
  const gained = pTight.fills.filter(f => !filledBase.has(key(f)));
  return { count: gained.length, signals: gained.map(f => ({ ticker: f.ticker, date: f.date, rsi2: f.rsi2, net: f.net })) };
}
