// agent/options-eligibility.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextMonthlyExpiration, pickAtmContract, spreadVerdict, computeContext, evaluateCandidate } from './options-eligibility.js';

test('nextMonthlyExpiration returns a 3rd-Friday at least minDte out', () => {
  // 2026-05-30: May 3rd Friday is 2026-05-15 (past+inside minDte) -> June 3rd Friday 2026-06-19
  assert.equal(nextMonthlyExpiration('2026-05-30', 21), '2026-06-19');
  // 2026-06-01 with 21d min: 06-19 is 18 days out (< 21) -> July 3rd Friday 2026-07-17
  assert.equal(nextMonthlyExpiration('2026-06-01', 21), '2026-07-17');
});

test('pickAtmContract chooses the call with |delta| nearest 0.5 and valid quotes', () => {
  const contracts = [
    { Bid: 0, Ask: 1, Delta: 0.5 },          // bid 0 -> skip
    { Bid: 4.0, Ask: 4.2, Delta: 0.30 },
    { Bid: 5.0, Ask: 5.1, Delta: 0.52 },     // closest to 0.5
    { Bid: 6.0, Ask: 6.3, Delta: 0.70 },
  ];
  const atm = pickAtmContract(contracts);
  assert.equal(atm.Delta, 0.52);
});

test('spreadVerdict bands: reject / watch / strong', () => {
  // strong: spread 2% (<=5%), OI>=100, vol>0
  assert.equal(spreadVerdict({ Bid: 4.95, Ask: 5.05, OpenInterest: 500, Volume: 50 }, 0.10).verdict, 'strong');
  // watch: spread 8% (between 5% and 10%)
  assert.equal(spreadVerdict({ Bid: 4.8, Ask: 5.2, OpenInterest: 500, Volume: 50 }, 0.10).verdict, 'watch');
  // reject: spread 12% (>=10%)
  assert.equal(spreadVerdict({ Bid: 4.7, Ask: 5.3, OpenInterest: 500, Volume: 50 }, 0.10).verdict, 'reject');
  // reject: no contract
  assert.equal(spreadVerdict(null, 0.10).verdict, 'reject');
  // watch (not strong): tight spread but thin OI
  assert.equal(spreadVerdict({ Bid: 4.95, Ask: 5.05, OpenInterest: 10, Volume: 50 }, 0.10).verdict, 'watch');
});

test('computeContext derives realized vol + trailing move from closes (never gating)', () => {
  // 11 ascending closes -> positive trailing move, finite realized vol
  const closes = new Map();
  for (let i = 0; i < 11; i++) {
    const d = `2026-05-${String(10 + i).padStart(2, '0')}`;
    closes.set(d, 100 + i);
  }
  const ctx = computeContext(closes, '2026-05-29');
  assert.equal(ctx.lastClose, 110);
  assert.ok(ctx.realizedVol >= 0);
  assert.ok(ctx.trailing5dMove > 0);
});

test('computeContext is null-safe on an empty close map', () => {
  const ctx = computeContext(new Map(), '2026-05-29');
  assert.equal(ctx.lastClose, null);
  assert.equal(ctx.realizedVol, null);
});

test('evaluateCandidate: liquid chain -> strong; injected fetch/closes', async () => {
  const out = await evaluateCandidate('/proj', 'SMCI', {
    spreadMaxPct: 0.10, todayEtDate: '2026-05-29', expiration: '2026-06-19',
    fetchChain: async () => ([{ Bid: 4.95, Ask: 5.05, Delta: 0.5, OpenInterest: 800, Volume: 120, StrikePrice: 600 }]),
    loadCloses: async () => new Map([['2026-05-26', 590], ['2026-05-29', 600]]),
  });
  assert.equal(out.ticker, 'SMCI');
  assert.equal(out.verdict, 'strong');
  assert.equal(out.liquidity.available, true);
  assert.ok(out.liquidity.contract.oi === 800);
  assert.equal(out.expiration, '2026-06-19');
});

test('evaluateCandidate: chain fetch failure -> reject with options_data_unavailable (no throw)', async () => {
  const out = await evaluateCandidate('/proj', 'XYZ', {
    todayEtDate: '2026-05-29', expiration: '2026-06-19',
    fetchChain: async () => { const e = new Error('boom'); e.status = 429; throw e; },
    loadCloses: async () => new Map(),
  });
  assert.equal(out.verdict, 'reject');
  assert.equal(out.liquidity.available, false);
  assert.match(out.liquidity.reason, /options_data_unavailable:rate_limited/);
});

test('evaluateCandidate never throws even if loadCloses throws (context falls back)', async () => {
  const out = await evaluateCandidate('/proj', 'SMCI', {
    spreadMaxPct: 0.10, todayEtDate: '2026-05-29', expiration: '2026-06-19',
    fetchChain: async () => ([{ Bid: 4.95, Ask: 5.05, Delta: 0.5, OpenInterest: 800, Volume: 120, StrikePrice: 600 }]),
    loadCloses: async () => { throw new Error('disk exploded'); },
  });
  assert.equal(out.verdict, 'strong');          // chain still evaluated
  assert.equal(out.context.lastClose, null);     // context fell back, no crash
  assert.equal(out.context.realizedVol, null);
  assert.equal(out.context.asOf, '2026-05-29');
});
