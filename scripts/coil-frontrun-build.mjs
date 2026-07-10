// scripts/coil-frontrun-build.mjs
// Materialise near-miss episodes across MEANREV_UNIVERSE, tagging each with SPY realized vol
// at its start date. Deliberately applies NO earnings filter: conversion is a question about
// price dynamics, not about Coil's tradeable set. (See the spec's "Shared engine" section.)
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBars } from './coil-eventstudy-bars.mjs';
import { MEANREV_UNIVERSE } from './coil-eventstudy-build.mjs';
import { enumerateEpisodes, MIN_BARS, RESOLUTION_CAP } from './coil-nearmiss-enum.mjs';
import { realizedVolSeries, VOL_WINDOW } from './coil-frontrun-vol.mjs';

export async function buildEpisodes(root, { universe = MEANREV_UNIVERSE, cap = RESOLUTION_CAP } = {}) {
  const spyBars = loadBars(root, 'SPY');
  const vol = spyBars.length > VOL_WINDOW ? realizedVolSeries(spyBars, VOL_WINDOW) : new Map();
  const out = [];
  for (const ticker of universe) {
    const bars = loadBars(root, ticker);
    if (bars.length < MIN_BARS) continue;
    for (const e of enumerateEpisodes(bars, { cap })) {
      out.push({ ticker, ...e, vol: vol.get(e.date) ?? null });
    }
  }
  return out;
}

export function summarize(episodes, { out } = {}) {
  const countByOutcome = (outcome) => episodes.filter(e => e.outcome === outcome).length;
  const fire = countByOutcome('FIRE');
  const bounce = countByOutcome('BOUNCE');
  const regime_exit = countByOutcome('REGIME_EXIT');
  const unresolved = countByOutcome('UNRESOLVED');
  const resolved = fire + bounce;
  const no_vol = episodes.filter(e => e.vol == null).length;

  const years = [...new Set(episodes.map(e => e.date.slice(0, 4)))].sort();
  const partial_years = years.length > 0 ? [years[0], years[years.length - 1]] : [];

  // Count resolved episodes in full years only (excluding first and last)
  let resolved_per_full_year = null;
  if (years.length >= 3) {
    const fullYears = years.slice(1, -1);
    const resolvedInFull = episodes.filter(
      e => (e.outcome === 'FIRE' || e.outcome === 'BOUNCE') && fullYears.includes(e.date.slice(0, 4))
    ).length;
    resolved_per_full_year = Math.round(resolvedInFull / fullYears.length);
  }

  const episodes_per_year_blended = years.length > 0 ? Math.round(episodes.length / years.length) : 0;
  const note = 'The gate counts RESOLVED episodes (FIRE or BOUNCE). resolved_per_full_year excludes the partial first and last calendar years.';

  return {
    out,
    episodes: episodes.length,
    fire,
    bounce,
    regime_exit,
    unresolved,
    resolved,
    no_vol,
    years,
    partial_years,
    episodes_per_year_blended,
    resolved_per_full_year,
    note,
  };
}

// CLI: node scripts/coil-frontrun-build.mjs [--out data/lab/coil-frontrun-episodes.json]
{
  const argv1 = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (fileURLToPath(import.meta.url) === argv1) {
    const args = process.argv.slice(2);
    const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
    const root = process.cwd();
    const out = flag('--out', join(root, 'data', 'lab', 'coil-frontrun-episodes.json'));
    const eps = await buildEpisodes(root);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(eps, null, 2));
    const summary = summarize(eps, { out });
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  }
}
