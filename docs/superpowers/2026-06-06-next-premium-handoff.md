# Next-Session Handoff — the next ballast premium (equity-selloff gap still open)

Paste the block below into a fresh session to continue. State lives in auto-memory (MEMORY.md), loaded automatically.

---

Continuing a multi-session quant-research effort on my personal trading "fleet" (PAPER until ~Oct 2026 — this is for learning, nothing goes live). **Before doing anything, read your auto-memory MEMORY.md and these entries in full:** `fleet-uncorrelated-ballast-pivot`, `fleet-correlation-diagnostic-done`, `cef-discount-reversion-rejected`, `coil-runtime-and-records`, `capital-allocation-reconciled`, `user-risk-philosophy-paper-phase`, `subagent-model-preference`, `workflow-preferences`, `fmp-api-key-location`, `shared-root-worktree-collision`, `claude-commits-must-reach-local-main`.

**One-line frame:** I've accepted I won't find secret alpha as an individual; the goal is to harvest small, known, persistent, behaviorally/structurally-sourced premia that are UNCORRELATED to my tech-heavy personal book (the "ballast" thesis), at a capacity only an individual can use, with mechanical discipline.

**Where we are (both prior subprojects DONE, merged to local main, lab-only/no-deploy):**
- **Subproject 1 (the GATE)** — reconstructed all four fleet lanes by backtest + a correlation/β + crisis-conditional diagnostic (local main `b0943f2`). Finding: the fleet's real gap is **equity-selloff protection** — Coil co-crashes with the tech book in the tail, Turtle is the one genuine diversifier, only the def-Prophet hedge cushions. The reusable engine is `scripts/fleet-correlate.mjs` (β+CI, crisis-mean+CI, rotation band, lane-ρ) + `fleet-align`, `fleet-prereg`, the lane builders.
- **Subproject 2 (first new premium)** — long-only **CEF discount-reversion**, REJECTED on all four gates (local main `7fa4c26`): no friction-net edge + β0.37/ρ0.64 to QQQ + co-crashes −1.79% + overlaps Drift. The per-trade reversion was real but doesn't survive as a holdable orthogonal sleeve. **The equity-selloff ballast gap is STILL OPEN.**

**This session: brainstorm + lab-test the NEXT genuinely-orthogonal premium candidate to fill that gap.** Do NOT auto-pick — brainstorm the best candidate first, honestly weighing whether any free/cheap option is actually orthogonal enough, or whether to step back.
- **Default candidate = bond carry / yield-curve roll-down** on bond ETFs (FMP treasury-rates endpoint, **no new API**). Caveats to confront head-on in the brainstorm: it's rates-shaped and **overlaps Turtle's rates cluster** (TLT/IEF/TIP), so the orthogonality bet is weaker than CEF's was *supposed* to be — pre-register an explicit "isn't this just Turtle's rates-trend in a different hat" check (correlate the carry returns vs a Turtle rates-only sleeve). In growth-scare selloffs bonds rally (good), but in inflation/rate-shock selloffs (2022) they co-crash (bad) — so it may only *partially* fill the gap.
- **Data walls (already scoped — don't re-derive):** merger-arb needs deal TERMS FMP doesn't provide; commodity/FX carry needs futures term-structure we don't have; CEF discount-reversion is DONE/rejected. If you think a small free/cheap data-add beats bond carry, bring me the cheapest option free-first and **get my approval before any spend.**

**Non-negotiable workflow (same as the last two subprojects):** brainstorming skill FIRST — do NOT build before I approve a design — then writing-plans, then subagent-driven-development with **Haiku** implementers, in an ISOLATED git worktree **branched from LOCAL main** (NOT origin; the reused S1/S2 lab modules live on local main only — branch from local HEAD via git-worktree-add + EnterWorktree path, as the last sessions did). **Reuse the established dual-gate pattern:** friction-net holdout edge (block-bootstrap) AND orthogonality (reuse the S1 `fleet-correlate` engine vs QQQ + the existing lanes, |ρ|<0.3 each). Pre-registered/hash-locked, honest friction (primary gate, not afterthought), an honest REJECT always on the table, squash-merge to local main when done, `data/lab/*` git-ignored (only `docs/lab/*-RESULTS.md` + `-RUNBOOK.md` committed). Source the project-root `.env` for `FMP_API_KEY`. Everything stays paper/lab — do NOT touch live agents.

Start with the brainstorm: which premium, and is it actually worth testing given the gap?

---
