---
name: vertical
description: Use when the operator wants to manually drive Prophet's teaching debit verticals — propose, place, list, or close a call-debit / put-debit spread by hand, or asks "what would a QQQ call spread look like", "show me a debit vertical", "is this spread cheap or rich", or wants the cheap/fair/rich entry read (vol skew + IV-to-RV) on a candidate spread. The operator's hand-equivalent of Prophet's four debit_vertical MCP tools. Requires the Go bot running with ENABLE_PROPHET_DEBIT_VERTICALS=true.
---

# Vertical

Operator slash-command for Prophet's defined-risk **debit verticals** (a teaching
feature). It is the by-hand equivalent of the four `*_debit_vertical` MCP tools
Prophet's LLM uses — calling the **same** Go endpoints, so every number,
including the cheap/fair/rich entry read, is byte-for-byte what Prophet sees.

(The four tools and `coil_preview` are LLM/operator helpers, not Claude Code
slash-commands; this skill is the one that surfaces verticals as `/vertical`.)

## How to run

From the project root:

```
node scripts/vertical.mjs propose <UNDERLYING> <call|put> [--exp YYYY-MM-DD] [--width N]
node scripts/vertical.mjs place <PROPOSAL_ID>
node scripts/vertical.mjs list
node scripts/vertical.mjs close <VERTICAL_ID>
```

Defaults: `--exp` = next monthly opex (3rd Friday, ≥10 DTE), `--width` = 5.
`call`/`put` accept aliases (`c`/`p`/`call_debit`/`bull`/…).

**Safety:** `propose` and `list` are read-only (propose creates an in-memory
proposal, no order). `place` and `close` submit real **paper** orders — confirm
the operator intends it before running them.

## Reaching the bot

The script targets `http://localhost:4534` (or `TRADING_BOT_URL` /
`TRADING_BOT_PORT`). If it prints **"bot not reachable"**, the live bot is on
another port — sandbox-scoped bots run on 4536+. Find it and retry:

```
Get-NetTCPConnection -State Listen | ? { $_.LocalPort -ge 4534 -and $_.LocalPort -le 4540 } | Select LocalPort -Unique
$env:TRADING_BOT_PORT='4536'; node scripts/vertical.mjs propose QQQ call
```

Probe a candidate with `GET /api/v1/options/verticals` — a bot returns
`{"verticals":[...]}`; a 403 means `ENABLE_PROPHET_DEBIT_VERTICALS` is off on
that bot.

## Presenting the result

Show the script's markdown output to the operator as-is.

- **propose** prints the entry card: structure (long/short strikes + OCC
  symbols), economics (net debit, max loss, max profit, breakeven), per-leg IV,
  and the **Entry read** — the cheapness label plus skew (shortIV − longIV) and
  IV / 20d RV. Then it shows the exact `place <PROPOSAL_ID>` command.
- **list** prints open verticals with live value, DTE, and status.

The cheapness read is **advisory only** — it does not gate placement, and a
proposal re-prices on `place` (a debit that drifts too far cancels). Do not
re-derive or second-guess the numbers; they are the engine's own computation.
Don't place or close anything the operator didn't ask for — `place`/`close`
move real paper money.
