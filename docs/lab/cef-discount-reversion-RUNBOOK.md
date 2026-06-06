# CEF Discount-Reversion — RUNBOOK

Pre-registered lab study (Subproject 2): does a long-only CEF discount-to-NAV mean-reversion sleeve
fill Subproject 1's equity-selloff ballast gap? Dual KEEP gate (friction-net holdout edge AND
orthogonality to QQQ + the fleet lanes). **VERDICT: REJECT.** Lab-only, read-only, no deploy.
Spec: `docs/superpowers/specs/2026-06-06-cef-discount-reversion-design.md`.

## Verdict (one paragraph)

REJECT on all four gates. The per-trade discount narrowing is real and reversion-attributed
(mean per-trade net +1.03% = NAV-move +0.90% + Δdiscount +1.34% − friction), but as a **holdable
sleeve** it has **no friction-surviving edge** (holdout weekly mean +0.05%, 95% CI [−0.10%, +0.20%];
negative at 2× friction), carries **β 0.37 / ρ 0.64 to QQQ**, **co-crashes −1.79%** (CI [−2.28%,
−1.32%]) in QQQ worst-quintile weeks, and overlaps Drift (ρ 0.37). Regime-chase confirms the
rate-break trap (2022 entries −1.03%); only **3 independent widening episodes** carry the sample.
The premium does NOT fill the equity-selloff gap — long-only wide-discount CEFs *widen* it.

## Re-run

```bash
# from repo root, FMP_API_KEY in env (for the orthogonality gate's QQQ + lane regeneration)
node scripts/cef-fetch.mjs                 # CEFConnect weekly NAV/price/discount -> data/lab/cef-cache/ (keyless)
export $(grep -E '^FMP_API_KEY=' .env | xargs)
node scripts/fleet-fetch-bars.mjs          # S1 caches for QQQ + lane regeneration (if absent)
node scripts/fleet-fetch-earnings.mjs
node scripts/cef-score.mjs --root .         # prereg -> sim -> dual gate -> docs/lab/cef-discount-reversion-RESULTS.md
node --test scripts/cef-*.test.mjs          # 15 unit tests
```

`data/lab/*` git-ignored (cef-cache, prereg JSON); only `docs/lab/cef-discount-reversion-{RESULTS,RUNBOOK}.md` committed.

## Module map

| Module | Role |
|---|---|
| `cef-universe.mjs` | curated liquid CEF list (~50) + liquidity tiers (survivorship-biased — see limits) |
| `cef-bars.mjs` | lab cache loader (weekly {date,price,nav,discount}) |
| `cef-fetch.mjs` | CEFConnect `pricinghistory/{T}/5Y` backfill (controller; distributions confirmed unavailable) |
| `cef-signal.mjs` | discount z-score vs trailing-52w norm (entry z≤−1.5, exit z≥0/26w) |
| `cef-friction.mjs` | tiered half-spread (liquid 25 / mid 50 / thin 100 bps) + 2× stress |
| `cef-sim.mjs` | long-only sim → friction-net weekly **price-change** series + NAV-move/Δdiscount decomposition |
| `cef-prereg.mjs` | hash-locked methodology |
| `cef-score.mjs` | orchestrator: prereg → train/holdout edge gate + orthogonality gate (reuse S1 `fleet-correlate`) → KEEP/REJECT (controller) |

## Limits / loud caveats (also in RESULTS)

- **Return basis = price-change** (NAV-move + Δdiscount), friction-net — **excludes distribution yield** (CEFConnect distribution endpoints 404). Conservative for KEEP; the REJECT stands regardless (yield carries credit-β and wouldn't help the orthogonality gate).
- **Survivorship bias, upward / toward false-KEEP** — 2026 current-snapshot universe; liquidated/merged distressed wide-discount CEFs are invisible. The study still REJECTed *despite* this upward bias — a strong REJECT.
- **5Y weekly (2021–2026), no 2020 COVID;** train/holdout midpoint straddles the 2022–23 rate-regime break (train half reported alongside).
- Edge rests on only ~3 independent discount-widening episodes → any apparent edge is low-confidence by construction.

## Deferred (would only be worth it on a KEEP — moot given REJECT)

- NAV-hedge overlay (short the underlying ETF to isolate Δdiscount) — but the orthogonality gate already shows the unhedged sleeve co-crashes, so a hedge changes the product, not the gap-fill verdict.
- Total-return (distributions) if the CEFConnect endpoint is later found — non-gating; carries credit-β.
- Cross-sectional / short variants.
