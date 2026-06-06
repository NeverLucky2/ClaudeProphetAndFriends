// scripts/orb-indicators.mjs
// Session VWAP for the ORB study: cumulative Σ(typical_price·vol)/Σ(vol) from the RTH open,
// aligned to the session bars. A volume-weighted ratio is robust to IEX undersampling.
export function sessionVWAP(bars) {
  const out = new Array(bars.length).fill(null);
  let pv = 0, vv = 0, last = null;
  for (let i = 0; i < bars.length; i += 1) {
    const tp = (bars[i].high + bars[i].low + bars[i].close) / 3;
    const vol = bars[i].volume || 0;
    pv += tp * vol; vv += vol;
    out[i] = vv > 0 ? pv / vv : (last ?? tp);
    last = out[i];
  }
  return out;
}
