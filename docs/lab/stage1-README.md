# Stage 1 — Directional Signal Experiment (run order)

Spec: `docs/superpowers/specs/2026-05-31-directional-signal-stage1-design.md`
Plan: `docs/superpowers/plans/2026-05-31-directional-signal-stage1.md`

## Order of operations
1. **Verify FMP history depth** (spec §1.2) — without multi-year timestamped news this stops here.
2. **Fetch catalysts:** `python .claude/skills/catalyst-news/scripts/fetch_catalyst_news.py --from <YYYY-MM-DD> --to <YYYY-MM-DD>` (needs FMP_API_KEY) → `data/lab/catalysts-<range>.json`.
3. **Build firings** (bars from `data/bar-cache`), **thin**, **split 50/50** by the median date.
4. **Develop on TRAIN only:** compute `derived_breakeven_train`; set `HR0_final = max(0.55, that)`. Confirm achievable independent n vs the required 235/split.
5. **Freeze:** `node scripts/stage1-prereg.mjs --split-date <median>` → `data/lab/stage1-preregistration.json` (commit it).
6. **Score the holdout ONCE:** `cat firings.json | node scripts/stage1-score.mjs --artifact data/lab/stage1-preregistration.json --split holdout --hr0-final <HR0_final>`.
7. **Read the verdict:** PASS → Stage 2 design; FAIL or UNDERPOWERED → STOP. Do not re-score.

## Discipline
- The holdout is scored exactly once. Re-running after seeing results voids the pre-registration.
- `k` (variant count) is locked in the artifact; abandoning a peeked variant does not reduce it.
- UNDERPOWERED is a legitimate, publishable result — never relax HR0/HR1/thinning to escape it.
