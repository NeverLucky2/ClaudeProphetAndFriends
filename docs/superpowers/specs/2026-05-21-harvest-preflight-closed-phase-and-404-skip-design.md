# Harvest Preflight: Closed-Phase Guard + 404 = Skip

**Date:** 2026-05-21
**Branch:** prophet-options-auto-stop (or new feature branch)
**Status:** Approved

## Problem

`harvestPreflight` in `agent/preflight.js` wastes LLM tokens in two distinct scenarios:

1. **Market closed (overnight / weekend):** With `HARVEST_EXIT_MONITOR_ENABLED=true`, the Go monitor owns exit evaluation out-of-band. During closed-market hours, the LLM can't enter new positions and the monitor handles exits — the LLM beat has nothing to do. Yet the preflight currently falls through to the chain probe and spawns the LLM anyway.

2. **Expirations endpoint returns 404:** `GET /api/v1/harvest/expirations/:symbol` returns HTTP 404 when `GetNextMonthlyExpiration` finds no qualifying monthly contract in the [35, 55] DTE band. The preflight catch block currently treats this 404 the same as a network error (fail open → LLM runs). Semantically a 404 is equivalent to the `!exp` branch (which already returns `skip: true`), so the LLM is spawned unnecessarily.

Observed at 11:55 PM ET with 0 open condors and monitor enabled: preflight fails open on 404, LLM spawns, calls `get_harvest_expirations` for all 5 underlyings, all return 404, ~110–200K tokens burned.

## Approach

Two independent changes to `harvestPreflight` only. Nothing else changes.

### Change 1: Closed-Phase Guard

Inserted after state/fomc validation and the existing open-condors/monitor check, before FOMC/regime/econ/chain checks. Uses the already-exported `isClosedPhase()`.

**Logic:**
- `monitor_enabled === true` + closed phase → `skip: true` regardless of condor count (monitor owns exits; entries impossible)
- `monitor_enabled !== true` + closed phase + `openCondors === 0` → `skip: true` (nothing to manage)
- `monitor_enabled !== true` + closed phase + `openCondors > 0` → `skip: false` (LLM manages exits)

### Change 2: 404 = Skip in Expirations Catch Block

In the `catch (err)` block of the chain probe:

- `err.response?.status === 404` → `skip: true`, reason: `"no qualifying monthly expiration in [35,55] DTE for SPY (404)"`
- All other errors (500, timeout, network failure) → `skip: false` (fail open, unchanged)

## Revised Execution Path

```
state + fomc (parallel fetch)
  → shape validation (fail open on bad shape)
  → open condors + monitor guard (existing)
  → [NEW] closed-phase guard
      monitor_enabled=true  → skip: true (any condor count)
      monitor_enabled=false → skip: true only if openCondors === 0
  → FOMC blackout check
  → regime gate
  → econ blackout
  → deployed_pct cap check
  → chain probe (GET /api/v1/harvest/expirations/SPY)
      200, exp present  → chain call continues
      200, exp missing  → skip: true (existing !exp branch)
      [NEW] 404         → skip: true
      other error       → skip: false (fail open, unchanged)
  → IV–RV gate
  → skip: false ("chain data available")
```

## Error Handling Invariants

- Non-404 errors from the expirations endpoint still fail open.
- Closed-phase guard only fires after the state response is validated; a bad state shape still fails open.
- `PREFLIGHT_TIMEOUT_MS = 2000` race in `resolvePreflight` is unchanged.

## Files Changed

- `agent/preflight.js` — `harvestPreflight` function only
- `agent/preflight.test.mjs` — new test groups for closed-phase guard and 404 skip

## Tests

**Closed-phase guard:**
- Monitor enabled + closed phase + 0 condors → `skip: true`
- Monitor enabled + closed phase + open condors → `skip: true`
- Monitor disabled + closed phase + 0 condors → `skip: true`
- Monitor disabled + closed phase + open condors → `skip: false`
- Monitor enabled + open phase → guard does not fire, execution continues

**404 = skip:**
- Expirations throws with `status: 404` → `skip: true`, reason contains "404"
- Expirations throws with `status: 500` → `skip: false`
- Expirations throws with no `response` (network error) → `skip: false`
