// Orphan poller. Layer A surfacing for the Go-side orphan detector: poll each
// bot's /api/v1/orphans/status, expose an aggregate for the dashboard, and push
// deduped Slack alerts. No detection here — the Go findOrphans is the source of
// truth; this only surfaces it.

// diffOrphanAlerts is pure: given the set of orphan symbols already alerted for
// a sandbox and the latest snapshot, return which symbols are newly-detected,
// which resolved, and any flatten actions to announce. Dedup lives in the caller
// (it owns the per-sandbox prevSymbols set); this decides what changed.
export function diffOrphanAlerts(prevSymbols, snapshot) {
  const cur = new Set((snapshot?.orphans || []).map(o => o.symbol));
  const newlyDetected = [...cur].filter(s => !prevSymbols.has(s));
  const resolved = [...prevSymbols].filter(s => !cur.has(s));
  const flattenEvents = (snapshot?.last_actions || []).map(a => ({ symbol: a.symbol, success: a.success, at: a.at, order_id: a.order_id }));
  return { newlyDetected, resolved, flattenEvents };
}

// makeOrphanPoller builds a poller over injected deps so server.js stays thin
// and the poll cycle is testable. deps: { runtimes(), notify(event, text,
// sandboxId), logger }.
export function makeOrphanPoller(deps) {
  const seen = new Map();        // sandboxId -> Set<symbol> already alerted
  const seenActions = new Map(); // sandboxId -> Set<actionKey> already announced
  const aggregate = new Map();   // sandboxId -> latest snapshot (for /api/orphans)

  async function pollOnce() {
    for (const runtime of deps.runtimes()) {
      const sandboxId = runtime?.harness?.sandboxId;
      const goAxios = runtime?.goAxios;
      if (!sandboxId || !goAxios) continue;
      try {
        const { data } = await goAxios.get('/api/v1/orphans/status');
        aggregate.set(sandboxId, data);
        const prev = seen.get(sandboxId) || new Set();
        const { newlyDetected, resolved, flattenEvents } = diffOrphanAlerts(prev, data);

        for (const sym of newlyDetected) {
          deps.notify('orphanDetected', `:warning: *Orphan detected* — ${sym}: broker holds shares this bot marked closed (no stop, no manager). Sandbox ${sandboxId}.`, sandboxId);
        }
        const next = new Set((data?.orphans || []).map(o => o.symbol));
        seen.set(sandboxId, next);
        void resolved; // resolution clears dedup via `next`; no alert on resolve

        const actSeen = seenActions.get(sandboxId) || new Set();
        for (const ev of flattenEvents) {
          // Key on the action's stable identity (`at`, set once per occurrence
          // by the Go side and never regenerated on ring-replay) so a genuinely
          // new recurrence — same symbol, same outcome, later `at` — re-alerts
          // instead of being silently swallowed by a coarse symbol:success key.
          // Fall back to the coarse key when `at` is missing (older snapshots /
          // malformed data) so behavior never regresses to alerting every poll.
          const key = ev.at !== undefined ? `${ev.symbol}:${ev.success}:${ev.at}` : `${ev.symbol}:${ev.success}`;
          if (actSeen.has(key)) continue;
          actSeen.add(key);
          if (ev.success) {
            deps.notify('orphanFlattened', `:broom: *Orphan auto-flattened* — ${ev.symbol} liquidated. Sandbox ${sandboxId}.`, sandboxId);
          } else {
            deps.notify('orphanFlattenFailed', `:rotating_light: *Orphan auto-flatten FAILED* — ${ev.symbol}. Operator action required. Sandbox ${sandboxId}.`, sandboxId);
          }
        }
        seenActions.set(sandboxId, actSeen);
      } catch (err) {
        deps.logger?.(`orphan poll failed for ${sandboxId}: ${err.message}`);
        // soft-fail per sandbox
      }
    }
  }

  function getAggregate() {
    return Object.fromEntries(aggregate);
  }

  return { pollOnce, getAggregate };
}
