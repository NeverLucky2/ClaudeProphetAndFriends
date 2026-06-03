---
name: trade-grader
description: Enrich Prophet's per-trade grades with a thesis-vs-outcome read (catalyst/timing played out?), batched over one ET day's closed trades. Reads the deterministic cards.json the scheduler already wrote; never re-derives outcomes; never invents data the card lacks.
allowed-tools: Read Glob Write
---

You grade Prophet's CLOSED trades for one ET day on whether the entry THESIS played out —
separate from whether the trade made money. Process over outcome.

## Step 1 — Load the prepared cards

The scheduler has already run `scripts/trade-grades.mjs --date <DATE>`. For every Prophet
sandbox (agent id `default`), read `data/trade-grades/<sandboxId>/<DATE>.cards.json`. Each
file has `grades[]`; the Prophet entries carry `candidateTheses[]` (decisive_actions with
`reasoning`). Only grade entries where `agentId === 'default'`. If no such file or no Prophet
grades, output "No Prophet trades to grade for <DATE>." and STOP (write nothing).

## Step 2 — For each Prophet trade, judge the thesis

Using the trade's `candidateTheses` reasoning (the entry thesis) and the outcome card
(`exitReason`, `frictionPnl`, `holdMinutes`, entry/exit price), decide:

- `catalyst`: `played | partial | failed` — did the named catalyst in the thesis actually
  materialize, judged against the price move + exit reason? If the thesis names no catalyst,
  use `not_assessed`.
- `timing`: `played | partial | failed` — did it resolve within the window the thesis implied
  (use `holdMinutes` vs any stated horizon)? If none stated, `not_assessed`.
- `iv`: **`not_assessed`** unless the card carries explicit entry AND exit IV (it does not
  today). NEVER invent an IV verdict. Do not infer IV from P&L.
- Keep the deterministic `thesisPlayedOut`/`quadrant` from the card UNLESS the narrative
  clearly contradicts it; if you change it, it must stay one of the 8 spec quadrants
  (`earned_win, lucky, unlucky, clean_miss, partial_win, partial_loss, inconclusive_win,
  inconclusive_loss`) and you must say why in the lesson.
- `lesson`: one sentence, specific to this trade, process-focused.

## Step 3 — Write the enriched report

For each Prophet sandbox, overwrite `data/trade-grades/<sandboxId>/<DATE>.json` with the same
shape the deterministic report had, but each Prophet grade now also has
`{ catalyst, timing, iv, lesson }` (mechanical agents' grades pass through unchanged). Also
overwrite `<DATE>.md` re-rendering the same lines plus, for Prophet trades, a sub-line
`catalyst=<>, timing=<>, iv=<>`.

Report-only. Never edit rules, never place orders, never touch any file outside
`data/trade-grades/`.
