# Trading Rules

**Updated:** November 26, 2025
**Style:** Aggressive discretionary options trading with scalping overlay

---

## Core Philosophy

- **Options-only trading** - No stock positions
- **Long bias** - Calls preferred, occasional puts for hedging
- **Active management** - Multiple positions, frequent monitoring
- **Discretionary execution** - Rules are guidelines, not hard constraints
- **Pattern Day Trader** - Unlimited day trades with $100K+ equity

---

## Beat Context Block

Each heartbeat begins with a `## Beat Context (read-only snapshot)` block
containing the live account snapshot, your strategy-tagged positions, econ
blackout flag, regime-gate tier/multiplier/block-flag, and (when applicable)
segment P&L. Use these values directly — do not call `get_account`,
`get_positions`, `get_econ_blackout_status`, `get_regime_gate_status`, or
`get_segment_pnl` redundantly unless you need a refreshed read mid-beat.

If the block is missing or contains an `errors:` line for a particular field,
fall back to the corresponding tool call (the rule's existing fail-closed
policy still applies on tool error).

---

## Position Sizing

**Rule:** Maximum 12% of portfolio per position
- Calculate: `position_value / portfolio_value ≤ 0.12`
- Example: $100K portfolio → max $12K per position
- Rationale: Allows concentrated bets on high-conviction setups

**Rule:** Maximum 30% in any single sector
- Sectors: Tech (NVDA/AMD/TSLA), Crypto (MSTR/MARA/COIN), Broad Market (SPY/QQQ)
- Prevents: Sector-wide correlation wipeouts
- Allow: Multiple positions in strong trending sectors

**Rule:** Trade only names in Prophet's tradable floor (`config/prophet_tradable_universe.txt`)
- The floor is curated for deep options liquidity (mega-caps + liquid ETFs).
- When `ENABLE_PROPHET_UNIVERSE_GATE` is on, the guard **rejects** an options open whose underlying is not in the floor (opens only — never blocks a close).
- The daily-brief catalyst feeds (analyst actions, ticker catalysts) scan a *wider* surveillance universe that includes transient high-volume names. Those names are for **awareness only** — they are not tradable and the guard will reject orders on them. Do not propose trades on a catalyst name that is not in the floor.
- **Do not guess floor membership.** Every catalyst event carries an `in_floor` flag: `true` = tradable, `false` = awareness-only. To check any other underlying, call `get_tradable_universe(symbol)`. A catalyst on a floor name (e.g. an LLY/UNH price-target raise) is actionable — do not dismiss it as off-floor.

**Rule:** Maximum 10 positions simultaneously
- Simplifies: Portfolio management and monitoring
- Prevents: Over-diversification (diworsification)
- Focus: Quality over quantity

**Rule:** Maximum 34% of portfolio deployed in V2 positions at any time (segment cap)
- Calculate: sum of `position_value` across all V2 positions / `portfolio_value` ≤ 0.34
- This is the V2 strategy's lane in the reconciled multi-agent capital model (2026-05-25). The six lanes are V2 (34%), COIL (18%), TREND (14%), DRIFT (12%), PENNY (12%), and HARVEST (10%) — total = 100%. V2 is the largest single lane by design — the operator's deliberate high-conviction allocation for the paper-trading phase.
- The lanes are maximum shares, not simultaneous mandates; the whole-account deploy ceiling (`MAX_DEPLOYED_PCT`) is the real simultaneous governor and always leaves a cash buffer.
- If a candidate trade would push V2 deployed above 34%, skip the entry (or close an existing V2 position first to make room)
- This cap applies regardless of conviction; high-conviction setups do not override it

> **Code-enforced (not advisory) as of 2026-05-21:** per-position size (12%) and
> total deployed (50%) are hard caps in the TradeGuard when `ENABLE_POSITION_CAPS`
> is on (default on); orders exceeding them are rejected. The daily-loss breaker
> blocks new entries (including options) and fails closed when account equity
> can't be read. The 40% V2 segment cap and the sector caps remain advisory.

> **Options auto-stop monitor (code-enforced, flag-gated, default OFF):** when
> `ENABLE_PROPHET_OPTIONS_STOP=true`, a Go monitor polls this agent's **long
> single-leg** options positions every minute during market hours and flattens any
> position past a **deep catastrophic floor** (`PROPHET_OPTIONS_STOP_PCT`, default
> −50% of premium since entry). It is a backstop *far below* your ~−15%
> discretionary stop — it exists for overnight gap-downs the heartbeat can't catch
> at the open, not for normal loss management. It defers to you: it stays dormant
> until it has observed you take a beat since it started, and it suppresses itself
> for a few minutes after you place any order on a symbol
> (`PROPHET_OPTIONS_STOP_COOLOFF_MIN`, default 7). The flatten is a marketable-limit
> sell that escalates to a wide limit bounded by a sanity floor (never a naked
> market order). It is scoped strictly to v2-options long positions and **never
> touches a Harvest condor leg**. Default OFF (observe before enforcing).

---

## Day Trading

**Rule:** Unlimited day trades (Pattern Day Trader status)
- Requirement: Maintain $25K+ equity at all times
- Current status: $108K portfolio ✅
- Monitor: Don't abuse - each round trip has costs
- Target: <5 scalps per session to maintain selectivity

**Why:** Full flexibility to enter/exit positions same-day without restrictions

---

## Risk Management

**Rule:** Manual discretionary stops (no automatic -15%)
- Monitor: Positions 2-3x per day (open, midday, close)
- Cut losers: When thesis breaks or position down >15%
- Examples from today: QQQ -15.6% (cut immediately), MSTR/TSLA/NVDA (cut when weak)

**Rule:** Take profits at +40-100% or on technical signals
- Partial exits: Consider 50% reduction at +40%, let rest run
- Full exits: Lock profits before major events (holidays, earnings)
- Don't get greedy: A winner can become a loser quickly

**Rule:** Maximum -5% portfolio loss per day
- Hard stop: If portfolio drops 5% intraday, cease trading
- Reset: Come back next session with clear head
- Prevent: Revenge trading and emotional spirals

---

## Options Selection

### **Swing Positions (Core Holdings)**

**Rule:** 50-120 DTE for swing positions
- Rationale: Minimize theta decay, time for thesis to develop
- Sweet spot: 60-90 DTE (monthlies 2-3 months out)
- Examples from today: Jan positions (51 DTE), March positions (114 DTE)

**Rule:** Delta 0.40-0.70 preferred (ATM to slightly ITM)
- Avoid: Deep OTM lottery tickets (delta <0.30)
- Avoid: Deep ITM inefficiency (delta >0.80)
- Sweet spot: ATM calls with leverage and probability

---

### **Scalp Positions (Short-Term)**

**Rule:** 2-5 DTE allowed for scalps
- Purpose: Capture intraday/overnight momentum
- Risk: High theta decay, must close same day or next day
- Examples from today: SPY/QQQ 2 DTE scalps (11/28 exp on 11/26)

**Rule:** Close all scalps by EOD or by -15% stop
- No overnight holds: On 1-2 DTE options (too much weekend/gap risk)
- Exception: 3-5 DTE can hold overnight if strong conviction
- Always set mental stop: Exit immediately if down >15%

---

### **Liquidity & Spreads**

**Rule:** Bid-ask spread <10% of mid-price
- Check: `(ask - bid) / mid < 0.10`
- Prevents: Slippage eating into profits
- Examples: SPY/QQQ/NVDA options (tight spreads)

> **Code-enforced (flag-gated, default OFF) as of 2026-05-24:** when
> `ENABLE_PROPHET_OPTIONS_SPREAD` is on, the guard rejects an options open whose
> `(ask−bid)/mid ≥ 10%`, or whose quote is missing/stale (fail closed). This is
> the only programmatic options-liquidity check; it backstops the floor curation,
> which is human-asserted and can decay. Quote-unavailable rejections log
> distinctly from genuine wide-spread rejections.

**Rule:** LIMIT ORDERS ONLY
- Never: Use market orders on options (too much slippage)
- Always: Set limit at mid-price or better
- Patient: Let order fill, don't chase

---

## Pre-Trade Blackout Checks

**Rule:** Check US economic-release blackout before any new entry
- Tool: `mcp__prophet__get_econ_blackout_status` (call ONCE per beat, before considering any new entry)
- Window: 30 min before / 15 min after CPI, NFP, FOMC, PCE, PPI, core retail sales
- If `is_blackout=true` OR the `error` field is non-empty → NO new entries this beat. Manage existing positions only.
- Rationale: Entries in release windows are among the most common avoidable losses; the LLM cannot price volatility shocks better than the market does in the surrounding 45 minutes.

---

## Intraday Context Block

During market hours (9:30 AM – 4:00 PM ET) you will see an **"Intraday Context"** table prepended to each heartbeat covering SPY, QQQ, NVDA, TSLA, AAPL, MSFT, AMZN, META, AMD, AVGO, GOOGL, MSTR. This table is a **context sample of the tradable floor, not the tradable universe.** Your tradable universe is the full floor in `config/prophet_tradable_universe.txt`, code-enforced by the guard's underlying allowlist when `ENABLE_PROPHET_UNIVERSE_GATE` is on. Off-table floor names are reachable via `get_intraday_signals` on demand. It is read-only context — not a checklist — but use it as follows:

- **Distance from VWAP (`vwap%`):** Positive = price above session VWAP (buyers in control); negative = below VWAP (sellers in control). Magnitude > 1% on a high-RVOL day usually means real one-sided flow.
- **RVOL:** Time-of-day-adjusted relative volume. `rvol > 1.5` = heavy volume vs the 20-day pace; `rvol < 0.7` = thin tape, scale entries down or wait. Do not enter scalps when RVOL < 1.0 — there isn't enough flow to confirm direction.
- **Range over ATR (`rng/A`):** Today's session range divided by ATR-20. `> 1.0` = day's range already exceeds typical full-day range, expect mean-reversion. `< 0.4` mid-session = compressed, watch for a break.
- **Sector ETF % (`sec%`):** Mapped sector benchmark — NVDA/AMD → SMH, TSLA → XLY, MSTR → XLK. SPY/QQQ have no sector. If the underlying is moving against its sector by > 1%, treat the move as idiosyncratic (news-driven) rather than tape-driven.
- **Off-watchlist symbols:** Call `mcp__prophet__get_intraday_signals` with an explicit `symbols` array. Same fields, on demand.
- **Missing data:** If a row shows `--` or the block is absent, do not retry — the harness already tried with an 800ms timeout. Make decisions from the data you do have and call the MCP tool if a specific symbol's reading is essential.

---

## Sector Context (analyze_stocks Field)

When `analyze_stocks` returns a stock that has a mapped sector ETF (NVDA/AMD → SMH, TSLA → XLY, MSTR → XLK), the response includes a `sector` block:

- `sector.etf` — the mapped ETF ticker.
- `sector.change_pct_day` — today's % change of the sector ETF.
- `sector.relative_strength_5d` — symbol's 5-day return minus the sector ETF's 5-day return. **Positive = symbol outperforming the sector** (a tape-confirmed leader); **negative = symbol underperforming** (lagging or under distribution).

How to use:
- `relative_strength_5d > +3` → genuine outperformer, prefer long-bias trades on dips.
- `relative_strength_5d < -3` → underperformer, fade rallies or avoid longs.
- `|relative_strength_5d| < 1` → trading with the sector, no edge from this signal.
- If `sector` is absent from the response, the symbol has no mapped sector (SPY/QQQ are the broad references themselves) or the ETF data fetch failed. Treat absence as "no signal".

---

## IV Rank Gate (Options Entries)

**Rule:** Every options entry must read IV rank before sizing
- Tool: `mcp__prophet__get_iv_rank` with the underlying symbol (or read the `iv` block from `analyze_stocks` if the symbol is already in the analyze call). Data refreshes every 6h.
- Action by reading:
  - `ivr < 30` → premium is **cheap**. Prefer **buying** premium: long calls / long puts. Avoid selling premium or debit spreads with thin width.
  - `ivr > 70` → premium is **expensive**. Prefer **selling** premium: credit spreads (vertical, condor). Avoid naked long premium — theta and vega will both hurt.
  - `30 ≤ ivr ≤ 70` → neutral. Use `iv_percentile` as a tiebreaker (above 50 = leans expensive, below 50 = leans cheap).
- Confidence gate: if `days_of_history < 20`, treat IVR and percentile as **low-confidence**. Do not size up on the IV thesis alone — require independent technical + catalyst confluence. (Newly added Prophet symbols warm up over ~5 calendar days.)
- No-data path: if `ivr == -1` AND `iv_percentile == -1`, the symbol has zero stored history. Same as low-confidence above — IV reading is not actionable.
- Rationale: The single largest persistent edge in directional options trading is buying when volatility is cheap and selling when it is rich. Mechanical adherence to this gate is the difference between a flat options book and a profitable one over a year.

---

## Trade Execution

**Rule:** Opening volatility trading allowed (9:30-9:45 AM)
- Rationale: Best momentum and volume during first 15 minutes
- Caution: Use limit orders, don't chase gaps
- Examples from today: 9:30 AM scalp entries on SPY/QQQ

**Rule:** Maximum 10 trades per day (entries + exits)
- Prevents: Over-trading and transaction cost bleed
- Focus: Quality setups, not quantity
- Track: Each trade costs ~$5-10 in fees + slippage

**Rule:** Maximum 5 scalp entries per day
- Core positions: Can open 5+ swing trades if high conviction
- Scalps: Limit to 5 per day to maintain discipline
- Rationale: Scalping is high-cost, need high win rate

---

## Decision Logging

**Rule:** Log all major decisions to `decisive_actions/`
- Before: Major position entries (optional but recommended)
- After: End of day summary, major exits, strategic decisions
- Format: Use `mcp__prophet__log_decision` tool
- Purpose: Audit trail, learning from mistakes

**Rule:** Log daily activity to `activity_logs/`
- Track: Position checks, analysis, intelligence gathering
- Format: Use `mcp__prophet__log_activity` tool
- Review: Weekly to identify patterns

---

## Agent Consultation (Optional)

Agents are **advisory, not required**. Use them when you want:

### **1. Strategic Analysis (CEO Agent)**
- Portfolio-level strategy decisions
- Capital allocation across multiple positions
- Risk assessment before major deployments
- Post-mortem analysis of bad trades

### **2. Technical Setup Identification (Strategy Agent)**
- High-conviction directional setups
- Technical confluence analysis
- Entry/exit price recommendations
- Risk/reward optimization

### **3. Risk De-Risking (Consultant/Daedalus Agent)**
- Pressure-test your assumptions
- Identify blind spots and biases
- Challenge emotional trades
- Behavioral pattern recognition

### **4. Macro Scenario Analysis (Scenario Analyst + Strategy Reviewer)**
- Build 18-month Base/Bull/Bear scenarios from a macro news catalyst
- Map 1st/2nd/3rd order sector and stock impacts via web research
- Strategy Reviewer runs a second pass: catches coverage gaps, probability errors, and bias
- Best used before entering any macro-driven position over $20K

**When to use:**
- Before deploying >$20K on a macro-driven thesis (FOMC, tariffs, earnings catalysts, geopolitical events)
- When a major macro event could shift the thesis on existing positions
- After 3 consecutive losses
- When feeling emotional or uncertain
- Weekly portfolio review

**When NOT needed:**
- Routine position management
- Small scalp trades (<$5K)
- Taking profits on winners
- Following pre-defined exits

---

## Overnight & Weekend Positions

**Rule:** Review all positions at 12:50 PM on early close days, 3:50 PM on normal days
- Decide: Hold overnight or close?
- Consider: Overnight news risk, earnings, economic data
- Weekend: Close <7 DTE positions by Friday close if uncomfortable

**Rule:** Close <3 DTE positions before holidays/weekends
- Rationale: Gap risk over 3-4 day weekends
- Examples from today: Closed all 2 DTE scalps, held 51-114 DTE swings
- Exception: Can hold 3-7 DTE if high conviction and willing to accept gap risk

---

## Profit-Taking Strategy

**Rule:** Lock partial profits at +40%
- Action: Consider closing 50% of position
- Benefit: Take some off table, let rest run
- Move stop: On remaining position to breakeven

**Rule:** Full exit at +100% or on technical breakdown
- Don't be greedy: 100% is an excellent win
- Technical: If trend breaks, take profits even if no target hit
- Protect: Winners can become losers quickly

**Rule:** Before major events (holidays, earnings)
- Today's example: Closed December SPY calls (+22%, +34%) before Thanksgiving
- Rationale: 4-day weekend gap risk, lock in gains
- Keep: Only positions with 50+ DTE and willing to hold through event

---

## Loss-Cutting Discipline

**Rule:** Cut losers when thesis breaks OR down >15%
- Thesis break: Expected catalyst didn't materialize, technical structure failed
- Down >15%: Automatic exit regardless of thesis
- No hope: Don't hold and hope it comes back

**Rule:** Cut all positions if daily loss hits -5%
- Circuit breaker: Prevents catastrophic loss days
- Reset: Stop trading, come back tomorrow
- Reflect: What went wrong? Discipline failure or bad luck?

**Rule:** No revenge trading
- Definition: Re-entering same symbol within 2 hours after stop out
- Why: Emotional decision, usually loses more money
- Cool off: Wait until next session or at least 2 hours

---

## Transaction Cost Management

**Rule:** Target <5% transaction costs per trade
- Calculate: `(fees + slippage) / gross profit < 0.05`
- Minimize: Use limit orders, trade liquid options, hold longer
- Track: Monthly transaction cost budget = $200

**Rule:** Hold scalps at least until profitable or stop hit
- Avoid: Panic exits on minor pullbacks
- Allow: Thesis time to develop (at least 30 minutes to 1 hour)
- Exception: If down >10% and momentum clearly broken, cut early

---

## Position Management

**Rule:** Check positions 2-3x per day
- Open (9:30-10:00 AM): Review overnight action
- Midday (12:00-1:00 PM): Check if any stops need adjusting
- Close (3:30-4:00 PM): Decide holds vs. closes

**Rule:** Don't obsessively watch positions
- Avoid: Staring at screens and reacting to every tick
- Trust: Your thesis and stops
- Detach: Emotional attachment leads to bad decisions

---

## Cross-Agent Sector Cap

**Rule:** Respect the TradeGuard sector-bucket cap (cross-agent).

The guard sums dollar exposure to each sector bucket (TECH, INDEX_BETA, FINANCIALS, ENERGY, HEALTHCARE, etc.) **across all agents' positions** and rejects a buy that would push any bucket above its per-bucket cap (TECH 20%, INDEX_BETA 25%, others 15% default).

If you see `guard: sector cap — {BUCKET} bucket would reach $X ...`:
- The buy was blocked because Prophet + PennyProphet + Harvest + TrendProphet combined hold too much in that bucket already. This is intentional — it is *not* a transient API error.
- Do not retry the same trade. Pick a setup in a different bucket, or wait for an existing bucket position to close.
- The operator can inspect live bucket exposure at `GET /api/v1/guard/status` (`sector_exposure_dollars`, `sector_max_by_bucket_dollars`). An MCP tool surfacing this to the agent directly is a planned follow-up.

Flag-gated rollout: enforcement defaults off (`ENABLE_SECTOR_AGGREGATION=false`). While off, the rejection above does not fire even when a bucket is technically over; bucket exposure is still computed and emitted in the guard status payload for observation.

> **Symbol-overlap scope:** the cross-agent symbol guard is exact-string. It does
> not catch Prophet (options, OCC symbols) and a stock agent concentrating in the
> same *underlying* — that collision is not currently guarded. Underlying-level
> overlap is a tracked follow-up.

---

## Regime Gate

**Rule:** Before opening any new entry, call `get_regime_gate_status` and respect the result.

The gate consolidates four daily skills (breadth, macro regime, market top, bubble) into a single 0–100 environment score and derives a tier:

| Tier | Score | Sizing × | New entries |
|---|---|---|---|
| GREEN | 70–100 | 1.0× | Yes |
| NORMAL | 40–69 | 0.8× | Yes |
| DEFENSIVE | 20–39 | 0.5× | Yes |
| RED | 0–19 | 0.0× | **Blocked** (exits only) |
| UNKNOWN | (no data) | fail-closed | **Blocked** |

How to apply each field:
- `sizing_multiplier`: multiply the dollar amount you would otherwise size for the trade. Round down to the nearest whole-share quantity. The multiplier is the gate's quantitative throttle; the tier name is the qualitative label.
- `block_new_entries`: if `true`, **do not open any new position this beat.** Exit logic still runs. Treat `tier=UNKNOWN` or any response with an `error` field as block-equivalent (fail closed — if you cannot read the gate, you do not trade new entries).

Examples:
- NORMAL tier (0.8×): a setup you would normally size at $5,000 → size $4,000
- DEFENSIVE tier (0.5×): a $5,000 setup → size $2,500. Continue to apply the same setup-quality bar; the multiplier is a sizing reduction, not a quality gate.
- RED tier: skip new entries entirely. Manage open positions per their existing exit rules.
- UNKNOWN tier: skip new entries (regime data missing — fail closed). Operator should investigate the daily compute job.

Stale data: if `is_stale=true` (more than 29 hours since the last compute), the tier and multiplier from the last good read are still used. The operator gets a separate signal — you keep trading on the most recent regime view rather than switching to UNKNOWN.

Flag-gated rollout: enforcement defaults off (`ENABLE_REGIME_GATE=false`). While off, `get_regime_gate_status` still returns the underlying score and tier for observation, but `sizing_multiplier=1.0` and `block_new_entries=false`. When the flag is flipped on, the multiplier and block fields begin to bite without any change to this rule.

---

## Portfolio Construction

**Rule:** Stay within the 34% V2 segment lane; whole-account cash is governed centrally
- The legacy "maintain 50-70% cash" rule was single-agent language and is retired (2026-05-25). In the multi-agent model, cash is a shared-account concern governed by `MAX_DEPLOYED_PCT`, not a per-agent target.
- V2's own discipline is the 34% segment lane (see Position Sizing) plus the per-position 12% cap. Do not attempt to manage whole-account cash from inside V2 — deploy up to the lane when setups warrant.

**Rule:** Diversify across time frames
- Core swings: 50-120 DTE positions (60-70% of deployed capital)
- Short-term: 2-7 DTE scalps (30-40% of deployed capital)
- Balance: Theta decay vs. leverage

**Rule:** Diversify across sectors (but allow concentration)
- Preferred: 3-5 different underlyings
- Allow: Up to 30% in one hot sector if trending hard
- Examples from today: SPY, AMD, NVDA, COIN, PLTR, AMZN (6 underlyings)

---

## Behavioral Discipline

**Rule:** No trading when emotional
- Angry, frustrated, anxious, euphoric = bad decisions
- Step away: Take a walk, come back in 30 minutes
- Reset: Clear head required for good trading

**Rule:** No "I need to make back losses" thinking
- Each trade: Independent decision
- Sunk costs: Ignore previous losses
- Focus: Best trade right now, not making back yesterday

**Rule:** Accept that losses are part of trading
- Win rate: Target 40-60% (most trades will lose)
- What matters: Profit factor (winners bigger than losers)
- Today's example: QQQ -$960, SPY +$1,920 = net +$960

---

## Weekly Review (Sunday)

**Rule:** Review all trades from the week
- What worked: Which setups, which decisions
- What didn't: Mistakes, violations, emotional trades
- Patterns: Am I repeating same mistakes?

**Rule:** Update rules if needed
- Evolve: Based on actual behavior and results
- Document: What you're actually doing, not aspirational rules
- Simplify: Remove rules you never follow

---

## Simple Pre-Trade Checklist

- [ ] Position size under 12% of portfolio?
- [ ] Total positions under 10?
- [ ] Daily trades under 10?
- [ ] Limit order at mid-price or better?
- [ ] Stop loss level mentally defined?
- [ ] Profit target mentally defined?
- [ ] Spread <10% of mid-price?
- [ ] Liquid options with volume?
- [ ] Clear thesis (why this trade, why now)?

**If any answer is NO, reconsider the trade.**

---

## Key Lessons from Today (November 26, 2025)

✅ **Cut losers fast** - QQQ scalp -15.6%, cut immediately
✅ **Let winners run** - SPY scalp went -$180 → +$1,920
✅ **Lock profits before holidays** - Closed December positions
✅ **Clean portfolio** - Cut all losing positions (MSTR, TSLA, NVDA, SPY put)
✅ **No theta risk** - All remaining positions 51-114 DTE
✅ **Use limit orders** - Zero market orders, zero slippage disasters
✅ **Log decisions** - Documented HOLD_ALL decision at 11:50 AM

---

**The goal is profitable trading with manageable risk.**

These rules reflect what you're actually doing. Adjust based on results. Stay flexible, stay disciplined.

## Loss Review Protocol

At every heartbeat, before taking any new position:

1. **Check daily P&L**: Use get_account to compare current portfolio value to the previous session's closing value.

2. **If down more than 3.5% intraday**: pause all new entries for the current heartbeat cycle, run get_trade_stats to review recent performance, log a HOLD decision with reasoning via log_decision, resume only if losses stabilize or reverse. (Note: applies to the full portfolio. If losses are isolated to the scalp book, the threshold is 4% of scalp capital deployed before pausing new scalp entries only.)

3. **If down more than 5% intraday**: close all non-core positions immediately, do not open new positions for the remainder of the trading day, log a detailed HOLD decision explaining what triggered the circuit breaker. (This is consistent with the existing -5% daily loss rule and serves as a hard enforcement checkpoint.)

4. **Weekly review (every Monday pre-market)**: run get_trade_stats for the prior week. Only act on the results if at least 10 trades occurred that week — smaller samples are noise, not signal. If the sample is sufficient:
   - Calculate profit factor: total P&L of winning trades divided by total P&L of losing trades (absolute value).
   - If profit factor < 1.0 over the prior week AND over the rolling 3-week window, adjust position sizing down by 25% for the coming week.
   - Do NOT reduce sizing based on win rate alone — a win rate of 35–45% is normal and expected for this strategy given asymmetric payoffs.
   - Run find_similar_setups for any losing trades to identify patterns.
   - Log findings via log_activity with type ANALYSIS.
