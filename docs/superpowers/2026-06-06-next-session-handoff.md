# Next-Session Handoff — Fleet correlation diagnostic, then a new uncorrelated premium

Paste the block below into a fresh session to continue the quant-research effort. Context lives in
auto-memory (MEMORY.md) which the next session loads automatically.

---

Continuing a multi-session quant-research effort on my personal trading "fleet" (I'm on PAPER
until ~Oct 2026 — this is for learning, nothing goes live). **Before doing anything, read your
auto-memory MEMORY.md and these entries in full:** `fleet-uncorrelated-ballast-pivot`,
`coil-runtime-and-records`, `cross-agent-correlation-view-blocked`,
`foundation-measurement-lifecycle-status`, `ema-pullback-backtest-project`,
`orb-backtest-project`, `coil-options-overlay-project`, `capital-allocation-reconciled`,
`user-risk-philosophy-paper-phase`, `subagent-model-preference`, `workflow-preferences`,
`fmp-api-key-location`, `shared-root-worktree-collision`, `claude-commits-must-reach-local-main`.

**One-line frame:** I've accepted I won't find secret alpha as an individual; the goal is to
harvest small, known, persistent, behaviorally/structurally-sourced premia that are UNCORRELATED
to my tech-heavy personal book (the "ballast" thesis), at a capacity only an individual can use,
with mechanical discipline. We just ran three pre-registered lab studies — EMA-pullback (REJECT),
ORB (REJECT), Coil-options-overlay (calls and puts both fail to beat just holding the Coil stock)
— all merged read-only to local main. Coil (RSI(2) mean-reversion) is my one validated edge.

**Workflow for EVERY subproject below (non-negotiable):** brainstorming skill FIRST — do NOT build
before I approve a design — then writing-plans, then subagent-driven-development with **Haiku**
implementers, in an ISOLATED git worktree **branched from LOCAL main** (NOT origin/main; the reused
lab modules — coil-threshold-metrics, ema-beta, coil-eventstudy-bars, etc. — exist on local main
only). Pre-registered lab-study style (hash-locked where it fits), honest friction + correlation,
an honest REJECT always on the table, squash-merge to local main when done, `data/lab/*` is
git-ignored (only `docs/lab/*-RESULTS.md` is committed). Source the project-root `.env` for
FMP_API_KEY before any FMP script. Everything stays paper/lab — do NOT touch live agents.

Work these IN ORDER:

**SUBPROJECT 1 (GATE — before any new premium): measure whether my current agents are actually
uncorrelated.** Fleet: Coil (short-term mean-reversion, equities), Turtle (cross-asset trend on
macro ETFs), Drift (PEAD/continuation), defensive-Prophet (triggered long-vol QQQ put-spread
hedge).
- **CRITICAL data caveat — don't waste time on live P&L:** per-agent live P&L is unusable (the
  DBSegmentPnL daily-mark writer only merged ~2026-05-31, so the live series is ~a week long, and
  the earlier cross-agent-correlation diagnostic was BLOCKED for lack of per-agent P&L — see
  `cross-agent-correlation-view-blocked`). **Recommended approach: RECONSTRUCT each agent's return
  stream by backtesting its strategy logic over a common multi-year window on the on-disk
  equity/ETF + FMP data we already have, then correlate those.** Note: Coil already has a
  reconstructed tape (`data/lab/coil-threshold-instances.json`); Turtle/Drift/defensive-Prophet
  will likely need their signal logic ported into the JS lab (as `coil-threshold-build` did for
  Coil) — scope that in the brainstorm, it may be most of the work.
- **Deliverable:** a correlation matrix among the four lanes + each lane's correlation/beta to the
  tech book (QQQ), AND — applying the lesson from the ORB/EMA studies — **conditional/crisis
  correlation** (e.g. QQQ worst-decile weeks), not just full-sample Pearson (ballast strategies are
  low-corr on average but co-move in tails). Output which lanes are genuinely diversifying, which
  secretly overlap, and where the real ballast gaps are. **No new data/API required.**

**SUBPROJECT 2 (CONTINGENT on what Subproject 1 finds): lab-test the first new premium that fills
a real gap.** Default if a rates/carry-shaped gap exists = **bond carry / yield-curve roll-down on
bond ETFs**, computed from FMP's treasury-rates endpoint (**no new API**); pre-register it like the
Coil studies and explicitly check it isn't just Turtle's rates-trend in a different hat (correlate
the carry returns against Turtle's rates sleeve).
- **Data-wall notes (already scoped — do NOT re-derive):** merger-arb needs deal TERMS FMP doesn't
  cleanly provide; commodity/FX carry needs futures term-structure we don't have; CEF
  discount-to-NAV needs NAV history not on FMP (free source: CEFConnect). My budget is modest but I
  can justify a small/free data add for learning — bring me the cheapest option that fills the
  biggest gap, **free-first** (CEFConnect NAV for a CEF-discount-reversion sleeve is the
  lowest-cost genuinely-diversifying add if Subproject 1 shows I need non-equity idiosyncratic
  exposure). **Get my approval before any spend.**

Start with Subproject 1, and brainstorm its design with me before writing any code.

---
