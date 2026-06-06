// scripts/coil-opt-overlay.mjs
// Per-structure option overlay P&L for the Coil tape. State-dependent exit IV (leverage effect:
// vol falls on bounces, rises on losers). Calls priced at Coil's stock exit; CSP primary = hold
// to expiry (full theta), secondary = mirror Coil's stock exit (where the loser spike bites).
import { bsPrice } from './coil-opt-bsm.mjs';

export function exitIV(ivEntry, S0, S1, crush, spike) {
  return S1 >= S0 ? ivEntry * (1 - crush) : ivEntry * (1 + spike);
}

export function callPnl({ S0, S1, daysHeld, ivEntry, dte, r, crush, spike, spreadPct }) {
  const entry = bsPrice('call', S0, S0, dte / 365, r, ivEntry);
  if (entry <= 0) return null;
  const Tx = (dte - daysHeld) / 365;
  const xiv = exitIV(ivEntry, S0, S1, crush, spike);
  const exit = Tx > 0 ? bsPrice('call', S1, S0, Tx, r, xiv) : Math.max(0, S1 - S0);
  const buyNet = entry * (1 + spreadPct / 2), sellNet = exit * (1 - spreadPct / 2);
  return (sellNet - buyNet) / buyNet;                       // return on premium
}

export function putPnlMirror({ S0, S1, daysHeld, ivEntry, dte, r, crush, spike, spreadPct }) {
  const entry = bsPrice('put', S0, S0, dte / 365, r, ivEntry);
  const Tx = (dte - daysHeld) / 365;
  const xiv = exitIV(ivEntry, S0, S1, crush, spike);
  const exit = Tx > 0 ? bsPrice('put', S1, S0, Tx, r, xiv) : Math.max(0, S0 - S1);
  const premRec = entry * (1 - spreadPct / 2), buyBack = exit * (1 + spreadPct / 2);
  return (premRec - buyBack) / S0;                          // return on collateral (≈ strike)
}

export function putPnlHoldToExpiry({ S0, S_exp, ivEntry, dte, r, spreadPct }) {
  const entry = bsPrice('put', S0, S0, dte / 365, r, ivEntry);
  const premRec = entry * (1 - spreadPct / 2);
  const intrinsic = Math.max(0, S0 - S_exp);               // settle/assign at expiry intrinsic
  return (premRec - intrinsic) / S0;
}
