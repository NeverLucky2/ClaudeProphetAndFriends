import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tagCandidates } from './coil-shadow-llm.mjs';

const cands = [
  { name: 'AMGN', rsi2: 2.2, sma5Gap: -1.9, sma200Gap: 6.1, lastClose: 355 },
  { name: 'VRTX', rsi2: 6.5, sma5Gap: -2.2, sma200Gap: 6.3, lastClose: 476 },
];

function fakeClient(text, { failFirst = false } = {}) {
  let calls = 0;
  return { messages: { create: async () => {
    calls += 1;
    if (failFirst && calls === 1) throw new Error('transient');
    return { content: [{ type: 'text', text }] };
  } } };
}

test('parses strict JSON tags', async () => {
  const text = JSON.stringify({ per_name: [
    { ticker: 'AMGN', fire_early: true, reason: 'deep oversold' },
    { ticker: 'VRTX', fire_early: false, reason: 'not yet' }] });
  const { tags } = await tagCandidates(cands, { client: fakeClient(text), model: 'm' });
  assert.deepEqual(tags, { AMGN: 'fire_early', VRTX: 'declined' });
});

test('retries once then succeeds', async () => {
  const text = JSON.stringify({ per_name: [{ ticker: 'AMGN', fire_early: true, reason: 'x' },
    { ticker: 'VRTX', fire_early: false, reason: 'y' }] });
  const { tags } = await tagCandidates(cands, { client: fakeClient(text, { failFirst: true }), model: 'm' });
  assert.equal(tags.AMGN, 'fire_early');
});

test('missing name in response defaults to declined (never fabricates a fire)', async () => {
  const text = JSON.stringify({ per_name: [{ ticker: 'AMGN', fire_early: true, reason: 'x' }] });
  const { tags } = await tagCandidates(cands, { client: fakeClient(text), model: 'm' });
  assert.equal(tags.VRTX, 'declined');
});
