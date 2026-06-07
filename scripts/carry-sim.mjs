// Monthly IEF↔cash sim → daily mark-to-market. Position for month X = decision at end of X-1
// (no look-ahead); cash during X accrues that prior month-end's m3 (zero price vol). Friction
// (round trip) charged once on the exit day of each hold episode.
import { roundTripCost } from './carry-friction.mjs';

// monthEndRows ascending [{date,...,m3}], decisions [{month,hold}] aligned to the SAME month-ends.
// Returns Map<'YYYY-MM', {hold, cashRate}> effective DURING that calendar month.
export function buildMonthPlan(monthEndRows, decisions, { cash = 'm3' } = {}) {
  const plan = new Map();
  const decByMonth = new Map(decisions.map((d) => [d.month, d]));
  for (let i = 0; i < monthEndRows.length; i += 1) {
    const cur = monthEndRows[i];
    const curMonth = cur.date.slice(0, 7);
    const dec = decByMonth.get(curMonth);
    // the decision/rate at end of curMonth governs the FOLLOWING calendar month
    const [y, m] = curMonth.split('-').map(Number);
    const nextMonth = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
    plan.set(nextMonth, { hold: !!(dec && dec.hold), cashRate: cur[cash] });
  }
  return plan;
}

export function simulateCarry(iefBars, monthPlan, { stressMult = 1, start, end } = {}) {
  const bars = iefBars.filter((b) => (!start || b.date >= start) && (!end || b.date <= end));
  const daily = []; const episodes = [];
  let holding = false; let epStart = null; let epLast = null;
  for (let i = 1; i < bars.length; i += 1) {
    const b = bars[i];
    const pm = monthPlan.get(b.date.slice(0, 7));
    const wantHold = !!(pm && pm.hold);
    const cashRate = pm ? pm.cashRate : null;
    let ret;
    if (wantHold) {
      ret = bars[i].close / bars[i - 1].close - 1;
      if (!holding) { holding = true; epStart = b.date; }
      epLast = b.date;
    } else {
      ret = cashRate == null ? 0 : (cashRate / 100) / 252; // accrued, zero price vol
      if (holding) {
        ret -= roundTripCost(stressMult);                  // exit cost on the transition day
        episodes.push({ start: epStart, end: epLast });
        holding = false; epStart = null; epLast = null;
      }
    }
    daily.push({ date: b.date, ret, active: wantHold });
  }
  if (holding) episodes.push({ start: epStart, end: epLast });
  return { daily, episodes };
}
