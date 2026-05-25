import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import {
  parseUniverseFile,
  loadProphetUniverse,
  PROPHET_UNIVERSE_FALLBACK,
} from './prophet-universe.mjs';

// parseUniverseFile is the pure parser for config/prophet_tradable_universe.txt
// — the single source of truth shared with the Go guard and universe_builder.py.
// Same rules: one ticker per line, '#' starts a comment, blanks ignored,
// upper-cased. Used to pass --universe to the screeners so they skip FMP's
// deprecated S&P500-constituents endpoint.

test('parseUniverseFile: one ticker per line, upper-cased', () => {
  assert.deepEqual(parseUniverseFile('aapl\nMSFT\nnvda'), ['AAPL', 'MSFT', 'NVDA']);
});

test('parseUniverseFile: strips full-line and inline # comments', () => {
  const raw = '# header comment\nAAPL  # mega-cap\n  # spacer\nMSFT';
  assert.deepEqual(parseUniverseFile(raw), ['AAPL', 'MSFT']);
});

test('parseUniverseFile: ignores blank and whitespace-only lines', () => {
  assert.deepEqual(parseUniverseFile('AAPL\n\n   \n\t\nMSFT'), ['AAPL', 'MSFT']);
});

test('parseUniverseFile: dedupes case-insensitively, preserving first-seen order', () => {
  assert.deepEqual(parseUniverseFile('AAPL\nmsft\nAAPL\nMSFT'), ['AAPL', 'MSFT']);
});

test('parseUniverseFile: non-string input returns empty array', () => {
  assert.deepEqual(parseUniverseFile(null), []);
  assert.deepEqual(parseUniverseFile(undefined), []);
});

test('loadProphetUniverse: reads and parses a populated file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'univ-'));
  const p = path.join(dir, 'u.txt');
  await fs.writeFile(p, '# floor\nSPY\nAAPL\nNVDA\n', 'utf-8');
  try {
    assert.deepEqual(await loadProphetUniverse(p), ['SPY', 'AAPL', 'NVDA']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('loadProphetUniverse: missing file falls back to the committed default', async () => {
  const missing = path.join(os.tmpdir(), 'definitely-not-a-real-universe-file-12345.txt');
  const result = await loadProphetUniverse(missing);
  assert.deepEqual(result, [...PROPHET_UNIVERSE_FALLBACK]);
  assert.ok(result.length > 0, 'fallback must be non-empty so the screener never hits the dead endpoint');
});

test('loadProphetUniverse: empty / comments-only file falls back to the committed default', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'univ-'));
  const p = path.join(dir, 'empty.txt');
  await fs.writeFile(p, '# only comments\n\n   \n', 'utf-8');
  try {
    assert.deepEqual(await loadProphetUniverse(p), [...PROPHET_UNIVERSE_FALLBACK]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
