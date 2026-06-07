// scripts/graduation-gate.mjs
// 2c: two-track graduation bar (spec §5). Structural track assignment, then criteria → verdict.
// Pure decision logic; the orchestrator (Task 4) feeds it 2a ledger + 2b beta. Never auto-acts.

const BALLAST_STRATEGIES = new Set(['prophet-defensive', 'harvest']); // convex hedge sleeves

// Track by structural classification (a-priori, not measured). agentId OR strategyId accepted.
export function trackOf(strategyId, _agentId) {
  return BALLAST_STRATEGIES.has(strategyId) ? 'ballast' : 'alpha';
}

// ALPHA: all must clear. m = { eligibleTrades, edgeCI:{lo,hi}, adversityCleared, durationMonths,
// deployedBeta:{point,lo,hi,n}|{insufficient,n} }. params { N, BETA_BAND, retireMonths=6 }.
export function alphaVerdict(m, { N = 20, BETA_BAND = 0.6, retireMonths = 6 } = {}) {
  const reasons = [];
  const volume = m.eligibleTrades >= N;
  const edge = m.edgeCI && m.edgeCI.lo != null && m.edgeCI.lo > 0;       // demonstrated edge
  const edgeReject = m.edgeCI && m.edgeCI.hi != null && m.edgeCI.hi <= 0; // demonstrably no edge
  const adversity = !!m.adversityCleared;
  const duration = m.durationMonths >= 3;
  // orientation: GRADUATE only if |beta| CI entirely within band; REJECT if CI lower bound on |beta|>band
  const b = m.deployedBeta || {};
  const betaKnown = !b.insufficient && b.lo != null && b.hi != null;
  const absLo = betaKnown ? Math.min(Math.abs(b.lo), Math.abs(b.hi), (b.lo <= 0 && b.hi >= 0) ? 0 : Infinity) : null;
  const inBand = betaKnown && Math.abs(b.lo) <= BETA_BAND && Math.abs(b.hi) <= BETA_BAND;
  const betaReject = betaKnown && absLo != null && absLo > BETA_BAND;

  if (edgeReject) return { verdict: 'REJECT', track: 'alpha', reason: 'edge CI upper bound <= 0 (demonstrably no edge)' };
  if (betaReject) return { verdict: 'REJECT', track: 'alpha', reason: `deployed-beta |CI| lower bound > ${BETA_BAND} (closet-beta)` };
  if (volume && edge && adversity && duration && inBand) return { verdict: 'GRADUATE', track: 'alpha', reason: 'all criteria clear' };
  if (!volume) reasons.push(`<${N} eligible trades (${m.eligibleTrades})`);
  if (!edge) reasons.push('edge CI not > 0 (not yet demonstrable)');
  if (!adversity) reasons.push('adversity floor not cleared');
  if (!duration) reasons.push(`<3mo (${m.durationMonths})`);
  if (!betaKnown) reasons.push(`deployed-beta insufficient (n=${b.n ?? 0})`); else if (!inBand) reasons.push('deployed-beta CI too wide to confirm in-band');
  if (m.durationMonths >= retireMonths) return { verdict: 'RETIRE', track: 'alpha', reason: `HOLD past ${retireMonths}mo deadline: ${reasons.join('; ')}` };
  return { verdict: 'HOLD', track: 'alpha', reason: reasons.join('; ') };
}

// BALLAST: expectancy is NOT a gate. m = { structurallyConvex, expectancy, bleedBudgetPerTrade,
// downsideBeta:{point,lo,hi,n}|{insufficient,n}, durationMonths }.
export function ballastVerdict(m, { retireMonths = 6 } = {}) {
  const reasons = [];
  const convex = !!m.structurallyConvex;
  const boundedBleed = m.expectancy >= m.bleedBudgetPerTrade;   // bleeds no more than budget
  const d = m.downsideBeta || {};
  const dKnown = !d.insufficient && d.lo != null && d.hi != null;
  const addsCrashRisk = dKnown && d.lo > 0;                     // CI lower bound > 0 → adds risk
  const stressOk = dKnown ? d.hi <= 0 : null;                   // pays/neutral when measurable
  const duration = m.durationMonths >= 3;

  if (!convex) return { verdict: 'REJECT', track: 'ballast', reason: 'not structurally convex (a hedge must be defined-risk long-premium)' };
  if (!boundedBleed) return { verdict: 'REJECT', track: 'ballast', reason: 'bleed exceeds budget' };
  if (addsCrashRisk) return { verdict: 'REJECT', track: 'ballast', reason: 'downside-beta CI lower bound > 0 (adds crash risk)' };
  // structural-only when downside sample is too sparse (D-B5): absence of a reading is HOLD, never REJECT
  if (convex && boundedBleed && duration && (stressOk === true || stressOk === null)) {
    if (stressOk === true) return { verdict: 'GRADUATE', track: 'ballast', reason: 'convex + bounded bleed + downside-beta CI <= 0' };
    reasons.push('downside-beta sample insufficient (structural-only — HOLD, not REJECT)');
  }
  if (!duration) reasons.push(`<3mo (${m.durationMonths})`);
  if (m.durationMonths >= retireMonths) return { verdict: 'RETIRE', track: 'ballast', reason: `HOLD past ${retireMonths}mo: ${reasons.join('; ')}` };
  return { verdict: 'HOLD', track: 'ballast', reason: reasons.join('; ') || 'accruing' };
}
