import { resolveLiveBase, computeMargins, buildBanner, fetchJson } from './coil-preview.mjs';
import { isEvalCandidate, openEpisodes } from './lib/coil-shadow-episodes.mjs';
import { tagCandidates } from './lib/coil-shadow-llm.mjs';
import { makeFsIo } from './lib/coil-shadow-io.mjs';
import { makeAnthropicTagger } from './lib/coil-shadow-llm.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// activeFromEpisodes rebuilds the {name: openDate} active map from stored
// episodes: a name is "active" (blocks reopen) while its most recent episode is
// still 'open'. openEpisodes re-checks the 5-weekday window itself.
function activeFromEpisodes(episodes) {
  const active = {};
  for (const e of episodes) if (e.status === 'open') active[e.name] = e.openDate;
  return active;
}

// runDailyJob: idempotent per ET day. Snapshots WATCH candidates over the full
// universe, tags them with the LLM (or 'unknown' on failure), opens episodes,
// and persists. Never trades.
// `fetchImpl` is a fetchJson-shaped reader `(base, path) => Promise<{ok, status, data}>`
// that never throws (in tests: an in-memory fake; in main(): coil-preview's
// fetchJson bound to the real fetch).
export async function runDailyJob({ base, fetchImpl, tagger, io, etDate }) {
  if (await io.dailyExists(etDate)) return { status: 'already-ran', opened: 0, halted: false, gap: false };

  const cand = await fetchImpl(base, '/api/v1/meanrev/candidates');
  if (!cand.ok || !cand.data) {
    await io.writeDaily(etDate, { etDate, halt: false, bearRegime: false, spy: null, candidates: [], tags: {}, llm: null, gap: true, reason: 'candidates fetch failed' });
    return { status: 'gap', opened: 0, halted: false, gap: true };
  }
  const banner = buildBanner(!!cand.data.bear_regime, cand.data.bear_mode);
  const spy = await fetchImpl(base, '/api/v1/meanrev/signal/SPY');
  const spyRegime = spy.ok && spy.data ? { close: spy.data.last_close, sma200: spy.data.sma_200 } : null;

  if (banner.halt) {
    await io.writeDaily(etDate, { etDate, halt: true, bearRegime: true, spy: spyRegime, candidates: [], tags: {}, llm: null, gap: false });
    return { status: 'halt', opened: 0, halted: true, gap: false };
  }

  const uni = await fetchImpl(base, '/api/v1/meanrev/universe');
  const universe = uni.ok && uni.data && Array.isArray(uni.data.universe) ? uni.data.universe : [];
  const firing = new Set((cand.data.candidates || []).map((c) => c.ticker));

  const candidates = [];
  for (const name of universe) {
    if (firing.has(name)) continue; // firing = Coil enters anyway, not a near-miss
    const r = await fetchImpl(base, `/api/v1/meanrev/signal/${name}`);
    if (!(r.ok && r.data && typeof r.data.rsi_2 === 'number')) continue;
    if (!isEvalCandidate(r.data)) continue;
    const m = computeMargins(r.data);
    candidates.push({ name, rsi2: r.data.rsi_2, sma5Gap: m.sma5_gap_pct,
      sma200Gap: m.sma200_gap_pct, lastClose: r.data.last_close, _sig: r.data });
  }

  let tags = {}; let llm = { request: null, response: null, error: null };
  if (candidates.length > 0) {
    try {
      const res = await tagCandidates(candidates.map(({ _sig, ...c }) => c), tagger);
      tags = res.tags; llm = { request: res.request, response: res.response, error: null };
    } catch (e) {
      for (const c of candidates) tags[c.name] = 'unknown';
      llm = { request: null, response: null, error: String(e.message || e) };
    }
  }

  const episodes = await io.readEpisodes();
  const { episodes: opened } = openEpisodes({
    active: activeFromEpisodes(episodes),
    candidates: candidates.map((c) => c._sig),
    tags, etDate,
  });
  await io.writeEpisodes([...episodes, ...opened]);
  await io.writeDaily(etDate, { etDate, halt: false, bearRegime: !!cand.data.bear_regime,
    spy: spyRegime, candidates: candidates.map(({ _sig, ...c }) => c), tags, llm, gap: false });

  return { status: 'ok', opened: opened.length, halted: false, gap: false };
}

async function main() {
  if (process.env.COIL_SHADOW_ENABLED !== 'true') return;
  const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { base } = await resolveLiveBase();
  const io = makeFsIo(path.join(PROJECT_ROOT, 'data', 'coil-shadow'));
  const tagger = makeAnthropicTagger();
  const etDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const fetchImpl = (b, p) => fetchJson(b, p, globalThis.fetch);
  const r = await runDailyJob({ base, fetchImpl, tagger, io, etDate });
  console.log(`coil-shadow ${etDate}: ${JSON.stringify(r)}`);
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`coil-shadow failed: ${e.message}`); process.exit(1); });
}
