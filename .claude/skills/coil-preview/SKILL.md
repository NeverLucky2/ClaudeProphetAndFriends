---
name: coil-preview
description: Pre-close scouting report for the Coil mean-reversion agent. Run a few hours before Coil's 15:45 ET beat to see which large-caps it is likely to buy (FIRING) and which are near (WATCH), with mirror-trade details, so the operator can prepare to mirror Coil's entries in a personal account. Read-only; requires the Go bot running. Use when asked to preview Coil's trades, "what is Coil about to buy", a Coil scouting list/watchlist, or before mirroring Coil in a real brokerage account.
---

# Coil Preview

Read-only advance preview of the Coil agent's likely end-of-day entries, so the
operator can prepare to mirror them manually. Coil itself fires once per trading
day at 15:45 ET; this surfaces its scouting list a few hours early.

## How to run

From the project root:

```
node scripts/coil-preview.mjs
```

The script calls Coil's own HTTP endpoints (`/api/v1/meanrev/universe`,
`/api/v1/meanrev/candidates`, `/api/v1/meanrev/signal/:symbol`) on the running Go
bot (default `http://localhost:4534`; override with `TRADING_BOT_URL`), so the
numbers are byte-for-byte what Coil computes. It prints a ready-to-read markdown
report and writes a JSON copy to `data/coil-preview/<ET-date>.json`.

## Presenting the result

Show the script's markdown output to the operator as-is. It already contains:

- the provisional-read caveat header (names drift before 15:45),
- the SPY bear-regime banner (and a HALT notice when Coil will not enter today),
- the FIRING bucket (likely buys) and the WATCH bucket (near-misses), each with
  per-name margins and a mirror block (entry reference, fill-relative stop rule,
  and the three exit triggers),
- a loud INCOMPLETE warning if any universe name failed to fetch.

If the script exits non-zero with "Coil bot not reachable", tell the operator the
Go bot must be running to preview Coil — and that if it is down, Coil is not
trading, so there is nothing to mirror.

Do not re-derive or second-guess the numbers; they are Coil's own computation. Do
not place any orders — this is a read-only prep tool. The operator executes in
their own brokerage, sizing to their own account, and sets the stop at their
actual fill (× 0.93), not at the provisional preview price.
