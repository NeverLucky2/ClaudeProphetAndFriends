# Coil Dynamic Capital Borrow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Coil expand from its static 7-position / 42% segment cap to a *dynamic* cap — up to 14 positions filling total account deployment to ≤ 85% — when other strategies leave account capital idle, surfacing a longer mirror list.

**Architecture:** Pure rules-prose change to `TRADING_RULES_MEANREV.md`. All Coil caps are LLM-prose the agent self-enforces each beat (the Go signal service only ranks candidates — it enforces no count/deploy/size). Editing the markdown *is* the deploy: no Go rebuild, no `.env`, no restart. The mechanism reuses a value already in Coil's Beat Context snapshot (`Portfolio | Cash`), so no code is written.

**Tech Stack:** Markdown rules file (LLM-injected prompt context). No compiler, no test runner involved in the change itself.

## Global Constraints

- **Pure prose, zero code.** Do NOT touch Go, `.env`, `data/agent-config.json` permissions, or any `.js`. If a step seems to need code, stop — the design says it doesn't.
- **Per-position size stays 6%.** Never change the 6% equal-weight or the −7% hard stop / `stop_loss_pct: 7` / `take_profit_pct: 10` values. The only knobs that move are the position *count* cap (7 → 14) and the *deployment* cap (Coil-segment 42% → total-account 85%).
- **Numbers, verbatim:** max **14** open positions; total-account deployment ceiling **85.0%**; ~**15%** buffer left for later-beating strategies.
- **Deployment formula, verbatim:** `total_deployed_pct = (portfolio_value − cash) / portfolio_value × 100`, read from the Beat Context `Portfolio | Cash` line; fall back to `get_account`. This is *total account* deployment (all strategies), NOT the Coil-segment `deployed_percent`.
- **Narrow isolation exception:** Coil may read only the single aggregate total-deployment number. It must never inspect other strategies' specific symbols, positions, or theses.
- **Memory files are outside the git repo** (`~/.claude/projects/.../memory/`) — updating them is a file write, not a commit.
- **One squashed commit** for the repo changes (workflow preference). We are on `main`; branch first, commit on the branch. For this prose change, reaching local `main` *is* the deploy (the running bot reads the file from the checkout) — final merge to `main` is handled in the finishing step with operator confirmation.
- **Commit trailer:** end the commit message with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## File Structure

- **Modify:** `TRADING_RULES_MEANREV.md` — the entire substantive change (16 edits across identity, risk-management, heartbeat, and checklist sections).
- **Modify (outside repo, no commit):** `memory/capital-allocation-reconciled.md` + `memory/MEMORY.md` — sync the dynamic-cap fact.
- **Commit alongside the rules file:** `docs/superpowers/specs/2026-07-08-coil-dynamic-capital-borrow-design.md` (already written) and this plan.
- **Out of this plan's scope:** the validation backtest (see Follow-up) — separate harness, separate artifact, non-blocking.

## Why there is no unit test

Nothing parses this file — it is injected verbatim into Coil's heartbeat prompt. There is no executable surface to assert against, and the repo adds no content-assertion tests for the other `TRADING_RULES_*.md` files (the June-24 42% bump, commit `f27b041`, shipped as a prose edit with no test). Verification is therefore (1) a grep pass proving no stale cap constants survive, (2) a re-read for internal consistency, and (3) post-deploy observation of the next live Coil beat. This matches established fleet practice.

---

### Task 1: Rewrite Coil's caps in `TRADING_RULES_MEANREV.md`

**Files:**
- Modify: `TRADING_RULES_MEANREV.md` (lines 3, 31, 196–202, 208, 221, 277, 301–302, 312–313, 329, 350–351, 369)

**Interfaces:**
- Consumes: nothing (leaf change).
- Produces: the deployed rule text Coil reads at its 15:45 ET beat. Introduces the term `total_deployed_pct` (total account, all strategies) and the constants `14` (max positions) and `85` (deployment ceiling %), replacing `coil_deployed_pct`, `7`, `42`, and `40.0`.

- [ ] **Step 1: Create the working branch**

Run:
```bash
git checkout -b coil-dynamic-capital-borrow
```
Expected: `Switched to a new branch 'coil-dynamic-capital-borrow'`

- [ ] **Step 2: Edit — header date (line 3)**

Replace:
```
**Updated:** 2026-06-24
```
with:
```
**Updated:** 2026-07-08
```

- [ ] **Step 3: Edit — identity "You do not" isolation line (line 31)**

Replace:
```
- Look at Prophet or Turtle positions when making decisions
```
with:
```
- Look at Prophet or Turtle *positions or theses* when making entry/exit decisions (you MAY read the single aggregate total-account-deployment number to size your own capacity — see Risk Management — but you never inspect which symbols other strategies hold or why)
```

- [ ] **Step 4: Edit — max position count (line 196)**

Replace:
```
**Rule:** Maximum 7 open Coil positions simultaneously
```
with:
```
**Rule:** Maximum 14 open Coil positions simultaneously
```

- [ ] **Step 5: Edit — count/lane rationale (line 197)**

Replace:
```
- 6% per position × 7 positions = 42% theoretical max; the 42% segment lane below now equals this binding cap (no cosmetic gap — the lane and the position math deploy the same ceiling)
```
with:
```
- 6% per position × up to 14 positions ≈ 85% theoretical max. The binding cap is no longer a fixed Coil segment lane — it is **total account deployment ≤ 85%** (dynamic-capacity rule below). Coil holds its base 7 (~42%) as of right and expands toward 14 only when other strategies leave account capital idle.
```

- [ ] **Step 6: Edit — deployment cap rule (lines 201–202)**

Replace:
```
**Rule:** Maximum 42% of portfolio deployed in Coil positions at any time
- Position notional × count cannot exceed this. If a new entry would breach, skip and log.
```
with:
```
**Rule:** Dynamic capacity — Coil may deploy until **total account deployment reaches 85%** of portfolio_value (all strategies combined, not just Coil)
- Compute `total_deployed_pct = (portfolio_value − cash) / portfolio_value × 100` from the Beat Context account snapshot (the `Portfolio | Cash` line; fall back to `get_account`). If adding this entry's 6% would push `total_deployed_pct` above 85%, skip and log. The ~15% buffer is reserved for strategies that beat after Coil (Turtle/Drift at 17:00 ET).
```

- [ ] **Step 7: Edit — operator note (line 208)**

Replace:
```
**Cross-strategy coordination — operator note:** Coil's 42% cap is its lane in the reconciled 100% capital model (2026-06-24): V2 (16%), COIL (42%), TREND (30%), DRIFT (12%). Coil is now the largest lane — the operator runs Coil daily (it makes most of the day's trades) and runs Prophet rarely, so capital was shifted from Prophet (34→16%) to Coil (24→42%). Coil does not coordinate capital with other agents at runtime; it stays within its 42% lane and assumes the other strategies do the same.
```
with:
```
**Cross-strategy coordination — operator note:** Coil's capital model is now *dynamic* (2026-07-08). Its base entitlement is still ~42% (7 × 6%) — its lane in the reconciled 100% model: V2 (16%), COIL (42%), TREND (30%), DRIFT (12%). But because all strategies share one Alpaca account, Coil may **opportunistically use idle capital** left by strategies that are currently flat: it adds 6% names until *total* account deployment reaches 85%, up to 14 positions. This surfaces a longer list of fully-managed entries for the operator to mirror — most relevant in broad selloffs, when many names hit RSI(2) < 5 at once. Coil never force-closes to return capital: its ≤5-day holds self-liquidate, and the ~15% buffer is reserved for strategies that beat after it (Turtle/Drift at 17:00 ET). Coil reads only the aggregate deployment number — it does not inspect or react to other strategies' specific positions.
```

- [ ] **Step 8: Edit — bear halfsize row (line 221)**

Replace:
```
| `halfsize` (default) | Position size halved (effectively 3% per position, max ~21% deployed). Agent keeps learning. |
```
with:
```
| `halfsize` (default) | Position size halved (effectively 3% per position). With the 14-position cap this is up to ~42% deployed. Agent keeps learning. |
```

- [ ] **Step 9: Edit — heartbeat Step 1.5 pre-check (line 277)**

Replace:
```
5. Read `deployed_percent` from the same response. If ≥ 40.0, skip Step 3 (entries).
```
with:
```
5. Compute total account deployment from the Beat Context snapshot: `total_deployed_pct = (portfolio_value − cash) / portfolio_value × 100`. If ≥ 85.0, skip Step 3 (entries). This is TOTAL account deployment across all strategies — not the Coil-segment `deployed_percent` — so Coil expands only into capital other strategies leave idle. (Step 1.4 still reads `get_segment_pnl` for the −2% circuit breaker.)
```

- [ ] **Step 10: Edit — Step 3 skip guard, count (line 301)**

Replace:
```
- `coil_open_position_count` ≥ 7
```
with:
```
- `coil_open_position_count` ≥ 14
```

- [ ] **Step 11: Edit — Step 3 skip guard, deployment (line 302)**

Replace:
```
- `coil_deployed_pct` ≥ 42.0
```
with:
```
- `total_deployed_pct` ≥ 85.0 (total account, per Step 1.5)
```

- [ ] **Step 12: Edit — per-candidate count skip (line 312)**

Replace:
```
   - Skip if total open Coil positions would exceed 7 after this entry
```
with:
```
   - Skip if total open Coil positions would exceed 14 after this entry
```

- [ ] **Step 13: Edit — per-candidate deployment skip (line 313)**

Replace:
```
   - Skip if total Coil deployed % would exceed 42% after this entry
```
with:
```
   - Skip if **total account deployment** would exceed 85% after adding this entry's 6% (track your own just-placed entries within the beat: effective total = snapshot total + 6% × entries placed this beat)
```

- [ ] **Step 14: Edit — entry stop condition (line 329)**

Replace:
```
Stop after the first 7 entries — even if more candidates qualify, the position cap binds.
```
with:
```
Stop once 14 positions are open, or once adding another 6% would cross 85% total account deployment — whichever binds first — even if more candidates qualify.
```

- [ ] **Step 15: Edit — pre-trade checklist, count (line 350)**

Replace:
```
- [ ] Total open Coil positions < 7?
```
with:
```
- [ ] Total open Coil positions < 14?
```

- [ ] **Step 16: Edit — pre-trade checklist, deployment (line 351)**

Replace:
```
- [ ] Total Coil-deployed capital < 42%?
```
with:
```
- [ ] Total account deployment < 85%?
```

- [ ] **Step 17: Edit — "What You Do Not Do" coordination line (line 369)**

Replace:
```
- No coordination with Prophet or Turtle (segment caps are enforced per-strategy)
```
with:
```
- No coordination with Prophet or Turtle on signals or theses. The only cross-strategy input is the aggregate total-account-deployment number used to size Coil's own capacity (see Risk Management); Coil never reacts to which symbols other strategies hold.
```

- [ ] **Step 18: Verify no stale cap constants survive**

Run (Grep tool or shell). Every pattern below must return **zero** matches:
```bash
grep -nE "Maximum 7 open|× 7 positions|coil_open_position_count. ≥ 7|would exceed 7 after|first 7 entries|positions < 7\?|≥ 40\.0|coil_deployed_pct|would exceed 42%|deployed in Coil positions at any time|Coil-deployed capital < 42%|42% segment lane" TRADING_RULES_MEANREV.md
```
Expected: no output (exit 1 from grep = no matches = good).

Note: `−7%`, `stop_loss_pct: 7`, `take_profit_pct: 10`, and the base-lane references `~42%` / `COIL (42%)` are intentionally preserved — the patterns above are written to NOT match them.

- [ ] **Step 19: Verify new content is present**

Run. Every pattern must return **≥ 1** match:
```bash
grep -nE "Maximum 14 open|total_deployed_pct|total account deployment reaches 85%|≥ 85\.0|would exceed 14 after|positions < 14\?" TRADING_RULES_MEANREV.md
```
Expected: matches on all patterns.

- [ ] **Step 20: Re-read the three edited sections for consistency**

Read `TRADING_RULES_MEANREV.md` lines 194–222 (Risk Management), 271–330 (Heartbeat), 340–352 (Checklist). Confirm: 14 × 6% = 84% ≤ 85% (buffer holds); `total_deployed_pct` is defined once (line ~202/277) and referenced consistently thereafter; no dangling reference to the old `coil_deployed_pct` or a 7/42 cap. No commit yet — Task 1 ends at verification.

---

### Task 2: Sync memory (outside the git repo)

**Files:**
- Modify: `memory/capital-allocation-reconciled.md`
- Modify: `memory/MEMORY.md`

**Interfaces:**
- Consumes: the deployed cap semantics from Task 1.
- Produces: an accurate memory record that Coil's cap is now dynamic; no code depends on this.

- [ ] **Step 1: Update the Coil row in `capital-allocation-reconciled.md`**

In the sleeve table, replace the Coil per-position/max-count cell:
```
| Coil (mean-rev) | ~~24~~ → **42%** | **6%/pos, max 7** (2026-06-24: position knobs RAISED so binding cap == lane, 7×6%=42%; was 4×5%=20%). Exploratory max-positions sweep SUPPORTED the bump — 4 left signal uncaptured, 7 captured ~10% more trades, drawdown flat-to-better on holdout (`docs/lab/coil-maxpos-explore-RESULTS.md`). |
```
with:
```
| Coil (mean-rev) | **42% base → dynamic** | **6%/pos; base max 7, expands to max 14 / ≤85% TOTAL-account deploy when other sleeves are flat** (2026-07-08 dynamic borrow: Coil fills idle account capital at 6%/name, ~15% buffer reserved for later-beating sleeves; base still 7×6%=42%). Prior 2026-06-24: 7×6%=42% binding cap==lane; sweep SUPPORTED the bump (`docs/lab/coil-maxpos-explore-RESULTS.md`). Design: `docs/superpowers/specs/2026-07-08-coil-dynamic-capital-borrow-design.md`. |
```

- [ ] **Step 2: Append a dynamic-cap note to the Enforcement paragraph**

At the end of the `**Enforcement:**` paragraph, append:
```
 **2026-07-08:** Coil's cap is now DYNAMIC — it reads TOTAL-account deployment (`(portfolio_value − cash)/portfolio_value`, already in the Beat Context `Portfolio|Cash` line) and fills to ≤85% / 14 positions when other sleeves are flat. Still pure prose (`TRADING_RULES_MEANREV.md` only); the other three lanes are unchanged and do NOT borrow.
```

- [ ] **Step 3: Update the `MEMORY.md` hook line**

Replace the existing line:
```
- [Reconciled capital allocation](capital-allocation-reconciled.md) — FOUR lanes (2026-06-24 Coil↑/Prophet↓) = Coil 42 / Turtle 30 / Prophet 16 / Drift 12; Coil now LARGEST (7×6%, binding cap==lane), Prophet SMALLEST; none code-enforced, all rules-prose (commit f27b041); deploy ceiling 100%, Prophet backstops ON, regime gate OFF
```
with:
```
- [Reconciled capital allocation](capital-allocation-reconciled.md) — FOUR lanes = Coil 42 / Turtle 30 / Prophet 16 / Drift 12 (2026-06-24 Coil↑/Prophet↓); Coil LARGEST, Prophet SMALLEST. 2026-07-08: Coil's cap is now DYNAMIC — fills to ≤85% TOTAL-account deploy / max 14 (6%/name) when other sleeves are flat, ~15% buffer; others don't borrow. None code-enforced, all rules-prose; deploy ceiling 100%, Prophet backstops ON, regime gate OFF
```

- [ ] **Step 4: Verify the memory edits**

Read both files back and confirm the Coil row, the enforcement note, and the `MEMORY.md` hook all reflect the dynamic cap. (No commit — memory is outside the repo.)

---

### Task 3: Squashed commit of the repo changes

**Files:**
- Commit: `TRADING_RULES_MEANREV.md`, `docs/superpowers/specs/2026-07-08-coil-dynamic-capital-borrow-design.md`, `docs/superpowers/plans/2026-07-08-coil-dynamic-capital-borrow.md`

**Interfaces:**
- Consumes: Task 1's edited rules file (and the already-written spec/plan docs).
- Produces: one commit on branch `coil-dynamic-capital-borrow`.

- [ ] **Step 1: Stage exactly the intended files**

Run:
```bash
git add TRADING_RULES_MEANREV.md docs/superpowers/specs/2026-07-08-coil-dynamic-capital-borrow-design.md docs/superpowers/plans/2026-07-08-coil-dynamic-capital-borrow.md
```

- [ ] **Step 2: Confirm the diff is prose-only and scoped**

Run:
```bash
git status --short
git diff --cached --stat
```
Expected: only the three files above staged; no `.js`, `.go`, `.env`, or `agent-config.json` in the set. If anything else appears, unstage it — this change is prose-only.

- [ ] **Step 3: Commit**

Run:
```bash
git commit -m "$(cat <<'EOF'
feat(coil): dynamic capital borrow — fill idle account capital to 85% / 14 positions

Coil's cap changes from a static 7-position / 42% Coil-segment lane to a
dynamic total-account cap: it adds 6% names until TOTAL account deployment
(all strategies) reaches 85%, up to 14 positions, only when other sleeves
leave capital idle. Per-position size (6%), -7% stop, and entries (RSI(2)<5)
are unchanged — only the capacity cap becomes dynamic. Surfaces a longer
fully-managed mirror list, mostly in broad selloffs. Pure prose; editing
TRADING_RULES_MEANREV.md is the deploy (no Go/.env/restart).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```
Expected: one commit created on `coil-dynamic-capital-borrow`.

- [ ] **Step 4: Deploy note**

For this prose change the running bot reads `TRADING_RULES_MEANREV.md` from the checkout, so the change is live only once it reaches local `main`. Do NOT merge unprompted — hand off to the finishing step (below) to confirm the merge with the operator.

---

## Finishing

After Task 3, invoke **superpowers:finishing-a-development-branch** to present merge/integration options. For this change, merging the branch into local `main` is what actually deploys it — confirm with the operator before merging.

## Follow-up (separate, non-blocking — NOT part of this plan)

Validation backtest: extend the existing Coil max-positions harness (behind the June-24 sweep `6e6e3e5` / `docs/lab/coil-maxpos-explore-RESULTS.md`) to **7 vs 10 vs 14**, reporting net/trade, maxDD, drawdown-clustering, and tail-correlation to a tech proxy (QQQ) in the high-concurrency scenario. Runs in parallel with the deploy (paper, ceiling-only). If 14 materially worsens the tail vs 7, dial the count cap back. This gets its own plan/artifact when picked up; the prose deploy above does not block on it.
```
