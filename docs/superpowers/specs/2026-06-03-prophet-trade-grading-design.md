# Per-Trade Thesis-vs-Outcome Grading — Design

Date: 2026-06-03
Status: design approved, pending spec review → implementation plan
Backlog: Task 3 of `prophet-teaching-improvements` (builds on the now-honest records from Task 1)

## Context & goal

Prophet is a teaching tool. Today the only retrospection is `review-performance`
(LLM, weekly, aggregate) and `postmortem` (LLM, single deep-dive on demand). This
feature adds the missing granularity: an automatic **per-trade** grade on each
closed trade answering "did the thesis play out?" — separated from "did it make
money?" — so the user learns to judge *process* independent of *luck*.

Data already present:
- **Outcome (structured):** closed `managed_positions` → `scripts/managed-position-repair.mjs`
  (`readClosedManagedPositions`, `deriveExitReason` = stop/target/signal_or_time/
  reconciled/indeterminate, `parseManagedTimestamp`, `resolveSandboxDbPaths`,
  `PART_A_DEPLOY_CUTOFF`) and `scripts/trade-ledger.mjs` (friction-adjusted P&L via
  `apply-friction.mjs`).
- **Thesis (freeform):** Prophet's `data/sandboxes/<accountId>/decisive_actions/*.json`
  (`reasoning` text per `log_decision`). Sandboxes for the Prophet agent are resolved
  by agent id `default` (see `review-performance` SKILL.md Step 1).

## Decisions (locked with user)

1. **Hybrid grading.** Deterministic outcome card + grade for free; a cheap **batched
   Haiku** pass for Prophet's narrative thesis judgment only.
2. **All agents.** Prophet gets the LLM thesis-grade (catalyst/IV/timing); the
   mechanical agents (Coil/Turtle) get a zero-LLM deterministic grade from their exit
   reason. Mechanical agents' entry "why" already comes from the Task-2 digest.
3. **LLM via the existing skill path.** `_runSkill('trade-grader', date, …, HAIKU_MODEL)`
   (`HAIKU_MODEL = 'anthropic/claude-haiku-4-5'`), same as `market-top-detector`/
   `us-market-bubble-detector`. A Node **cost-gate** skips the LLM on days Prophet
   closed nothing. No direct Anthropic SDK (none exists in `scripts/`).
4. **Surface = report file + dashboard card**, mirroring the Task-2 digest +
   reconciliation surfaces.
5. **Flag-gated, default OFF** (`TRADE_GRADING_ENABLED`); daily after-close (~5:00 PM ET).

## The grade — process vs outcome

The load-bearing teaching idea is decoupling whether the thesis was right from whether
the trade won (serves the user's "don't cheerlead winners / hot-hand is noise" stance).
The clear cases form a 2×2; the unresolved cases get their own honest buckets instead of a
forced call (Tier-1 validity fix):

| thesisPlayedOut | Profit | Loss |
|---|---|---|
| **played** | `earned_win` | `unlucky` (keep doing this) |
| **broke** | `lucky` (don't be fooled) | `clean_miss` (learn) |
| **partial** | `partial_win` | `partial_loss` |
| **inconclusive** | `inconclusive_win` | `inconclusive_loss` — "exited before the thesis could resolve; no read on process" |

`thesisPlayedOut ∈ {played, partial, broke, inconclusive}`; `quadrant` is exactly one of the
eight cells above. The grader is never forced into a played/broke call the exit doesn't support.

Per closed trade the grade carries:
- Outcome card: `{agent, symbol, entryPrice, exitPrice, holdTime, frictionPnl, frictionPnlPct, exitReason}`.
- `thesisPlayedOut` + `quadrant` (from the table).
- Prophet only — **grounded** sub-verdicts, never fabricated (Tier-1 validity fix): `catalyst`
  and `timing` (`played|partial|failed`) are judged from the thesis narrative against the
  price action + hold-time the card actually carries; `iv` is graded ONLY when entry AND exit
  IV are present on the card (they are NOT today) — otherwise it is `not_assessed`, and the
  skill prompt explicitly forbids inventing an IV verdict on data the card doesn't hold. Plus
  a one-line lesson.
- Mechanical: `thesisPlayedOut` derived deterministically (mapping below) + a templated lesson.

## Architecture (mirrors `review-performance`: Node preprocess + Haiku skill)

### Unit 1 — `scripts/trade-grades.mjs` (Node, deterministic, free)
Pure functions + injected-dep I/O. Reuses `managed-position-repair.mjs` +
`trade-ledger.mjs` (no re-derivation). Responsibilities:
- `buildOutcomeCard(position)` — structured card from a closed managed_position +
  friction-adjusted P&L.
- `gradeMechanical(card)` — maps ALL FIVE `deriveExitReason` states to `thesisPlayedOut`
  (Tier-1 validity fix): `target`→`played`, `stop`→`broke`, `signal_or_time`→`inconclusive`,
  `reconciled`→`inconclusive` (a broker-reconciliation close, not a strategy exit — flagged in
  the lesson as "closed by reconciliation, not a strategy decision," never skill-graded),
  `indeterminate`→`inconclusive`. Combined with P&L sign → the `{thesisPlayedOut, quadrant,
  lesson}` cell from the grade table. Pure.
- `gatherProphetTheses(card, decisiveActions)` — collect candidate `decisive_actions`
  reasoning for the card's symbol within its entry→exit window (the skill does the
  final pairing + judgment; this just scopes the input).
- `buildCards(sandboxId, date, …)` — assemble all closed trades for the ET day into a
  `cards.json` spine: mechanical cards fully graded, Prophet cards graded
  deterministically (fallback) + their candidate theses attached.
- `hasProphetCloses(cards)` — the **cost-gate** the scheduler reads.
- `writeDeterministicReport(...)` / `readTradeGradesSummary(...)` — report I/O, mirroring
  `reasoning-digest.js` (`data/trade-grades/<sandboxId>/<date>.{json,md}`).

On days with no Prophet closes (or the flag off), Unit 1's report is the final report
(deterministic grades for everyone) — **graceful degradation**, no LLM needed.

### Unit 2 — `trade-grader` skill (LLM, Haiku, batched, optional enrichment)
A `.claude/skills/trade-grader/SKILL.md`. Invoked by the scheduler with `HAIKU_MODEL`
**only when** `hasProphetCloses` is true and the flag is on. Steps: run the Node
preprocessor (like `review-performance` Step 0 runs `apply-friction`), read `cards.json`,
in ONE batched pass pair each Prophet close to its entry thesis and grade
catalyst/IV/timing-played-out + quadrant + one-line lesson, then write the final
`<date>.{json,md}` (mechanical grades passed through deterministically; Prophet entries
enriched). Report-only — never edits rules or places orders.

### Unit 3 — surface
`GET /api/trade-grades?date=&sandboxId=` (mirrors `/api/reasoning-digest`) + a Trades-tab
"report card" section, silent when absent. Reads the final `<date>.json`.

### Scheduler
A `trade_grading` job, daily ~5:00 PM ET weekdays (after the 4:55 digest), idempotent per
ET day, gated by `TRADE_GRADING_ENABLED` (default OFF). Flow: run Unit 1 (free) → if it
reports Prophet closes, `_runSkill('trade-grader', …, HAIKU_MODEL)`; else Unit 1's
deterministic report stands.

## Data flow
```
closed managed_positions ─ managed-position-repair + trade-ledger ─┐
                                                                   ├─ Unit 1 trade-grades.mjs
Prophet decisive_actions (reasoning) ──────────────────────────────┘     │  builds cards.json (spine)
                                                                         │  + deterministic report (all agents)
                                          hasProphetCloses? ── yes ──► Unit 2 trade-grader skill (Haiku, 1 batched pass)
                                                                         │  enriches Prophet → final <date>.json
                                                                         ▼
        data/trade-grades/<sandbox>/<date>.{md,json} ─ GET /api/trade-grades ─ dashboard card
```

## Cost controls
One Haiku skill run/day, **only on days Prophet closed a trade** (Node cost-gate),
batched across that day's closes. Mechanical grading is zero-LLM. Flag default OFF.

## Error handling
- Soft-fail per sandbox (one bad DB ≠ abort others), matching the digest/reconciliation.
- Skill failure → Unit 1's deterministic report remains (Prophet entries keep their
  deterministic fallback grade); no broken surface.
- Missing/empty data → that agent/day omitted; no wrong banner.

## Testing
- **Node (`scripts/trade-grades.test.mjs`, node:test):** `buildOutcomeCard` from a closed
  managed_position fixture; `gradeMechanical` quadrant truth table covering **all five**
  `deriveExitReason` states × win/loss (target/stop/signal_or_time/reconciled/indeterminate);
  `gatherProphetTheses` window scoping; `hasProphetCloses` gate; report write/read round-trip;
  sandbox resolution. Reuse the `managed-position-repair` test patterns (`node:sqlite`
  `DatabaseSync` readOnly — NOT better-sqlite3).
- **Skill contract:** a fixture `cards.json` with no IV fields must produce `iv: not_assessed`
  (the no-fabrication guard) — assert the prompt forbids an invented IV verdict.
- **Surface:** endpoint test mirroring the reconciliation/digest endpoint.
- **Skill:** validated by its I/O contract (cards.json schema in → report schema out) +
  a manual dry-run; LLM skills are not unit-tested.
- **Scheduler:** `node --check` + existing scheduler suite stays green.

## Out of scope (YAGNI)
- Feeding grades into the Foundation graduation/measurement system (standalone teaching
  artifact for now).
- Real-time per-close grading (daily batch only).
- Backfill of historical closed trades.
- Grading the mechanical agents with an LLM (deterministic is sufficient there).
- Capturing entry/exit IV onto the outcome card to make the `iv` sub-verdict assessable
  (deferred enhancement; until then `iv` is honestly `not_assessed`, never fabricated).

## Open items to pin during planning
- Exact `decisive_actions` record schema (fields available for `reasoning`, timestamp,
  action type) — confirm against a real file before writing `gatherProphetTheses`.
- Entry↔exit↔thesis pairing window heuristic (symbol + managed_position entry/exit
  timestamps; the skill does final pairing, Unit 1 scopes candidates).
- The `trade-grader` SKILL.md prompt + the exact `cards.json` schema contract.
- Confirm `trade-ledger.mjs` exports the friction-adjusted per-trade fields Unit 1 needs
  (or call `apply-friction` + `managed-position-repair` directly).
