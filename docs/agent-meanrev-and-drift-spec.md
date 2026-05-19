# Mean Reversion + Earnings Drift Agent Spec

**Created**: 2026-05-19
**Status**: Design — not yet implemented
**Context**: Two new mechanical agents to fill structural gaps in the current 4-agent stack (Prophet/Harvest/Spark/Turtle). All existing agents are momentum/trend/premium-flavored; this spec adds (1) a counter-correlation mean reversion sleeve and (2) a catalyst-driven earnings drift sleeve.

---

## Why these two

Current coverage of the active stack:

| Agent | Strategy | Regime where it earns |
|---|---|---|
| Prophet (default) | v2-options | Directional trends, vol expansion |
| Harvest | Iron condors on indices | Range-bound, low realized vol |
| Spark (penny-prophet) | Penny momentum | Speculative momentum bursts |
| Turtle (trend-prophet) | Donchian on macro ETFs | Sustained macro trends, crisis alpha |

**Gap 1** (largest): No mean-reversion strategy. Every active agent bets on continuation. In choppy/range-bound stock environments, none of them earn. Mean reversion is the canonical complement — different correlation profile, validated by decades of academic literature (Connors RSI(2), Aronson, RenTech).

**Gap 2**: No catalyst-driven sleeve. The repo already has the skill infrastructure (`earnings-calendar`, `earnings-trade-analyzer`, `pead-screener`, `catalyst-news`) but no agent that executes on it. Post-Earnings Announcement Drift (PEAD) is one of the most-replicated anomalies in finance (Bernard & Thomas 1989 onward).

Guardian (the existing "conservative" template) was deleted as part of this initiative — it had no sandbox, no strategy, and overlapped conceptually with the work this spec covers. See decision in commit history.

---

## Agent 1: Mean Reversion ("Coil")

### Identity
- **Archetype**: Mechanical rule-executor (Harvest/Turtle pattern, NOT Prophet pattern). Helpful improvisation is the failure mode.
- **Name**: **Coil** (chosen 2026-05-19 — springs back when stretched; strategy-specific over the more generic "Tide")
- **Agent ID**: `mean-rev` (proposed)
- **Strategy ID**: `mean-rev-rsi2` (proposed)

### Strategy core (Connors-style RSI(2))

| Component | Value | Rationale |
|---|---|---|
| Universe | S&P 500 stocks, ADV > $50M, price > $20 | Liquid; avoids Spark's penny domain and Turtle's ETF domain |
| Entry trigger | RSI(2) < 5 **AND** close > 200-day SMA **AND** no earnings within next 5 trading days | Buy oversold pullbacks **only within uptrends**. Earnings filter avoids binary landmines. |
| Confirmation (optional) | Close < 5-day SMA (must already be pulling back) | Filters runaways masquerading as dips |
| Exit | RSI(2) > 70 **OR** close > 5-day SMA **OR** 5-trading-day timeout **OR** stop at −7% | Mean cross is the primary exit; timeout prevents bagholding |
| Position size | 5% of equity, equal-weight | Conservative; survives a losing streak |
| Concurrent positions | Max 5 | 25% max deployed — true sleeve, not core |
| Regime gate | If SPY < 200-day SMA, half-size OR hard pause (decide) | Mean reversion breaks in sustained bears |

### Cadence
- Primary beat: **15:45 ET** (15 min before close). RSI(2) is a daily-bar indicator — intraday wakeups waste tokens.
- Optional second beat: **09:35 ET** to check exits on overnight gaps.
- Estimated cost: ~1–2 beats/day, similar to Turtle. **<5% of Prophet.**

### Infrastructure reuse
- `place_managed_position` (stop + target pre-set) — Spark pattern
- `get_quote`, `get_historical_bars` — for RSI(2) and SMA
- `log_decision` / `log_activity`
- New endpoint: `get_mean_reversion_candidates` (mirrors `get_penny_candidates` pattern — keeps agent dumb)

### Decisions locked (2026-05-19)
1. **Universe**: Stocks only — no SPY/QQQ (avoids Harvest overlap)
2. **Bear regime (SPY < 200MA)**: Half-size positions, keep agent learning. Kill-switch via env var (`MEANREV_BEAR_MODE=halt|halfsize|normal`, default `halfsize`).
3. **RSI(2) computation**: Pipeline endpoint `get_mean_reversion_candidates` (matches `get_penny_candidates` pattern). Agent stays a dumb rule executor — no inline historical-bar fetches.
4. **Name**: Coil.

---

## Agent 2: Earnings Drift ("Drift")

### Identity
- **Archetype**: Signal-gated mechanical (Spark pattern). Pulls from existing earnings skills, executes high-conviction subset.
- **Name**: "Drift" (directly references PEAD)
- **Agent ID**: `drift` (proposed)
- **Strategy ID**: `earnings-drift` (proposed)

### Scope: PEAD only — not pre-earnings
- **PEAD** = buy *after* the gap, ride drift for weeks. 40+ years of academic backing, lower variance.
- **Pre-earnings** = bet on the print, binary outcome. Excluded — Drift does not predict earnings.

### Strategy core

| Component | Value | Rationale |
|---|---|---|
| Universe | $2B+ market cap stocks that reported in last 5 trading days | Aligns with existing `earnings-trade-analyzer` focus |
| Entry trigger | Earnings beat **AND** gap-up >3% on report day **AND** above 50/200-day MA **AND** A or B grade from `earnings-trade-analyzer` | Multiple confirmations of drift candidate |
| Entry timing | Day after gap, on close > previous day's high (continuation) OR `pead-screener` red-candle pullback breakout | Lower entry risk than buying the gap day itself |
| Exit | Target +20%, stop −10%, time stop 60 trading days | PEAD literature shows drift typically completes within 60 days |
| Position size | 4% of equity per position | Tighter than mean-rev (event risk) |
| Concurrent positions | Max 4 | 16% max deployed |
| Season filter | Only trade during earnings windows (~3 weeks/quarter × 4 = ~60 trading days/year) | Off-season has no candidates |

### Cadence
- **Earnings season** (~60 days/year): daily beat at 17:00 ET (after-close scan) + optional 09:35 ET (position management on overnight news)
- **Off-season**: weekly beat to monitor stale positions
- Estimated cost: ~170 beats/year. **~3–5% of Prophet's annual usage.**

### Infrastructure reuse
- `earnings-calendar` skill → fresh earnings list
- `earnings-trade-analyzer` skill → 5-factor A/B/C/D scoring
- `pead-screener` skill → red-candle breakout signal
- `catalyst-news` skill → corroborating news (optional)
- `place_managed_position` — same stop+target pattern
- New endpoint: `get_earnings_drift_candidates` (aggregates and ranks)

### Decisions locked (2026-05-19)
1. **Signal aggregation**: Hybrid A — `get_earnings_drift_candidates` endpoint aggregates and ranks, but returns underlying skill outputs (earnings-trade-analyzer factor breakdown, pead-screener signal flags) in the payload. Cost delta vs pure endpoint: ~130K tokens/year (~0.1% of Prophet); benefit (decision log captures full reasoning chain) is much greater.
2. **Morning beat**: Skip in v1. 17:00 ET beat only — that's when fresh earnings data lands.
3. **Instrument**: Stock-only. PEAD literature is equity-based; options adds gamma exposure the academic edge doesn't pay for.

---

## Implementation phasing

### Session A — Delete Guardian (~5 min) ✅
- Remove `conservative` agent from `data/agent-config.json` and `agent/config-store.js`
- No sandbox references it; safe deletion
- Single commit when user confirms

### Session B — Build Coil/Tide (mean reversion)
1. Decide open questions (name, regime gate behavior)
2. Write `TRADING_RULES_MEANREV.md` (mirrors `TRADING_RULES_TREND.md` / `TRADING_RULES_HARVEST.md` mechanical structure)
3. Build `get_mean_reversion_candidates` Go service endpoint + tests
4. Add MCP tool wrapper in `mcp-tools/`
5. Add strategy + agent entries to `agent-config.json` and `agent/config-store.js`
6. Create sandbox `sbx_mean_rev` via UI or config edit
7. Verify first scheduled beat runs and decides "no trade" (until real signal)
8. Single squashed commit

**Why first**: simpler dependencies (price data only), bigger structural gap, faster to validate.

### Session C — Build Drift (earnings PEAD)
1. Decide open questions
2. Validate `earnings-trade-analyzer` + `pead-screener` outputs are agent-grade stable
3. Write `TRADING_RULES_DRIFT.md`
4. Build `get_earnings_drift_candidates` endpoint + tests
5. MCP tool wrapper
6. Add strategy + agent + sandbox
7. Single commit

**Why second**: more skill-pipeline dependencies to verify before wiring an agent on top.

### Session D — Equity sector rotation (deferred)
Only after observing Coil + Drift for ≥2 weeks. Revisit whether Turtle's macro rotation is sufficient.

---

## Cost summary

| Agent | Estimated tokens vs Prophet |
|---|---|
| Prophet (baseline) | 100% |
| Harvest | ~30–50% |
| Spark | ~50–80% |
| Turtle | <1% |
| **Coil/Tide (new)** | **~5–10%** |
| **Drift (new)** | **~3–8%** |

Combined burn after both new agents: **~10–20% on top of current spend**.

---

## References to existing patterns

When implementing, mirror these:

- **Mechanical agent prompt structure**: `agent-config.json` → `harvest` agent + Turtle's prompt. Both lean on the "rule executor wrapped in language model" framing.
- **Signal-gated pattern**: Spark / `penny-prophet` agent. Beat starts with candidate scan, then management.
- **Scheduled-beat config**: Turtle's `scheduledBeats: { times: ["17:00"], weekdaysOnly: true, exclusive: true, windowMinutes: 5 }`.
- **Strategy rules file**: `TRADING_RULES_HARVEST.md` and `TRADING_RULES_TREND.md` for mechanical structure. `TRADING_RULES_PENNY.md` for signal-gated structure with custom rule sections.
- **Managed-position pattern**: every agent uses `place_managed_position` for atomic stop+target pre-placement.

---

## Decisions locked — ready for Session B

All open questions resolved 2026-05-19. See the "Decisions locked" subsections above. No outstanding design work; Session B can proceed directly to implementation (rules file → Go endpoint + tests → MCP tool → config wiring → sandbox creation → first-beat verification).
