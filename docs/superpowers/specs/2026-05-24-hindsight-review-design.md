# Hindsight-Review — Design

**Date:** 2026-05-24
**Status:** Draft for review
**Author:** Brainstorm (owner-steered)
**Scope owner decisions captured:** report-only (never edits rules); Prophet (`default`) only for v1, clone per-agent later only if it proves out; methodology A+C (measure against existing rules + coverage, with catalyst attribution); universe = the bot-owned **tradable floor**, with a **separate** off-floor "forbidden winners" tally (informs floor curation, not trade regret); kill/keep threshold relative to realized P&L; on-demand skill (no cron in v1); skill name `hindsight-review`.

---

## 1. Background

Prophet's existing learning loop is **purely introspective**. `review-performance` and `adapt-strategy` read only what the agent *did* — its own `decisive_actions/*.json` (each carrying a `market_data` snapshot of what it looked at) and `activity_logs/activity_*.json` (daily P&L summaries). Neither ever looks at the broader market for trades the agent *didn't* make. There is no counterfactual lens anywhere in the system.

The owner's idea: at the end of a session, find the biggest winners/losers the agent could have traded and ask *how it could have spotted them* — feeding lessons back into strategy.

**The central risk, named up front.** The naive form of this idea — "find a big mover, invent the signal that would have caught it, add it as a rule" — is structurally a **hindsight-bias generator**. There is a large mover *somewhere* every day; any of them can be retro-fitted to a pattern that won't generalize. The entire rest of the system (friction adjustment, 80/20 hold-out, significance gate, epoch segmentation) exists to *prevent exactly this*. A feature that injects curve-fit signals straight into the rulebook would fight that design. This spec is built to make that failure mode structurally impossible.

**Two facts discovered during the brainstorm that de-risk the idea:**

1. **The tradable universe is bounded and bot-owned.** Per the 2026-05-24 tradable-universe-boundary work (`config/prophet_tradable_universe.txt`, loaded by the Go guard and the catalyst `universe_builder.py` modules), Prophet's trade-eligible set is a curated ~50-name floor of mega-caps + liquid ETFs — **not** a full-market scan. Ranking moves over ~50 names makes the base-rate denominator trivial and makes an in-floor miss a *real* miss rather than survivorship noise.
2. **Most of the data already exists on disk.** Per-decision `market_data` snapshots record what the agent actually saw, and the `catalyst-news` / `analyst-actions` skills already attribute moves to catalysts. The only fresh fetch is daily OHLC for the ~50 floor names — a cheap, on-demand FMP pull (v1 fetches directly; see the bar-cache non-goal in §2 for why it does not reuse the Go `data/bar-cache/`).

A subtlety the design must respect: the floor is the **tradable** set, but the catalyst skills also watch a wider **surveillance set** (floor + an in-memory FMP news top-up) that Prophet is *forbidden to trade*. A big move in a surveillance-only name is **not a miss** — including it would manufacture regret for a trade the agent is designed never to take.

---

## 2. Goals / Non-goals

### Goals
- Produce a **read-only** hindsight report on the session's biggest movers *within the tradable floor*, classifying each into one bucket (coverage/never-looked, timing, discipline, rules-silent, unforeseeable) that separates fixable gaps from luck.
- **Never invent a new signal and never edit a rule.** The only "could we have caught it" question asked is *would Prophet's current, already-deployed rules have fired* — measured only on mechanically-checkable conditions, with the verifiable/unverifiable split stated explicitly.
- Attach a **base-rate denominator** to every "rules would have fired" claim (how many other floor names showed the same setup and did *not* move).
- Emit a **machine-readable findings ledger** per run so the feature's own usefulness is measurable, not a vibe.
- Provide a **`--scorecard` mode** that aggregates the ledger over a trailing window and evaluates an up-front **kill/keep criterion** — the decision rule for whether to clone the feature to other agents.
- Keep a **separate off-floor "forbidden winners" tally** as evidence about whether the floor is drawn too tight (curation input, never trade regret).

### Non-goals
- **Editing rules / proposing applied edits.** Findings are routed to `adapt-strategy` by a human; they still face the hold-out there. Nothing here touches `agent-config.json`.
- **Inventing signals / pattern mining** (the rejected "Approach B").
- **Recomputing win-rate / profit-factor / behavioral patterns** — that is `review-performance`'s job; this skill cites it, never duplicates it.
- **Deep-diving a single trade** — that is `postmortem`; this skill may point the user at it.
- **Other agents.** v1 is Prophet (`default`) only. Cloning is gated on the kill/keep criterion (§7).
- **A cron / auto-daily run.** On-demand for v1; a scheduled run is a trivial later add once proven useful.
- **Using realized highs/lows as the counterfactual exit** (would reintroduce hindsight bias into the very number meant to be bias-free — see §5.3).
- **Reusing the Go `data/bar-cache/`.** v1 fetches daily bars directly from FMP. The Go `SharedBarCache` keys files by the *consuming* agent's lookback window (`{sym}_1Day_{start}_{end}.json`), so an arbitrary hindsight date range essentially never produces a matching key, and the stored payload is a Go-owned shape with no JS reader. ~50 on-demand `historical-price-full` calls per run are within budget. Bar-cache reuse is a deferred optimization, not v1.

---

## 3. Scope resolution (mirror the existing loop exactly)

Resolve the target agent, strategy, and sandboxes **identically** to `adapt-strategy` so the two skills always agree on "what is Prophet":

1. Read `data/agent-config.json`.
2. In `agents[]`, find `id === 'default'` (fallback: name containing `"Prophet"` case-insensitive, excluding `"PennyProphet"`/`"TrendProphet"`). Note its `strategyId`.
3. In `strategies[]`, find that id; extract `customRules` — this is the rulebook the "would the rules have fired" check reads (never a hardcoded copy).
4. Collect every sandbox where `agent.activeAgentId === 'default'` → `<PROPHET_DIRS>`. If empty, stop and tell the user.

The **tradable universe** is read from `config/prophet_tradable_universe.txt` (strip `#` comments and blank lines; each remaining line is one ticker). Never hardcode the names — the floor is owner-tuned on a 6–12 month cadence and the skill must track it.

---

## 4. Data sources

| Need | Source | Failure mode |
|---|---|---|
| Daily % move per floor name | `scripts/rank-floor-movers.mjs` → FMP daily bars (`historical-price-full`, one small call per floor name; bar-cache reuse is a §2 non-goal) | Soft-fail **per name**: a name with no data is dropped from the ranking and counted in a `missing[]` list, never treated as flat. |
| What the agent *saw* | `decisive_actions/*.json` `market_data` + `reasoning` across `<PROPHET_DIRS>`; `activity_logs`; plus the always-surfaced intraday watchlist (`PROPHET_INTRADAY_WATCHLIST`, `agent/harness.js`) | Missing snapshot → treat name as "not proactively evaluated" (still seen if on the watchlist). |
| Why it moved (catalyst) | `catalyst-news` / `analyst-actions` skill outputs for the date | No catalyst found → tag `catalyst: none-found` (**"not surfaced," not "none exists"** — see the catalyst-recall firebreak in §5.5). The move's bucket is then decided by §5.5, not silently left in bucket 2. |
| Off-floor "forbidden winners" | `rank-floor-movers.mjs` also returns the day's biggest **liquid** movers *not* in the floor (same liquidity screen the FMP top-up uses: market-cap / price / volume) | Soft-fail; passive tally only (§6.1), never enters the bucket analysis. |
| Friction haircut on foregone P&L | the existing friction model (`scripts/apply-friction.mjs` logic) | If unavailable, label the foregone estimate `raw-pl-fallback`. |

**The "did the agent see the signal" rule** (grounded in the harness, and *time-aware* — see §5.2): seeing a name is not the same as seeing it *when the signal was live*. The ~12 `PROPHET_INTRADAY_WATCHLIST` names are auto-pushed into **every** heartbeat's Intraday Context table, so a watchlist name is seen at every heartbeat — including whichever heartbeat covers the trigger time T. The other ~38 floor names are surfaced only if the agent *proactively* pulled them (`analyze_stocks` / `get_intraday_signals`), evidenced by a `market_data`/`reasoning` snapshot — **with a timestamp** — that session. Whether the eyes-on moment lands at/after T is what separates a discipline gap from a timing gap (§5.1).

---

## 5. The analysis

### 5.1 Bucket classification (the bias firebreak)

Each big mover in the floor is filed into **exactly one** bucket. Let **T** = the time the mechanically-checkable entry conditions were first met that session (§5.4); a name with no such T cannot be a discipline gap. Evaluate in priority order:

1a. **Coverage gap (never looked)** — a non-watchlist floor name that moved big and appears in **no** `market_data`/`reasoning` that session. → a fixable *scanner/universe-attention* problem, **not** a signal problem. (A watchlist name can never land here — it was auto-surfaced.)
1b. **Timing gap (looked, but not when the signal was live)** — the agent's only eyes-on the name (a snapshot, or for non-watchlist names any evaluation) predates **T**; at the moment it looked, the signal had not yet formed, and there is no evidence it looked again at/after T. → also an *attention/cadence* problem, **not** discipline. Accrues **no** foregone cost. (Watchlist names rarely land here: they're re-surfaced every heartbeat, so a heartbeat at/after T almost always exists.)
2. **Discipline gap** — the agent had eyes on the name **at or after T** (a watchlist heartbeat covering T, or a non-watchlist snapshot with timestamp ≥ T), the mechanically-checkable entry conditions were met, and it did not open. → `adapt-strategy`'s wheelhouse; the highest-value, lowest-bias finding. **Only this bucket accrues foregone cost.**
3. **Rules correctly silent** — the agent saw it (at/after T or otherwise) but the checkable entry conditions were never met. → not a miss; the rules had no opinion. (Logged for completeness, not actioned.)
4. **Unforeseeable catalyst** — the move is attributed to (or, per §5.5, *suspected* to stem from) news not knowable at T. → **luck, explicitly not actionable.** The survivorship-bias quarantine. Per §5.5 it takes precedence over bucket 2 even when conditions nominally fired.

### 5.2 The honesty boundary on "would the rules have fired"

Prophet's rules are largely **discretionary** (read the brief; assess tape, VWAP, RVOL, catalyst confluence). The skill therefore:
- Replays **only** the mechanically-checkable conditions — the ones with real data in `market_data` / FMP daily bars (e.g. underlying ∈ floor, RVOL threshold, VWAP reclaim, options spread < 10%, DTE/delta band where applicable).
- **States explicitly, per finding, which conditions it could and could not verify.** It never claims the agent's *judgment* would have said yes.
- For a name the agent actually evaluated, the `market_data` snapshot is **ground truth** on what it saw — the most reliable input available.

A bucket-2 ("discipline gap") finding requires that the *verifiable* conditions were met **and** the agent's own snapshot/reasoning shows it had the information. If the only conditions that "would have fired" are unverifiable judgment calls, the finding is downgraded to bucket 3 with a note.

### 5.3 Base-rate denominator (mandatory on every bucket-2 claim)

For the setup that "fired" on a missed winner, count **how many other floor names showed the same setup that session and what happened to them.** Report it inline:

> Discipline gap — NVDA +6.2%. RVOL 2.1 + VWAP reclaim by 10:05 ET (verifiable); catalyst confluence (unverifiable, not asserted). **Base rate: the same RVOL+VWAP setup fired on 7 floor names today; 2 closed green, 5 red.** Foregone P&L (rule-defined exit, friction-adjusted): +$430.

No denominator → no bucket-2 claim. This is the per-run analog of `adapt-strategy`'s hold-out: a setup that "would have caught" one winner but also fired on five losers is *not* edge, and the report must show that.

### 5.4 Foregone-P&L estimate (bias-free by construction)

For each bucket-2 finding, estimate the trade the **rules** would have produced — not the trade hindsight wishes for:
- **Entry:** at the time/price the verifiable conditions were first met (from the `market_data` timestamp / bar).
- **Exit:** the **rule-defined** target / stop / EOD-close — **never the realized high/low.** Using the realized extreme would smuggle hindsight back into the one number meant to be clean.
- **Size:** the rule's position-sizing.
- **Haircut:** apply the standard friction model; tag `raw-pl-fallback` if unavailable.

The result is a deliberately conservative "money left on the table by not following our own rules" figure. It is the primary input to the kill/keep criterion (§7).

### 5.5 Catalyst-recall firebreak (closing the "none-found ≠ none-exists" leak)

The bucket-4 quarantine depends on catalyst attribution, whose **recall the skill does not control and cannot perfectly measure** — the `catalyst-news`/`analyst-actions` skills can miss a real catalyst. Treating `none-found` as "no catalyst exists" would route a news-driven move with an *unsurfaced* catalyst into bucket 2 and inflate foregone cost — the exact hindsight leak this whole spec exists to prevent, smuggled in through a dependency we don't own.

The fix does **not** require a found catalyst for a discipline gap — most legitimate discipline gaps are pure-technical momentum moves with *no* news at all, so demanding catalyst-presence would gut the bucket. Instead, distinguish "technical move, genuinely no catalyst" from "looks like news, catalyst just wasn't surfaced" by the **shape of the move**, plus make any residual uncertainty *visible* rather than silent:

- **Shape reclassification.** When `catalyst: none-found` **and** the move is dominated by a discontinuity — a large opening **gap**, or a single-bar jump carrying the bulk of the day's move (thresholds owner-tunable, e.g. gap or one-bar move ≥ ~½ the total) — file the mover as **bucket 4** with `catalyst: suspected-unfound`. It accrues **no** foregone cost. A discontinuous jump with no found catalyst is far more likely an unsurfaced news event than a tradable technical setup; when in doubt, the firebreak errs toward "luck."
- **A smooth/continuous move with `none-found`** stays a candidate bucket-2 (technical) finding, but is tagged `catalyst_checked: true, catalyst: none-found` so its foregone cost is **separately tallied** by the scorecard as `foregone_cost_catalyst_unverified` (§7). A rising share of that line is then legible as a **catalyst-recall problem**, not a silent inflation of the headline regret number.

This keeps the bucket-2 bar honest without depending on perfect catalyst recall, and surfaces recall degradation as its own measured signal.

---

## 6. Output

### 6.1 Human-readable report
Sections: **Session movers** (ranked table over the floor, with bucket per name), **Coverage gaps** (1a never-looked + 1b timing), **Discipline gaps** (each with verifiable-conditions list, the eyes-on-vs-T evidence, base rate, foregone P&L), **Rules-correctly-silent** (brief), **Unforeseeable** (with catalyst cited, or `suspected-unfound` per §5.5), **Off-floor forbidden winners** (a **passive log** — see below), and **Suggested follow-ups** (e.g. "run `/postmortem NVDA`"; "route the recurring AVGO coverage gap to `/adapt-strategy` as finding `<id>`"). The report never proposes rule text.

> **Off-floor forbidden winners is a passive log, not an action item.** It exists only as curation evidence for the human's periodic (6–12 mo) floor review — "is the tradable floor drawn too tight?" Nothing in this skill or any other reads it automatically, and it never generates trade regret. It is recorded so a future floor review *can* consult it; wiring it to an automated curation path is explicitly out of scope (the floor is owner-tuned).

### 6.2 Machine-readable ledger
Each run appends `data/reports/hindsight/hindsight_<YYYY-MM-DD>.json`:
```json
{
  "date": "2026-05-23",
  "agent": "default",
  "floor_size": 50,
  "movers_ranked": [ { "id": "2026-05-23:NVDA", "symbol": "NVDA", "move_pct": 6.2,
    "bucket": "discipline_gap",
    "trigger_time_et": "10:05", "eyes_on_at_or_after_T": true, "eyes_on_source": "watchlist",
    "verifiable_conditions": ["rvol>=2","vwap_reclaim"], "unverifiable_noted": true,
    "base_rate": { "fired": 7, "green": 2, "red": 5 },
    "foregone_pl_usd": 430, "foregone_pl_basis": "friction-adjusted",
    "catalyst_checked": true, "catalyst": "none-found", "move_shape": "continuous",
    "routed_to_adapt_strategy": false, "routed_outcome": null } ],
  "coverage_gaps_never_looked": ["AVGO"],
  "timing_gaps": ["AMD"],
  "off_floor_forbidden_winners": [ { "symbol": "SMCI", "move_pct": 14.1 } ],
  "missing": ["ORCL"]
}
```
Field notes: `bucket` ∈ {`coverage_gap`, `timing_gap`, `discipline_gap`, `rules_silent`, `unforeseeable`}; only `discipline_gap` carries a non-zero `foregone_pl_usd`. `catalyst: "suspected-unfound"` + `move_shape: "gap"|"single-bar"` marks a §5.5 shape-reclassified bucket-4. `routed_to_adapt_strategy`/`routed_outcome` (`null` | `"pending"` | `"survived-holdout"` | `"rejected-holdout"`) are the **only human-edited fields** — the §5b annotation, keyed by the stable `id` so it survives re-runs. The ledger is the substrate the scorecard reads; the report is for humans, the ledger is for measuring the feature.

---

## 7. Effectiveness metrics + kill/keep criterion (`--scorecard` mode)

`hindsight-review --scorecard [--weeks N]` reads the trailing ledger window (default 4 weeks) plus `activity_logs` realized P&L via `scripts/hindsight-scorecard.mjs` and reports:

- **Bucket distribution** — share of flagged movers per bucket. A high *discipline* share = finding fixable things; a high *coverage/timing* share = an attention/cadence problem; a high *unforeseeable* (incl. `suspected-unfound`) share = "hindsight here is mostly luck" → a reason to retire.
- **Recurrence / concentration** — same name or gap-type recurring across sessions. A finding recurring **≥3×** is systematic, not noise. **This is a qualifier, never a standalone keep trigger** (see the verdict below) — a gap can recur precisely *because* it is correctly non-actionable.
- **Discipline-gap realized cost** — summed friction-adjusted foregone P&L from bucket 2 only (the agent ignoring its **own existing** rules; bias-free). Reported alongside `foregone_cost_catalyst_unverified` — the subset resting on `catalyst: none-found` continuous moves (§5.5). A high or rising unverified share means the headline cost is leaning on unmeasured catalyst recall and should be **discounted**, not trusted.
- **Actioned-and-survived count** — from the ledger's `routed_outcome` field: findings a human routed to `adapt-strategy` that **passed** the hold-out. The gold standard; the only metric that closes the loop from "found it" to "fixing it helped."

**Kill/keep criterion (the cloning gate), fixed up front.** The gate is deliberately structured so "the feature reliably *finds* things" cannot, by itself, be mistaken for "the feature *improves* the agent." Two conditions are **required** for any provisional keep (both, not either) — they close #3 (recurrence alone can't clone) and the relative-cost noise concern hard — while the catalyst-recall uncertainty (#1) is surfaced as a **downgrade**, not encoded as a false-precision threshold. The scorecard emits one of five verdicts:

- **`INSUFFICIENT_DATA` (→ EXTEND, the floor for #4 small-n).** If the window has fewer than **M** sessions-with-data or fewer than **K** total bucket-2 findings (M, K owner-tunable; tentative M=15, K=8), render **no** keep/retire decision — recurrence and relative-cost thresholds are too noise-fragile on a handful of points. Keep observing.
- **`KEEP` (strong) — loop closed.** `actioned-and-survived ≥ 1`. A hindsight-sourced change actually survived the hold-out. Decisive on its own, regardless of cost or recurrence.
- **`KEEP` (provisional) — costly *and* systematic.** Discipline-gap foregone cost **> 25% of the period's realized P&L** **AND** that cost is concentrated in ≥1 finding-type recurring **≥3×**. Both required. Worth acting on even before a hold-out result; recurrence is the *qualifier* that screens out one-off noise, cost is the magnitude bar — neither triggers alone.
- **`REVIEW` — qualifies for provisional-KEEP, but the cost leans on unmeasured catalyst recall.** Same two required conditions met, but the `catalyst_unverified` share of the discipline cost is **≥ ~½** (§5.5). Rather than silently trusting (false keep) or silently blocking (false retire on a number we can't measure well), the verdict is downgraded to `REVIEW`: a human spot-checks whether those `catalyst: none-found` "discipline gaps" were actually unsurfaced news before treating the keep as real. A bounded, explicit human action — not an automated decision on a jittery metric.
- **`RETIRE`.** Enough data (not `INSUFFICIENT_DATA`), but no KEEP/REVIEW condition holds — findings dominated by unforeseeable/non-recurring, low foregone cost, nothing survived a hold-out. Conclude hindsight adds no edge on Prophet; do not clone.

The scorecard prints the verdict with every condition's satisfied/failed state and the values behind it. *The feature is explicitly built to be able to prove itself useless — and cannot clone itself on "I keep noticing things" alone.*

**`REVIEW` disable fallback.** The `REVIEW` downgrade rests on the `catalyst_unverified` *share*, which may itself be too jittery to threshold at this n. If the first weeks show that share swinging wildly run-to-run, **disable the `REVIEW` downgrade** (owner flag): provisional-KEEP then reverts to cost-AND-recurrence only, and #1 is surfaced purely through the always-present `catalyst_unverified` scorecard line rather than a verdict state. The line never goes away; only its promotion to a verdict modifier is optional.

**Denominator edge case.** The 25% test's denominator is period realized P&L from `activity_logs`. If period P&L is ≤ 0 (a losing/flat stretch — exactly when you'd most want this feature to justify itself, and when its main metric goes dark), the relative test is undefined: the provisional-KEEP / `REVIEW` paths are unavailable, and the verdict can only be `KEEP (strong)` via actioned-and-survived, else `INSUFFICIENT_DATA`/`RETIRE`. The scorecard states this fallback explicitly so a dark-metric stretch reads as "can't yet judge," not "retire."

---

## 8. Components & boundaries

Deterministic computation lives in **tested scripts** (project convention: test the executor, not just the predicate); judgment lives in the skill.

- **`scripts/rank-floor-movers.mjs`** (new, tested) — input: floor file path + date (+ `--days N`). Output: floor names ranked by abs daily move; the off-floor liquid-mover tally; a `missing[]` list. Soft-fails per name via FMP `historical-price-full` (one call per name). *What it does:* turns "the floor" + "a date" into a ranked, denominator-ready mover list. *Depends on:* the floor file, FMP (`FMP_API_KEY`).
- **`scripts/hindsight-scorecard.mjs`** (new, tested) — input: ledger dir + `--weeks N` + `activity_logs`. Output: bucket distribution, recurrence/concentration, total foregone cost (+ `catalyst_unverified` subset), % of realized P&L, `actioned-and-survived` count, and the five-state verdict (`INSUFFICIENT_DATA` / `KEEP (strong)` / `KEEP (provisional)` / `REVIEW` / `RETIRE`, §7) with every condition's satisfied/failed state and values. *What it does:* turns the ledger history into the cloning decision. *Depends on:* the ledger files, activity logs.
- **`.claude/skills/hindsight-review/SKILL.md`** (new) — orchestrates: resolve scope (§3) → run `rank-floor-movers` → determine trigger time **T** and eyes-on-vs-T per mover, cross-referencing `decisive_actions`/watchlist (§4, §5.2) → classify into buckets incl. timing-gap (1b) and the §5.5 catalyst-shape reclassification (§5.1) → compute base rates + foregone P&L on bucket 2 only (§5.3–5.4) → attribute catalysts → write report + ledger (§6) → (in `--scorecard` mode) run `hindsight-scorecard` and print the verdict. The skill owns the *judgment* (classification, eyes-on-vs-T, attribution, the verifiable/unverifiable split, move-shape call); the scripts own the *arithmetic*.

`allowed-tools`: `Read Glob Bash` (Bash for the two scripts + reusing the friction/catalyst scripts).

---

## 9. Testing

- **`rank-floor-movers.test.mjs`:** parses the floor file ignoring comments/blanks; ranks by abs move; a name with no data lands in `missing[]` (not treated as 0%); off-floor movers excluded from the floor ranking and present in the separate tally; FMP HTTP error / empty / thrown-network all soft-fail to `null` (per-name) against an injected `fetchImpl` fake.
- **`hindsight-scorecard.test.mjs`:** bucket-distribution and recurrence counts on a fixture ledger; foregone-cost sum from bucket 2 only (timing/coverage/unforeseeable contribute 0); the `catalyst_unverified` subset is summed separately; **verdict matrix** — `INSUFFICIENT_DATA` below the M-sessions / K-findings floor (and that it suppresses an otherwise-qualifying KEEP); `KEEP (strong)` on `actioned-and-survived ≥ 1` regardless of cost/recurrence; `KEEP (provisional)` when cost >25% **and** a ≥3× recurring finding **and** unverified-share < ½; **`REVIEW`** when those same two required conditions hold **but** unverified-share ≥ ½ (the #1 downgrade, *not* a block); recurrence ≥3× alone does **not** KEEP, and cost >25% alone does **not** KEEP (both demoted-to-required-pair regression guards); the `REVIEW`-disable flag collapses `REVIEW` back into `KEEP (provisional)`; `RETIRE` when data sufficient but none hold; the ≤0-period-P&L fallback disables both provisional-KEEP and `REVIEW`, leaving only strong-KEEP/`INSUFFICIENT_DATA`/`RETIRE`.
- **Skill-level (manual/golden):** a watchlist name that moved big and was never traded is bucket 2 or 3 (never 1a/1b — it was auto-surfaced every heartbeat); a non-watchlist floor name absent from all `market_data` is **1a**; a non-watchlist name whose only snapshot predates T is **1b (timing gap)** and accrues no cost; a mover attributed to after-hours M&A is bucket 4 even if conditions nominally fired; a `none-found` move dominated by an opening gap is reclassified to bucket 4 `suspected-unfound` (no cost), while a `none-found` *continuous* move stays bucket 2 but tagged `catalyst_unverified`; a bucket-2 claim with no computable denominator is suppressed.
- Run `node --test` on both scripts before any commit; no success claim without green output (project convention).

---

## 10. Open items to confirm during implementation

- **FMP endpoint for daily moves** — daily historical bars per floor name vs a single `most-actives`/gainers-losers pull intersected with the floor. The latter is one call but may not cover quieter floor names; the former is ~50 small calls (cache-friendly). Resolve in the plan against the call budget.
- **Off-floor liquid screen** — confirm the exact market-cap/price/volume thresholds to mirror the catalyst top-up's screen, so "forbidden winners" means the same liquidity bar as the surveillance set.
- **`routed_outcome` annotation flow** — v1 is a manual edit of the two ledger fields keyed by finding `id` (§6.2). Confirm the lowest-friction surface (edit the ledger JSON in place vs a `hindsight-review --route <id> <outcome>` helper that does the append). **Future enhancement, deliberately not v1:** have `adapt-strategy` write `routed_outcome` back automatically when it ingests/validates a hindsight-sourced edit — closing the loop without a human append. Not built now because (a) it couples two skills and (b) §7 already removed this metric's load-bearing status (it's `KEEP (strong)`, not a mandatory gate), so the manual form is acceptable for v1. Revisit once the feature has proven its keep verdict.
- **Verdict-floor + shape thresholds** — the small-n floor (tentative M=15 sessions, K=8 bucket-2 findings, §7) and the §5.5 move-shape cutoffs (gap / single-bar ≥ ~½ of total move) are owner-tunable starting points, not load-bearing constants. Confirm against the first weeks of real ledger data before treating any verdict as final.
- **Ledger retention** — `hindsight_<date>.json` accrues one file per run; a pruning sweep is a later add (bounded, low volume), flagged not built.
