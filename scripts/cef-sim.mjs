// scripts/cef-sim.mjs
import { discountZ, entryFires, exitFires } from './cef-signal.mjs';
import { roundTripCost } from './cef-friction.mjs';

export function weeklyPriceReturn(price, prevPrice) { return price / prevPrice - 1; }

// price = nav*(1+discount). total = (1+navMove)*(1+discountChange)-1.
export function decomposeReturn(a, b) {
  const total = b.price / a.price - 1;
  const navMove = b.nav / a.nav - 1;
  const discountChange = (1 + total) / (1 + navMove) - 1;
  return { total, navMove, discountChange };
}

// barsByTicker: Map<ticker, bars[]> ascending {date,price,nav,discount}. Returns
// { weekly:[{date,ret,active}], trades:[{ticker,entryDate,exitDate,grossReturn,netReturn,navMove,discountChange}] }.
export function simulateCef(barsByTicker, { L = 52, zEnter = 1.5, timeStop = 26, maxPositions = 10, stressMult = 1, tierByTicker = {} } = {}) {
  const tickers = [...barsByTicker.keys()];
  const idx = {}; for (const t of tickers) idx[t] = new Map(barsByTicker.get(t).map((b, i) => [b.date, i]));
  const allDates = [...new Set(tickers.flatMap((t) => barsByTicker.get(t).map((b) => b.date)))].sort();
  const open = new Map();
  const weekly = []; const trades = [];

  for (let w = 0; w < allDates.length; w += 1) {
    const d = allDates[w];
    let sumRet = 0, nActive = 0;
    for (const [t, pos] of [...open]) {
      const bars = barsByTicker.get(t); const i = idx[t].get(d); if (i == null || i === 0) continue;
      const r = weeklyPriceReturn(bars[i].price, bars[i - 1].price);
      pos.weeksHeld += 1;
      const z = discountZ(bars.map((b) => b.discount), i, L);
      let ret = r;
      if (exitFires(z, pos.weeksHeld, timeStop)) {
        const cost = roundTripCost(tierByTicker[t] || 'thin', stressMult);
        ret -= cost;
        const entryBar = bars[pos.entryIdx]; const exitBar = bars[i];
        const dec = decomposeReturn(entryBar, exitBar);
        const gross = exitBar.price / entryBar.price - 1;
        trades.push({ ticker: t, entryDate: pos.entryDate, exitDate: d, grossReturn: gross, netReturn: gross - cost, navMove: dec.navMove, discountChange: dec.discountChange });
        open.delete(t);
      }
      sumRet += ret; nActive += 1;
    }
    weekly.push({ date: d, ret: nActive ? sumRet / nActive : 0, active: nActive > 0 });

    if (open.size < maxPositions) {
      const cands = [];
      for (const t of tickers) {
        if (open.has(t)) continue;
        const bars = barsByTicker.get(t); const i = idx[t].get(d); if (i == null) continue;
        const z = discountZ(bars.map((b) => b.discount), i, L);
        if (entryFires(z, zEnter)) cands.push({ t, z, i });
      }
      cands.sort((a, b) => a.z - b.z);
      for (const c of cands) { if (open.size >= maxPositions) break; open.set(c.t, { entryIdx: c.i, entryDate: d, weeksHeld: 0 }); }
    }
  }
  return { weekly, trades };
}
