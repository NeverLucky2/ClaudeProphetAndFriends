# Runbook — funding live Coil

**Spec:** `docs/superpowers/specs/2026-07-13-coil-live-funding-design.md`
**Plan:** `docs/superpowers/plans/2026-07-13-coil-live-funding.md`

Account creation and funding are deliberately **operator actions** — real
credentials, real dollars, not automated. This runbook is the gate. If any
"Do not start until" or "STOP" box below isn't checked, don't fund.

---

## Do not start until all of these are true

- [ ] Tasks 1–5 are merged to **local main** (the deploy source — an unpushed
      side branch is stranded and will not be in the rebuilt binary).
- [ ] On local main: `go build ./...` succeeds, `go test ./...` is green,
      `npm test` is green.
- [ ] The Go bot binary has been **rebuilt** from local main
      (`go build -o prophet_bot.exe ./cmd/bot` or your usual build step,
      then the orchestrator respawns it). The halt lives in the Go binary —
      an un-rebuilt bot has no halt no matter what the `.env` says.

Do not gate funding on anything already done — Tasks 1–5 (account-mode
fail-closed, the halt guard itself, strategy registration, reconciliation
scaffolding, Foundation B) are merged and covered by the test suite above.
The only remaining gate is the rebuild + the live verification steps below.

---

## The halt, in one paragraph

`CoilLiveHaltGuard` (`services/coil_live_halt_guard.go`) is **the only
code-enforced rail bounding real-money loss** on live Coil. Everything else
(6%/12% per name, position count, 85% deploy) is prose in a markdown file
the LLM is trusted to self-police — fine on paper, not fine here. The halt
blocks **new entries** once equity falls `COIL_LIVE_DRAWDOWN_PCT` below its
high-water mark; open positions keep being managed and exited. It **fails
closed** on every uncertainty it can't resolve — see the table below.

### Env flags (`config/config.go`)

| Flag | Default | Meaning |
|---|---|---|
| `ENABLE_COIL_LIVE_HALT` | `false` | Arms the guard. |
| `COIL_LIVE_DRAWDOWN_PCT` | `0.15` | Halt fires at −15% from the high-water mark. |
| `COIL_LIVE_BASELINE_USD` | `0` | Funded baseline; floors the high-water mark. **`<=0` while enabled fails closed — blocks every entry.** |
| `COIL_LIVE_STATE_DIR` | unset → `filepath.Dir(DATABASE_PATH)` | Where the latch/kill/high-water files live. Per sandbox this defaults to that sandbox's own runtime dir, so state files don't collide across bots. |

**Fails closed** means: `ENABLE_COIL_LIVE_HALT=true` with `COIL_LIVE_BASELINE_USD`
unset or `<=0` blocks **every** entry, forever, with no drawdown having
occurred at all. If you enable the halt and forget the baseline, Coil simply
never buys anything — that is the guard working correctly, not a bug.

### `ENABLE_COIL_LIVE_HALT` is sandbox-scoped

Like `TURTLE_SCHEDULER_ENABLED` / `ENABLE_PROPHET_DEFENSIVE`,
`agent/orchestrator.js` gates `ENABLE_COIL_LIVE_HALT` by `strategyId` before
spawning each sandbox's Go bot (`agent/coil-halt-flags.js`, unit-tested in
`agent/coil-halt-flags.test.mjs`). `startGoBackend()` still builds each
spawned bot's env as `{ ...process.env, ... }`, but `ENABLE_COIL_LIVE_HALT`
is set explicitly afterward: only the bot whose resolved `strategyId` is
`COIL_LIVE_STRATEGY_ID` (`mean-rev-rsi2-live`) receives the operator's own
`.env` value; **every other bot — Prophet, Turtle, Drift, paper Coil —
receives a hard `'false'`**, regardless of what the shared root `.env` says.
Setting `ENABLE_COIL_LIVE_HALT=true` in the shared `.env` now arms
`CoilLiveHaltGuard` **only** in the live-Coil sandbox's Go bot process; it
cannot leak into any other bot.

`COIL_LIVE_DRAWDOWN_PCT` and `COIL_LIVE_BASELINE_USD` still ride through via
the `...process.env` spread for every bot, same as before — this is
intentionally left alone because they're inert whenever
`ENABLE_COIL_LIVE_HALT` is `'false'` (`CoilLiveHaltGuard` never activates,
so the values are never read). `COIL_LIVE_STATE_DIR` likewise rides through
unscoped and defaults to each sandbox's own `DATABASE_PATH` directory when
unset, so state files still can't collide across bots even without explicit
scoping.

Practical upshot for the verification step below: **check the LIVE Coil
sandbox's own Go console specifically** — the ARMED line will now appear
there and nowhere else, but the check is still worth doing explicitly rather
than assuming.

---

## 1. Create the live Alpaca account

Real Alpaca account, **margin, zero leverage**. Margin is for T+1 settlement
relief only — Coil rotates capital every ~4.5 days and a cash account would
rack up good-faith violations (3 in 12 months → 90-day restriction). **Coil
never borrows.** Holds are ~4.5 days, so it never day-trades and the
sub-$25k PDT rule does not bind.

## 2. Add the account in the dashboard

- Base URL **must** be `https://api.alpaca.markets` and the paper toggle
  **must** be off. `agent/config-store.js`'s `resolveAccountMode()` now
  throws on a contradiction:
  ```
  Account mode mismatch: paper=<bool> but baseUrl <url> is <PAPER|LIVE>.
  Refusing to save an account whose label contradicts its endpoint.
  ```
  If you see this, the guard is working — fix the form, don't fight it.
  `updateAccount` resolves `baseUrl` and `paper` **together**, so this also
  fires if you flip just the paper toggle by hand without also correcting
  the URL (the dashboard sends both, so this mostly only bites manual JSON
  edits).
- The Go bot has its own independent version of this same check
  (`services/alpaca_trading.go`): if `ALPACA_PAPER` disagrees with
  `ALPACA_BASE_URL` at boot, it refuses to start with
  `alpaca: mode mismatch — ALPACA_PAPER=<bool> but base URL "<url>" is
  <PAPER|LIVE>; refusing to start`, logged as `FATAL: Alpaca trading
  service refused to start`. Two independent fail-closed checks, dashboard
  and Go — both must agree before this account trades anything.
- Credentials land in `data/accounts-secrets.json` (gitignored). **Never
  commit them.**

## 3. Create the sandbox

- **`createSandboxForAccount()` generates a random `sbx_<uuid8>` id — it
  does not honor a chosen name.** The readable `sbx_mean_rev` id you see
  today was hand-set directly in `data/agent-config.json`, not produced by
  the creation flow. To get a readable `sbx_mean_rev_live`:
  1. Create the sandbox normally via the dashboard (it will get a random id).
  2. Stop the server.
  3. Rename the sandbox's key (and its `id` field) in `data/agent-config.json`
     by hand.
  4. Restart.
  A random id works fine functionally — the readable one is a pure
  convenience, not a requirement.
- Bind the live rules with the **sandbox-level override**, not by changing
  the shared `mean-rev` agent's default (`agent/config-store.js` around
  line 1224, in `getResolvedAgentForSandbox`):
  ```
  agent.overrides.strategyId: mean-rev-rsi2-live
  ```
  This resolves ahead of the base agent's own `strategyId`, so the live
  sandbox's bot loads `TRADING_RULES_MEANREV_LIVE.md` while every other
  `mean-rev` sandbox (paper) is untouched. `mean-rev-rsi2-live` is already
  registered globally in `config-store.js` (`COIL_LIVE_STRATEGY_ID` from
  `agent/coil-strategy-ids.js`) — you're pointing at an existing strategy
  entry, not inventing one.
- Set in the shared root `.env` (see above — `ENABLE_COIL_LIVE_HALT` is
  sandbox-scoped by `agent/coil-halt-flags.js`, so this only arms the halt
  in the live-Coil sandbox's bot):
  ```
  ENABLE_COIL_LIVE_HALT=true
  COIL_LIVE_BASELINE_USD=5000
  ```
- Retire the paper `sbx_mean_rev` sandbox once live is confirmed working.
  It is currently flat, so shutdown strands nothing.

### Confirm the live rules actually loaded — do not skip this

`resolveStrategyRules` (`scripts/strategy-version.mjs:20-43`) **fails OPEN**
on a bad `rulesFile`: a missing or misspelled filename logs a `console.error`
warning and silently falls through to the *global* `TRADING_RULES.md`. It
does not throw. A typo here means live Coil trades real money under
Prophet's generic rules — 12% sizing, the 85% deploy ceiling, the bear-mode
halt, none of it would apply, and nothing would tell you.

Check the **first beat's system prompt** (dashboard → live sandbox → the
beat's rendered prompt, or the raw activity log) contains:
- The header block starting `> **LIVE — REAL MONEY.**`
- The sizing line `position_dollars = portfolio_value × 0.12`

If either is missing, stop. Fix `strategy.rulesFile` for
`mean-rev-rsi2-live` (should be exactly `TRADING_RULES_MEANREV_LIVE.md`),
restart the sandbox, and re-check before letting it place a single order.

## 4. Verify the halt is actually armed BEFORE funding

Start the live sandbox's bot and read **its own** Go console in the
dashboard (or its stdout, tagged `[go:<port>]` in the orchestrator log). The
ARMED line will appear only for the live-Coil sandbox — confirm it
specifically for this sandbox anyway rather than assuming. You are looking
for exactly these two lines, in this order:

```
level=warning msg="Alpaca trading mode resolved" alpaca_base_url=https://api.alpaca.markets alpaca_mode="LIVE — REAL MONEY"
level=warning msg="Coil live drawdown halt ARMED" baseline_usd=5000 coil_live_halt_enabled=true drawdown_pct=0.15 state_dir=<path>
```

(logrus's default `TextFormatter` sorts fields alphabetically — the exact
order shown above — but treat the field names and values as the
authoritative part; don't fail the check over formatting alone.)

- If `alpaca_mode` is not `"LIVE — REAL MONEY"`, the account is still
  wired as paper. Stop — go back to step 2.
- **If the "Coil live drawdown halt ARMED" line is absent, the halt is not
  running. Do not fund.** Absence means one of: `ENABLE_COIL_LIVE_HALT` is
  not `true` in this process's env, or the bot did not rebuild from a
  commit that has the halt in it (check `git log` on local main for
  Tasks 1–5, and confirm the binary's build timestamp is newer than that
  merge).
- If instead the bot **refused to boot** with `Coil live drawdown halt:
  COIL_LIVE_STATE_DIR "<dir>" is not usable (fail closed at startup rather
  than booting into stale drawdown state)`, that's the arm-time write
  probe (`CoilStateDirWritable`) catching an unwritable/missing state dir.
  Fix the directory (see the state-files section below) before retrying —
  don't work around it.

### Prove it blocks — don't assume it

A log line is not proof. Prove the guard actually refuses an order:

1. In the live sandbox's state dir (the `state_dir` value from the ARMED
   log line — normally that sandbox's own runtime dir, next to
   `prophet_trader.db`), create an empty file named exactly:
   ```
   KILL_COIL_LIVE
   ```
2. Wait for (or manually trigger) the next entry attempt. It must be
   refused with:
   ```
   coil live halt: manual kill switch engaged
   ```
   If instead an order goes through, **the halt is not wired into this
   bot's TradeGuard — do not fund. This is a hard stop.** Go back to the
   rebuild step; something is stale.
3. Delete `KILL_COIL_LIVE` once you've confirmed the block. Leaving it in
   place blocks all future entries too — that's expected, but don't forget
   it's there.

## 5. Fund $5k

At 12%/name this yields ~$600 positions — the same notional the 26-trade
paper record was generated at, with half the dollars exposed and $5k held
outside the broker entirely.

### Practical sizing fact — read before funding

Sizing is `shares = floor(position_dollars / last_close)`, with
`position_dollars ≈ $5,000 × 0.12 = $600`. That floor means:
- Any S&P name priced **above $600/share is effectively unenterable** — 0
  shares, skipped.
- "12% equal-weight" is **not actually equal-weight** at this size for
  pricier names. Example: a $310 stock → `floor(600/310) = 1` share =
  $310 = **6.2%** of the account, not 12%. The higher the price, the
  further the realized weight falls below the target — this is a real,
  expected distortion at $5k, not a bug. It self-corrects at the $10k ramp
  (12% of $10k = $1,200, so the same $310 stock buys `floor(1200/310) = 3`
  shares ≈ 9.3%, much closer to target).
- **This is a fidelity caveat, not a safety one — it errs toward less risk
  (skipped entries), never more.** But it does mean the live sample is drawn
  from a cheaper-name subset of the universe than the record it exists to
  validate: **COST (~$1,005/share) — the single fat winner in the 26-trade
  paper record — cannot be traded at all at the $5k stage.** Read the full
  note in `TRADING_RULES_MEANREV_LIVE.md`'s Position Sizing section before
  interpreting early live results against the paper baseline. Do not change
  the sizing rule to compensate — this self-corrects at $10k.

### Bounded worst case

≈ **−$750** at the −15% halt threshold; ≈ **−$1,200** accounting for gap
overshoot past the threshold before the halt can act (it checks at entry
time, not intraday — a position already open when a gap happens is managed
by its own −7% stop and 5-day timeout, not by this halt, since the halt
only ever blocks *new* entries).

## 6. Stop the Merrill hand-mirror

Running the bot and the hand-mirror together takes the same signal twice
with real money — it doubles exposure and makes both books unmeasurable.
Give each open Merrill mirror position a deliberate exit decision under the
existing rule: judgment on winners, mechanics on losers; discretion never
overrides a stop.

---

## The state files are load-bearing

Three files live in the halt's state dir
(`services/coil_live_halt_guard.go:20-24`):

| File | What it is | Rule |
|---|---|---|
| `coil_live_highwater.json` | The persisted peak equity (high-water mark). Ratchets up on every new high; read on every entry check. | **Never delete.** |
| `coil_live_halt.json` | The **latch**. Presence blocks every new entry. | Delete deliberately, and *only this file*, to re-arm after a reviewed trip. |
| `KILL_COIL_LIVE` | Manual kill switch — an independent override, same effect as the latch. | Create to force-block; delete to release. |

### Never delete `coil_live_highwater.json`

Deleting it does not "reset" anything safely — it destroys the guard's
memory of the true peak. On the next check, `effectiveHighWater` becomes
`max(baseline, persisted, hwmMem, equity)`; with the file gone and no
in-process memory (e.g. after a restart), that collapses to
`max(baseline, equity)`. If equity is currently *below* the true peak — the
normal case in any drawdown worth caring about — the mark silently drops to
current equity (or the baseline, whichever is higher), and the halt now
measures drawdown from a **lower, wrong peak**. It will fire late, or not
at all, on the loss that's already happened. The baseline floor bounds how
far the mark can fall (it can never go below `COIL_LIVE_BASELINE_USD`), but
that **bounds the damage — it does not eliminate it.** A true peak well
above the baseline (the normal case) still gets lost.

### `coil_live_halt.json` is the latch — re-arm is deliberate, by design

Its presence is the entire reason new entries stay blocked after a trip.
There is **no programmatic re-arm** — that's intentional (see "When the
halt trips" below). Re-arming is: delete `coil_live_halt.json`, and nothing
else. Never touch `coil_live_highwater.json` as part of re-arming.

### The bot refuses to boot on a bad state dir — that's intentional

`CoilStateDirWritable` runs at arm time (`cmd/bot/main.go`, before the
guard is even constructed): if the state dir is missing, not a directory,
or statable-but-unwritable (full disk, read-only remount, ACL change), the
bot calls `logger.Fatalf` and does not start. This is deliberate — better a
bot that won't boot than one that boots and can't durably record a future
halt.

### ⚠️ The one procedure that can silently reopen the hole

If the disk fills or the state dir goes read-only *while the bot is
running*, `CoilLiveHaltGuard` sets `persistDegraded` and blocks **all**
entries with:

```
coil live halt: cannot persist halt state — failing closed (a prior write
to StateDir failed; fix StateDir, RECONCILE THE HIGH-WATER MARK against the
account's true peak, then restart the process to clear this)
```

Walk through what happens next carefully:

1. **Operator restarts without fixing the disk.** The new process boots,
   `CoilStateDirWritable`'s arm-time probe fails on the still-broken dir,
   and the bot **refuses to boot.** Good — safe, loud, obvious.
2. **Operator fixes the disk, then restarts.** The arm-time probe now
   passes, the bot boots cleanly, and `CoilLiveHaltGuard` starts fresh:
   `persistDegraded=false`, `hwmMem=0` (in-memory state does not survive a
   restart). It reads whatever was **last successfully written** to
   `coil_live_highwater.json` — which is **stale**, because the mark
   stopped ratcheting the moment the disk fault began. If equity kept
   rising in the interim (or even just held steady while the true peak was
   higher before the fault), the guard is now measuring drawdown against a
   **lower-than-true peak**. A real −15% drawdown from the true peak could
   read as a smaller, non-blocking number computed from the stale mark —
   the guard would silently allow an entry it should have blocked.

**This cannot be closed in code.** You cannot durably record "I can't
write" on a disk that is, by definition, refusing writes — there is no file
the guard can leave itself that says "when you come back, know that you
missed some peak." The fix is a procedure the operator owns:

> **Before restarting after a disk/StateDir fault, manually reconcile
> `coil_live_highwater.json`'s `high_water_usd` against the account's true
> peak equity for the period the fault was active** (check Alpaca's own
> equity history / statements, not the bot's own stale record). Edit the
> file by hand if needed, matching the existing shape:
> ```json
> { "high_water_usd": <true peak>, "updated_at": "<ISO timestamp>" }
> ```
> Only then restart. Restarting onto a fixed disk without doing this
> silently reopens the exact hole `CoilStateDirWritable` exists to close.

## When the halt trips

1. `coil_live_halt.json` appears in the state dir. New entries are
   refused. **Open positions keep being managed and exited — this is by
   design**, not a gap. The halt is an entry veto, consulted only from
   `TradeGuard.CheckBuy`; exits never route through it.
2. **Do a post-mortem before re-arming.** The halt firing is the tail this
   whole stage exists to observe — it is data, not just an incident. Don't
   rush past it to get back to trading.
3. Re-arm by deleting `coil_live_halt.json` — nothing else, no
   programmatic path, on purpose.

---

## ACCEPTED RISK: reconciliation does not cover the stuck-exit path

**This is a known, deliberate gap, not an oversight — read this section
before funding, and follow the daily mitigation checklist below for as long
as the gap is open.**

`agent/trade-reconciliation.js` runs per-sandbox; the live sandbox gets its
own `data/reconciliation/<sandboxId>/` directory automatically, no wiring
required. But its own `SCOPE_NOTE`, stamped on every report (verbatim,
`agent/trade-reconciliation.js:135`):

> "Covers order placements (opens/adds). Does NOT verify closes/exits or
> live position state — a logged-success close that did not execute will
> not be caught here."

**What reconciliation verifies:** order PLACEMENTS — opens and adds. **What
it does NOT verify:** closes/exits, or live position state generally.

**Concrete failure this leaves open:** `CloseManagedPosition` cancels the
−7% broker-side stop as part of closing out a position, the sell order
itself then silently fails, and the bot marks the position CLOSED anyway.
The result is a **real-money long with no stop and no manager** — the bot
believes it is flat, the broker still holds the position, and nothing is
watching it. A logged-success close that never actually executed at the
broker is **exactly** this failure mode, and the existing reconciliation
**does not detect it.** A clean reconciliation report tells you entries
matched the broker. It says nothing about whether a position you believe is
closed actually is.

**The −15% drawdown halt does NOT help here.** The halt is an entry veto —
it blocks *new* entries once equity falls 15% below its high-water mark. It
is never consulted on a sell, and a stranded position (stopless, unmanaged)
is not a new entry. This specific failure mode is entirely outside what the
halt was built to catch.

**Why this is accepted, not blocking, at this stage:** the live-funding
design spec (`docs/superpowers/specs/2026-07-13-coil-live-funding-design.md`)
names stuck-exit / failed-close detection **"the operator's primary
objection to Alpaca, and the one risk that is actually engineerable,"** and
lists **"the stuck-exit path is proven to work"** as one of three explicit
success criteria for this stage — alongside positive live expectancy and an
observed drawdown-halt trip. In other words: this stage exists partly to
*exercise* this exact gap under real conditions, not to have already closed
it. It is bounded by size: at $5k, a single stranded 12% position is ≈ a few
hundred dollars — survivable, not catastrophic. **It IS a blocker for
scaling to $10k** — extending reconciliation to compare the bot's believed
closes against live broker position state is real, unstarted work, and is
the top follow-up before any raise past $5k. Do not read a green
reconciliation report as "exits are verified" — it verifies entries only.

**Required mitigation until this is built:** a daily manual eyeball of the
Alpaca positions page against the bot's open positions (see the Daily
Operations Checklist below). This is not optional busywork — it is the only
thing standing between a silently stranded position and it staying
stranded, unmanaged, and un-stopped for days.

---

## Daily Operations Checklist (while the stuck-exit gap is open)

Run this every trading day the live account is funded, until reconciliation
is extended to cover closes (see the ACCEPTED RISK section above). This is
the load-bearing mitigation for that gap, not a nice-to-have — skipping it
means a silently stranded position could sit stopless and unmanaged for
days before anyone notices.

- [ ] **Open the Alpaca dashboard's live positions page directly** (not the
      bot's dashboard, not the sandbox activity log — the broker's own
      record of what it actually holds).
- [ ] **Open the bot's own view of its live-Coil positions** (dashboard →
      live sandbox → open positions, or `get_managed_positions` /
      `get_positions` against the live account).
- [ ] **Compare symbol-by-symbol.** Every symbol the bot believes it holds
      must appear, at the same side and a consistent quantity, in the
      broker's own list — and vice versa (a broker position the bot doesn't
      know about is just as much a problem as one it wrongly closed).
- [ ] **Any mismatch — broker holds something the bot thinks is closed, or
      the bot holds something the broker doesn't — is exactly the failure
      reconciliation cannot catch.** Treat it as the reconciliation rule's
      own "reconciliation mismatch — operator review required" hard stop:
      stop trusting the bot's position state for that symbol, and resolve it
      by hand (manually place the missing stop, or manually close the
      orphaned broker position) before the next scheduled 15:45 ET beat.
- [ ] Note the check (clean or not) somewhere durable — even a one-line log
      — so a gap in the daily habit itself is visible in hindsight.

---

## Scale to $10k

When Coil reaches **~50 total trades OR survives a genuine drawdown**,
whichever comes first. At the same time, raise:

```
COIL_LIVE_BASELINE_USD=10000
```

This isn't cosmetic — the baseline is one of the terms in
`effectiveHighWater`'s `max(...)`, so it floors the high-water mark. Leaving
it at 5000 after funding $10k means a future lost/corrupted state file
would floor the mark $5,000 lower than it should, understating a real
drawdown. Raise it in lockstep with the actual funded amount, not after.

## What success is

**Not "it made money."** In this regime it is *expected* to make money.
Success is:
- the live trade ledger shows **positive expectancy on its own**
  (long-term holds excluded),
- the **stuck-exit path is proven to work** (not just assumed, given the
  reconciliation gap above),
- and the drawdown behavior is finally **observed**, not assumed — this
  stage exists to watch the halt actually fire at least once under real
  conditions, not to avoid ever seeing it fire.
