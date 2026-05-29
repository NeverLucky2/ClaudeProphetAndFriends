# Per-Agent Daily Token Cost — Design

**Date:** 2026-05-28
**Status:** Approved, ready for implementation plan
**Owner:** Agent harness / dashboard

## Motivation

Per-beat token usage and cost are already captured in `agent/beat-cost.js` —
the harness pulls `cost` and `tokens.{input, output, reasoning, cache.{read,
write}}` out of every opencode `step_finish` event, accumulates per-beat
totals, and emits a one-line recap to the `agent_log` SSE stream at end of
beat (`Beat cost: $0.0123 | tokens 5.4k …`).

That recap is *visible* in real time but is not *persisted*. There is no way
to answer "did Prophet cost less today than the 7-day average?" without
scraping the SSE log. Several recent token-cost-reduction projects (Prophet
quick-wins, regime-skill cost reduction, Prophet beat-skip) all shipped
without a measurement instrument that could tell the operator whether the
changes paid off.

The operator wants a structured rollup of per-agent × per-phase × per-day
spend, surfaced as both a dashboard tab and a daily markdown report, so the
impact of optimization work can be read off at a glance and compared over
time.

## Scope

In scope:

- A new `agent/cost-store.js` module that owns per-day rollup files at
  `data/sandboxes/{accountId}/costs/{YYYY-MM-DD}.json`, keyed on
  `(sandboxId, agentId, phase)`.
- One-line harness wiring: where `formatBeatCostLine` already emits the
  end-of-beat recap, also call `costStore.recordBeat(...)`.
- A `GET /api/v1/costs?days=N` endpoint returning a dashboard-ready
  aggregated payload (per-agent today / 7-day-avg / delta / sparkline /
  per-phase breakdown).
- A new "Costs" tab in `agent/public/index.html` rendering Layout A (agent-
  row table with click-to-expand per-phase breakdown).
- A `scripts/cost-report.mjs` CLI shim that imports `cost-store.js` directly
  and emits JSON to stdout, for use by skills (`review-performance`,
  `adapt-strategy`, `postmortem`).
- A post-close hook in `agent/analysis-scheduler.js` that writes
  `data/reports/cost_YYYY-MM-DD.md` summarising the day with auto-flagged
  notable shifts.

Out of scope (explicit non-goals):

- Per-beat raw event retention. Daily rollups only. If forensic per-beat
  drilldown is wanted later, it is a separate feature with its own storage.
- Budget alarms or alerting when an agent crosses a cost threshold. The
  use case here is measurement, not enforcement.
- Slack notifications of the daily report. The Slack plugin scaffolding
  exists in `data/agent-config.json` but is per-sandbox-disabled today;
  enabling Slack is its own decision.
- Cost forecasting or projection. Record and display historical numbers
  only.
- Backfill from existing `agent_log` SSE history. The stream is not
  persisted to disk in a parseable way; backfilling would be brittle and
  lossy. Data starts accumulating from the deploy day forward.
- A shared util module for `_etDate()`. The same helper is already
  duplicated locally in `trades-store.js` and `fills-summary.js`; matching
  that pattern is in scope, extracting it to a shared module is a separate
  cleanup PR.
- Multi-machine cost aggregation. Single-machine deployment per current
  operator setup.

## Decisions Locked During Brainstorming

Recorded so future readers do not re-litigate:

1. **Primary use case: optimization measurement.** The feature exists to
   tell the operator whether token-reduction changes are working. That
   implies persistence + historical comparison + per-phase granularity (so
   a phase-targeted change is not masked by a flat daily total).
2. **Both dashboard + daily report file as surfaces.** Dashboard for live
   inspection; report file so skills can read it and so there is a written
   record outside the dashboard.
3. **Per-agent × per-phase grain.** Phase breakdown matters because recent
   optimization work is phase-targeted (regime-skill cost reduction hits
   `pre_market`; Prophet beat-skip hits `midday`). A flat daily total can
   hide "pre_market dropped 40% but midday rose 15%."
4. **Daily rollups only**, no per-beat raw retention. Smaller footprint;
   sufficient for the use case.
5. **ET trading-day as the day boundary.** Matches what `fills-summary.js`
   (`startOfEtTradingDayIso`) and `trades-store.js` (`_etDate`) already
   use. After-hours beats roll into the current trading day.
6. **Skills get read access** via a CLI shim (`scripts/cost-report.mjs`),
   not via the HTTP endpoint, so cost data is available even if the
   dashboard server is down.
7. **Single-JSON-file storage rejected in favor of per-day files.** The
   first proposal was one mega-file at `data/cost-tracking.json`.
   Replaced with per-day-per-account files to match the existing
   `trades-store.js` filesystem convention. Same `_etDate()` helper, same
   directory shape, lower cognitive load. Corrupt write affects one day,
   not the whole history.
8. **Layout A wins over Layout B.** Agent-row table with sparkline + click-
   to-expand per-phase breakdown. Most scannable, no chart-rendering
   dependency, matches the rest of the dashboard's table-heavy style.
9. **Default ON.** This is data-only observability with no trading
   behavior change. Matches the rollout default for silent-fill summary,
   failed-trade indicator, and trade-reconciliation. Env var
   `COST_TRACKING_ENABLED=true|false` (default `true`) disables all four
   consumers + the producer.
10. **No backfill.** First 7 days post-deploy will show "—" in the
    delta column. Acceptable given the alternative (log scraping) is
    brittle.

## Architecture

### File layout

```
agent/
  cost-store.js          NEW. recordBeat / readDay / readRange / aggregateByAgent
  cost-store.test.mjs    NEW. node:test, pure unit + I/O tests
  harness.js             MODIFY. One call to costStore.recordBeat at end-of-beat,
                         wrapped in try/catch (soft-fail).
  server.js              MODIFY. GET /api/v1/costs?days=N endpoint.
  analysis-scheduler.js  MODIFY. Post-close hook to write the daily report.
  public/
    index.html           MODIFY. "Costs" tab button + body + render JS.

scripts/
  cost-report.mjs        NEW. CLI shim importing cost-store; emits JSON to stdout.

data/
  sandboxes/
    {accountId}/
      costs/
        {YYYY-MM-DD}.json   NEW. Per-account per-day rollup file.

data/reports/
  cost_{YYYY-MM-DD}.md      NEW. Per-day markdown report written post-close.
```

### Data flow

```
opencode step_finish event
        │
        ▼
harness._handleOpenCodeEvent
  (already extracts tokens & cost via extractTokenDelta)
        │
        ├──► existing: emit agent_log line with formatBeatCostLine
        │
        ▼
costStore.recordBeat({ accountId, sandboxId, agentId, agentName, model,
                       phase, cost, input, output, reasoning,
                       cacheRead, cacheWrite, beatStartAt })
        │
        ▼
read data/sandboxes/{accountId}/costs/{ET-day}.json (or empty)
        │
        ▼
upsert row keyed on (sandboxId, agentId, phase):
  - if absent: create with beat values; firstBeatAt = lastBeatAt = now
  - if present: cost += , all token fields += , beatCount += 1,
                lastBeatAt = now
        │
        ▼
atomic write: tmp file + fs.rename
        ▲                ▲                 ▲
        │                │                 │
   dashboard         skill CLI        daily report
   (HTTP GET)     (cost-report.mjs)   (analysis-scheduler post-close)
```

### Schema — `data/sandboxes/{accountId}/costs/{YYYY-MM-DD}.json`

```json
{
  "schemaVersion": 1,
  "date": "2026-05-28",
  "rows": [
    {
      "sandboxId": "sbx_6e4f26af",
      "agentId": "default",
      "agentName": "Prophet",
      "model": "anthropic/claude-sonnet-4-6",
      "phase": "midday",
      "cost": 1.3421,
      "input": 124000,
      "output": 31000,
      "reasoning": 0,
      "cacheRead": 480000,
      "cacheWrite": 12000,
      "beatCount": 7,
      "firstBeatAt": "2026-05-28T14:32:11.123Z",
      "lastBeatAt": "2026-05-28T19:54:02.987Z"
    }
  ]
}
```

**Unique upsert key:** `(sandboxId, agentId, phase)`. Both `sandboxId` and
`agentId` are carried even though sandboxId implies agentId for any one
config snapshot — if an agent is reassigned to a sandbox mid-day, the rows
stay correctly attributed.

**Field naming matches `extractTokenDelta()`** exactly (input / output /
reasoning / cacheRead / cacheWrite) so `recordBeat` accepts the extractor's
output without renaming.

`reasoning` is persisted even though it is excluded from total and cache-hit
math (per `formatBeatCostLine`), because storing it is free and preserves
forensic optionality.

**Row order on write:** rows are sorted by `(sandboxId, agentId, phase)`
before every atomic write. The sort cost is negligible (~30 rows worst
case) and stable ordering keeps file diffs meaningful when the operator
inspects a file by hand.

### Module API — `agent/cost-store.js`

```js
// recordBeat — upserts the (accountId, sandboxId, agentId, phase, date)
// row and accumulates the beat's cost + tokens. ET-date is derived from
// beatStartAt via the local _etDate helper. Soft I/O — caller wraps in
// try/catch for soft-fail behavior.
export async function recordBeat(projectRoot, {
  accountId, sandboxId, agentId, agentName, model, phase,
  cost, input, output, reasoning, cacheRead, cacheWrite,
  beatStartAt,
})

// readDay — returns { schemaVersion, date, rows } for one (accountId, date)
// pair, or null if the file is missing or the schemaVersion is unknown.
// Corrupt files log a single warning per file per process lifetime and
// return null.
export async function readDay(projectRoot, accountId, date)

// readRange — returns array of { date, rows } for [from, to] inclusive,
// optionally filtered by accountId or sandboxId. Newest date last.
// Missing days produce no entry (not an empty-row entry).
export async function readRange(projectRoot, { from, to, accountId, sandboxId } = {})

// aggregateByAgent — pure transform. Given readRange output, returns
// { agentId → { agentName, model, dates: { ymd → { cost, tokens,
//   beatCount, phases: { phase → { cost, tokens, beatCount } } } } } }.
// No I/O. Dashboard endpoint and skill CLI both use this.
export function aggregateByAgent(rangeData)

// _etDate — internal. Mirrors trades-store.js. Returns YYYY-MM-DD for the
// given Date in America/New_York. Duplication is intentional; extracting
// is a separate cleanup PR.
function _etDate(date)
```

### Harness wiring — producer

In `agent/harness.js`, at the existing end-of-beat block where
`formatBeatCostLine` emits the `agent_log` recap. Add a single guarded
call to `recordBeat`:

```js
if (totalCost > 0 || tokenTotal > 0) {
  this.state.emit('agent_log', { message: formatBeatCostLine({...}), ... });  // existing

  // NEW
  if (process.env.COST_TRACKING_ENABLED !== 'false') {
    try {
      await costStore.recordBeat(this.projectRoot, {
        accountId, sandboxId, agentId, agentName, model, phase,
        cost: totalCost,
        input: tok.input, output: tok.output, reasoning: tok.reasoning,
        cacheRead: tok.cacheRead, cacheWrite: tok.cacheWrite,
        beatStartAt: this.state.lastBeatTime,
      });
    } catch (err) {
      this.state.emit('agent_log', {
        message: `cost-store write failed: ${err.message}`,
        level: 'warn',
      });
    }
  }
}
```

The flag check is `!== 'false'` (not `=== 'true'`) so the default-ON
behavior survives the env var being unset. The write only happens when a
beat actually produced cost or tokens — zero-cost beats are not persisted,
which keeps the rollup file clean of empty rows from beats where opencode
did not emit a `step_finish` with usage.

### HTTP endpoint — `GET /api/v1/costs?days=7`

Returns dashboard-ready aggregated payload. Default `days=7`, max 90 (to
cap I/O on the read path).

```json
{
  "from": "2026-05-22",
  "to": "2026-05-28",
  "agents": [
    {
      "agentId": "default",
      "agentName": "Prophet",
      "model": "anthropic/claude-sonnet-4-6",
      "today":       { "cost": 3.18, "tokens": 412000, "beatCount": 95 },
      "sevenDayAvg": { "cost": 4.21, "tokens": 510000 },
      "delta":       { "costPct": -24, "tokensPct": -19 },
      "sparkline":   [3.42, 4.85, 5.12, 4.87, 4.21, 3.62, 3.18],
      "phasesToday": {
        "pre_market":   { "cost": 0.42, "beatCount": 12, "deltaPct": -38 },
        "market_open":  { "cost": 1.18, "beatCount": 31, "deltaPct":  -5 },
        "midday":       { "cost": 1.34, "beatCount": 42, "deltaPct": -28 },
        "market_close": { "cost": 0.21, "beatCount":  8, "deltaPct":   2 },
        "after_hours":  { "cost": 0.03, "beatCount":  2, "deltaPct":   0 }
      }
    }
  ],
  "totals": {
    "today":       { "cost": 4.93, "tokens": 580000 },
    "sevenDayAvg": { "cost": 5.91 },
    "delta":       { "costPct": -17 }
  }
}
```

Sparkline length always matches `days` query param. Any day with no
recorded data — whether pre-history, or a gap mid-history when the agent
was off — appears as `0` in the sparkline. Delta percentages are `null`
(rendered as "—") when the 7-day-avg basis is zero or when fewer than 2
days of history exist for that agent.

### Dashboard tab

`agent/public/index.html` changes:

- New tab button inserted after **History**:
  `<button class="tab" data-tab="costs" onclick="switchTab('costs')">Costs</button>`
- New tab body: `<div id="tab-costs" class="tab-content">...</div>` matching
  the existing tab-content pattern.
- New render JS: on tab activate, fetch `/api/v1/costs?days=7` and render
  the agent-row table per the approved Layout A mockup (saved at
  `.superpowers/brainstorm/1014-1779997168/content/costs-tab.html` during
  brainstorming).
- Sparkline rendered with Unicode block characters
  (`▁▂▃▄▅▆▇█`) — no chart library dependency.
- Click on an agent row toggles a phase-breakdown panel using the
  `phasesToday` data already in the response.
- A `Last 7d | 30d | 90d` button group at the top re-fetches with the
  selected window.
- Empty-data state (day 0 of fresh deploy or all-zero days in window):
  renders "No cost data yet — collecting from now forward" instead of an
  empty table.
- Tracking-disabled state (endpoint returns 404 because
  `COST_TRACKING_ENABLED=false`): renders "Cost tracking is disabled — set
  `COST_TRACKING_ENABLED=true` and restart to enable" message in the tab
  body. Tab itself is always visible — no client-side feature-flag query
  needed, no change to the static tabs in `index.html`.
- Endpoint failure (non-404 error): small "Cost data unavailable" banner
  with Retry button.

### Skill CLI — `scripts/cost-report.mjs`

```bash
node scripts/cost-report.mjs --days 30
node scripts/cost-report.mjs --days 7 --agent default
node scripts/cost-report.mjs --days 30 --format markdown   # alternative to json
```

- Imports `agent/cost-store.js` directly. No HTTP dependency — runs even if
  the dashboard server is down.
- Default `--format json`; `--format markdown` emits the same table as the
  daily report writer (shared helper).
- Skills (`review-performance`, `adapt-strategy`, `postmortem`,
  `review-performance-penny`, `postmortem-penny`) shell out to this when
  they want cost context. Updating those skill files to actually consume
  this is out of scope for this PR — the CLI is shipped here; skill
  integrations come as small follow-ups.

### Daily report — `analysis-scheduler.js` post-close hook

Fires once per ET trading day at ~16:30 ET (after `market_close` phase
ends). Writes `data/reports/cost_{YYYY-MM-DD}.md`.

Report structure:

```markdown
# Daily Cost Report — 2026-05-28

## Per-agent totals
| Agent     | Today | 7d avg | Δ    | Beats |
|-----------|-------|--------|------|-------|
| Prophet   | $3.18 | $4.21  | −24% | 95    |
| Spark     | $1.42 | $1.38  | +3%  | 187   |
| Harvest   | $0.21 | $0.19  | +11% | 18    |
| Coil      | $0.04 | $0.05  | −20% | 1     |
| Turtle    | $0.03 | $0.03  | 0%   | 1     |
| Drift     | $0.05 | $0.05  | 0%   | 1     |
| **TOTAL** | $4.93 | $5.91  | −17% | 303   |

## Notable shifts (|Δ| ≥ 15% vs 7-day avg)
- Prophet pre_market: −38% (regime-skill cost reduction?)
- Prophet midday: −28%
- Harvest: +11% — below threshold but worth a glance

## Per-phase × per-agent breakdown
(full table)
```

The "Notable shifts" section is auto-generated from any
`(agent × phase)` cell with `|delta| ≥ NOTABLE_SHIFT_PCT`. Threshold lives
in code as a constant, defaults to `15`. The parenthetical "(regime-skill
cost reduction?)" hint is *not* auto-generated — only the agent/phase/delta
line is. The example above is illustrative.

Report is written even if some agents have zero beats that day; absent
agents appear as zero rows so day-over-day comparison is consistent.

## Error handling

| Failure mode | Behavior |
|---|---|
| `recordBeat` write fails (disk full, permission, race) | Soft-fail. Emit `agent_log` warn line `cost-store write failed: <msg>`. Beat continues. |
| `readDay` finds missing file | Returns `null`. `readRange` skips that date (no empty entry). |
| `readDay` finds corrupt JSON | Returns `null`. Emits warn exactly once per file per process lifetime (de-duplicated via a Set). Surrounding days render normally. |
| `readDay` finds `schemaVersion > 1` | Returns `null` + warn (forward-compat: future migration path lives in `readDay`). |
| opencode emits malformed `step_finish` | Already handled by `extractTokenDelta`'s defensive `Number()` coercion (non-finite → 0). No new code. |
| HTTP endpoint throws | Dashboard tab shows "Cost data unavailable" banner with Retry button. |
| Empty data state (day 0–6) | Dashboard shows explanatory placeholder; report writer still writes the file with zero rows. |

Soft-fail policy matches the existing `architectural-patterns` discipline:
observability features never block the trading loop, and degraded reads
never mask the working ones.

## Testing

Following the operator's node:test preference for JS.

### `agent/cost-store.test.mjs` — pure unit + I/O

- `_etDate`: UTC midnight → ET previous day; DST boundary cases.
- `aggregateByAgent`: empty input; single day; multi-day; sandboxId filter;
  agentId filter; phase rows preserved across days.
- `recordBeat`:
  - First write creates directory + file.
  - Second beat upserts existing row (cost+tokens+beatCount accumulate;
    `firstBeatAt` preserved, `lastBeatAt` advances).
  - Second sandbox same-day adds a new row, does not collide.
  - Phase rows independent: same sandbox, different phase = separate rows.
  - Same-day write across midnight-ET boundary lands in the new day's file.
- `readDay`:
  - Missing file returns `null`.
  - Corrupt JSON returns `null` + warn logged exactly once.
  - Unknown `schemaVersion` returns `null` + warn.
- `readRange`: filters; date ordering; missing days produce no entries.
- Atomic-write: simulate temp-write failure (mocked `fs.rename` throws)
  and assert the existing real file is unchanged.

### Integration

- Harness wiring: mock `cost-store`, assert `recordBeat` is called with the
  expected shape after a beat with `totalCost > 0` or `tokenTotal > 0`; NOT
  called when both are zero.
- HTTP endpoint: seed fixture cost files, hit `/api/v1/costs?days=7`,
  assert shape + delta math + sparkline length.
- Daily report writer: feed fixture rollup → snapshot the markdown output
  (catches accidental format drift).
- Skill CLI: invoke `scripts/cost-report.mjs --days 7` against fixture data,
  assert stdout shape.

Skipping: e2e through the live opencode stream. Indirectly covered by the
harness wiring test; not worth the flake.

## Rollout

**Default ON.** Matches the pattern used by other data-only observability
features (silent-fill summary, failed-trade indicator, trade
reconciliation). No trading behavior change here, so observe-then-enable is
not warranted.

**Env var:** `COST_TRACKING_ENABLED=true|false`, default `true`. When
`false`:
- `recordBeat` is skipped in the harness wrapper (no write path firing).
- `GET /api/v1/costs` returns 404.
- Dashboard tab is still visible; body shows the "Cost tracking is
  disabled" message described above. No static HTML changes when toggling
  the flag.
- Daily report writer is skipped in `analysis-scheduler.js`.
- Skill CLI still runs (reads whatever historical data exists) — does not
  consult the flag.

**Deployment:** single squashed commit per workflow preference, on branch
`cost-tracking-per-agent-per-day`, PR to
`NeverLucky2/ClaudeProphetAndFriends`.

**Live verification step** (after merge to local main + restart):
1. Run for one full ET trading day across all six sandboxes.
2. Confirm `data/sandboxes/{accountId}/costs/{today}.json` populates.
3. Open the dashboard, click the Costs tab, confirm Layout A renders with
   real values.
4. After ~16:30 ET, confirm `data/reports/cost_{today}.md` was written.
5. After 7 full days of data, the delta column should show real numbers
   instead of "—". Spot-check that the deltas are plausible vs the raw
   per-day cells in the dashboard sparkline.

**Migration / data deletion:** to clear, `rm -rf data/sandboxes/*/costs/`.
No DB to drop, no schema migration to run. Future schema bumps will add a
migration path inside `readDay`.

## Cross-cutting considerations

- **Token cost of the feature itself.** This feature does not invoke the
  LLM. The only runtime cost is one JSON read + one JSON write per beat
  (file < 10 KB), well below noise floor.
- **Disk footprint.** Roughly 6 agents × 5 phases × ~120 bytes/row × 365
  days = ~1.3 MB/year per account. Trivial.
- **No new dependencies.** Uses `fs/promises`, `path`, `node:test` — all
  already in use elsewhere in `agent/`.
- **Plays well with existing observability.** Does not change the
  `agent_log` SSE stream, does not change the trades feed, does not touch
  the activity log writer. Strictly additive.
