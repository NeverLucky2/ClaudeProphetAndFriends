# Tips & Influence Scorecard — Design Spec

**Date:** 2026-05-30
**Status:** Approved design (rev 3 — external review + news-lane refinement), pending implementation plan
**Scope:** Prophet agent only
**Mockup:** `.superpowers/brainstorm/1753-1780118838/content/` (latest `tips-scorecard-v3.html`)

---

## 1. Problem & motivation

The user (and occasionally his father) sometimes spots a real catalyst on a stock —
e.g., IBM's $10B quantum-computing investment (Reuters, 2026-05-28), or a US-government
equity stake in Intel. Two gaps surfaced:

1. **Some catalyst names weren't in Prophet's tradable universe at all** (IBM was missing,
   though it qualifies). *Already fixed* in commit `97f61e0` by adding IBM + 7 other liquid
   mega-caps to `config/prophet_tradable_universe.txt`.
2. **There is no way to measure whether the user's nudges actually help.** When the user
   tells Prophet "look at IBM," and Prophet trades it, that human input is invisible in the
   performance review. We can't answer the real question: *is my (or my dad's) advice
   genuinely additive?*

This feature adds a **read-only influence ledger**: a way to log a tip *before* it plays
out, then honestly measure the quality of the human call — carefully separated from the
agent's own discovery, selection, and exit timing.

### Explicitly rejected alternative
An earlier idea — a *temporary universe* letting Prophet trade out-of-universe names for a
few days on breaking news — was **rejected**. Reasons: (a) by the time news is "huge" the
move has happened and these attention-pops tend to *fade*; (b) out-of-universe names are off
the list largely because their **options aren't liquid**, so the existing options spread gate
would reject the opens anyway; (c) letting a tip override eligibility makes the ledger measure
"the EV of overriding my own risk rails," which is dangerous to gamify. Out-of-universe names
instead get a **deliberate, human-approved, permanent** path onto the list (Section 6).

---

## 2. Goals, non-goals & framing

### Goals
- Log a tip (ticker + one-line thesis + source) **before** the outcome is known.
- Honestly measure **the quality of the human call**, isolated from the agent's own radar.
- A **source breakdown** (`self` / `dad` / custom) — "whose call was it?" — with per-source
  statistical honesty.
- A **News-candidate feed** (out-of-universe suggestions from the existing scans) feeding
  universe curation only — never an agent trigger or a scored tip (D14).
- A **candidate queue** for tipped-but-not-traded (out-of-universe) names, with an eligibility
  evaluation and a human **Add-to-universe** action.
- Surface all of it in the dashboard (new **Tips** tab), with a badge in the **Trades** tab
  and an editable source list in **Settings**.

### Non-goals (v1)
- **No** temporary out-of-universe trading override. The trading path is untouched.
- **No** behavioral feedback loop (the agent does not change how it weights human input).
- **No** auto-add to the universe — promotion is always a human click.
- **No** real-time agent triggering from the news lane — Prophet already scans news every beat
  and is woken by breaking stories (D14).
- **No** change to how Prophet selects, sizes, or manages trades.
- **No** "NEW" tab badge; **no** single headline "score" or leaderboard.

### Framing (load-bearing)
This is an **honest ledger that prevents hindsight self-flattery**, not a leaderboard that
crowns a better picker. At realistic tip volumes (the user a handful per month, his dad maybe
a few per year), the per-source comparison **may never reach statistical significance**, and
the tool says so out loud. Every metric is presented with its sample size; ratio metrics that
detonate at small n (profit factor) are demoted in favor of the raw per-trade P&L distribution.
The goal is a truthful record, not a verdict on whose advice is better.

---

## 3. Key design decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Read-only ledger**, not a feedback loop | Foundation first; zero risk to trading. |
| D2 | **Explicit tip log**, logged *before* outcome | Kills hindsight bias; makes forward-return (D10-A) an unbiased call-quality measure. |
| D3 | **Attribution window = 3 trading days** (configurable), holiday-aware | Captures the disciplined pullback entry without crediting coincidental later trades. |
| D4 | **Source field** per tip, editable in Settings | Enables the "whose advice" comparison (with D11 honesty guards). |
| D5 | **Stick to the universe**; out-of-universe tips are report-only candidates | Keeps the firewall solid; options-liquidity wall makes override self-defeating. |
| D6 | **Eligibility is the gate** for candidate adds (options liquidity + cap), 3-day move is context-only | Candidates are queued *because* they popped → post-tip moves skew positive. |
| D7 | **Candidate → active tip is one record that transitions**; window anchors to add-time | Fair: don't penalize advice for the window the name was structurally untradable; no double-count; credit preserved. |
| D8 | **Full dashboard UX** (Approach 3), flag-gated, default OFF | Matches the project's ship-dark convention. |
| D9 | **Human-exclusive vs agent-discoverable split** via an `agentSurfaced` tag | A tip on a name Prophet's own scan already flagged isn't additive human value. |
| D10 | **Three separate metric views, never merged** | (A) call quality, (B) influenced-trade P&L, (C) context comparison (Section 5.2). |
| D11 | **Per-source small-sample guard; demote ratio metrics; ledger-not-leaderboard** | Suppress per-source ranking below threshold; P&L distribution over profit factor; significance may never arrive. |
| D12 | **Misses shown at equal prominence to hits** | Losing tips + tipped-but-not-traded get equal visual weight, with forward return. |
| D13 | **Single-writer concurrency**: Node server is the sole writer; all skills read-only | Atomic write protects the file, not the read-modify-write around a phase transition. |
| **D14** | **News surfaces out-of-universe candidates only** — never triggers the agent, never a scored tip | Prophet already scans news every beat (`harness.js`) and is woken by breaking news via the emergency-beat path (it is not emergency-exempt); a human "look at this" click is redundant. The one thing the agent can't do for itself is expand its universe — that is news's only non-redundant role here, and any name its own radar finds is **agent discovery credit**. |
| **D15** | **Candidate evaluation is standalone, not tied to `review-performance`** | Universe curation ≠ performance review; different cadence; keeps `review-performance` lean. Lives as the dashboard "Evaluate candidates" button + an optional dedicated skill the user runs ad hoc. `review-performance` keeps only the read-only ledger scorecard summary. |

---

## 4. Data model

### 4.1 Tip / candidate record
One record type, two phases. Stored in `data/tips/tips.json` (JSON array, atomic rewrite).

```jsonc
{
  "id": "tip_20260528_AMGN_0841",
  "ticker": "AMGN",
  "thesis": "Dad: oncology readout next week",
  "source": "dad",                       // self | dad | <custom>; "news" only on candidates
  "phase": "active",                     // "pending_candidate" | "active"
  "origin": "manual",                    // "manual" | "recommended" (recommended ⇒ candidate, news)
  "surfacedAt": "2026-05-28T08:41:00-04:00",
  "actionableAt": "2026-05-28T08:41:00-04:00", // scoring-window start (D7)
  "inUniverseAtLog": true,
  "dismissed": false,
  "recommendation": { "catalyst": "...", "feed": "Bloomberg", "feedAt": "..." } // iff recommended
}
```

**Derived at scoring time (not stored):** `agentSurfaced` (bool, D9) — whether the
`catalyst-news` / `analyst-actions` scan JSON independently flagged this ticker within the
tip's window. `origin: "recommended"` ⇒ `agentSurfaced: true` by construction.

**Phase & timestamp rules (D7):** in-universe log → active, `actionableAt = surfacedAt`;
out-of-universe → `pending_candidate` (report-only); Add-to-universe flips to active with
`actionableAt = now`, carrying `source`/`thesis`/`surfacedAt`; dedupe on promote; a
non-candidate Settings universe edit creates no tip.

### 4.2 Scoring window
`[actionableAt, actionableAt + 3 trading days]`, holiday-aware (reuse the holiday-aware-phase
market calendar). Length from `TIPS_ATTRIBUTION_WINDOW_DAYS` (default `3`).

### 4.3 Source list
In agent config (`config-store.js` / `data/agent-config.json`) under `tipSources`. Default
human sources `["self","dad"]`; `news` is a **reserved system source** used only on
candidate suggestions (never a human-selectable dropdown option for a scored tip).

---

## 5. Components & data flow

### 5.1 Tip store (`agent/tips-store.js`, Node) — sole writer (D13)
Read / append / mutate / atomic-write of `data/tips/tips.json`. **All mutations funnel through
the Node server process and are serialized in-process** (a write queue / mutex around each
read-modify-write, especially phase transitions). No other process writes this file. If a
future need forces a skill to write, it must take a cross-process advisory lock — this design
avoids that by keeping every mutation behind a server endpoint.

### 5.2 Metrics & methodology (the scorer, `agent/tips-scorer.js`, Node) — read-only
Loads Prophet trades from `data/sandboxes/<DIR>/decisive_actions/*.friction.json`, using
**friction-adjusted P&L** (`market_data.friction_adjusted_pl`, raw fallback tagged), **closed
trades only** for realized stats. Benchmarks use `bar-cache` / FMP (underlying + SPY bars).

The scorer emits **three separate views that are never merged (D10):**

**(A) Tip-call quality — the primary "is my advice good?" view.**
For *every* tip (traded or not), the **forward return of the underlying** from `actionableAt`
over the window, benchmarked vs **SPY** over the same window (did the call beat just owning the
market?). Measures the call itself, independent of whether/how Prophet traded it. Unbiased for
pre-outcome **manual** tips (D2). This is where tipped-but-not-traded names earn their keep — a
correct call Prophet declined still shows here.

**(B) Influenced-trade P&L — "what Prophet did with it," entangled.**
Realized friction-adjusted **option** P&L on trades matched to a tip (same underlying, entry in
window). Explicitly labelled as entangling **your entry** with **Prophet's selection** (it
declined the rest) and **Prophet's hold + exit** (most of a multi-week position's P&L).
Per-trade benchmark shown directionally vs the underlying over the hold; not equated with (A).

**(C) Influenced-vs-autonomous — context only, demoted.**
Kept but framed as **catalyst-trades-vs-everything-else**, *not* human-vs-agent. Not a primary metric.

**Human-exclusive vs agent-discoverable split (D9).** Within (A) and (B), partition by
`agentSurfaced`. **Human-exclusive** (agent's scan did not flag it) is the clean additive-value
measure; **agent-discoverable** is weak. Per D14, names that arrived via the news feed are
agent-discoverable by definition.

**Small-n discipline (D11).**
- Per-source **and** overall small-sample flags; below `TIPS_MIN_SAMPLE` (default 20) the view
  shows raw rows but **suppresses derived ranking and any implied "winner."**
- Prefer the **per-trade P&L distribution** (and median) over **profit factor** (shown only with
  its n and a caveat). No single headline score anywhere.

### 5.3 News-candidate feed (D14)
Reads the JSON `catalyst-news` / `analyst-actions` already emit, and surfaces **only
out-of-universe** catalyst names as **candidate suggestions**. In-universe scan hits get **no
lane entry** — Prophet already scans news every beat (`harness.js`) and breaking stories wake it
via the emergency-beat path (`analysis-scheduler` `onEmergencyWake` → `harness.emergencyWake`,
to which Prophet is not exempt), so a human "look at this" click adds latency, not signal, and
in-universe news is the **agent's own discovery credit**. **Approve** → add to the candidate
queue (`origin: "recommended"`, `source: "news"`) for eligibility evaluation; it is **not** a
scored influenced tip and does **not** trigger the agent. **Dismiss** → suppress. The full scan
JSON is still read (read-only) for the `agentSurfaced` split (D9). Writes go through the server (D13).

### 5.4 Candidate evaluation (eligibility-first, D6)
For each `pending_candidate`, a verdict against the universe's own bar:
- **Primary gate — options liquidity:** representative ATM monthly bid/ask spread vs the
  existing options-spread-gate threshold, plus open interest / volume.
- **Secondary context:** market cap, ADV, realized volatility.
- **Context-only, never gating:** the 3-trading-day post-tip move, with the selection-bias caveat.
- **Verdict:** `reject` (fails liquidity) → no Add; `watch` (borderline) → Add-anyway (ghost);
  `strong` → Add.
- Runs **standalone, on demand** — the dashboard "Evaluate candidates" button and (optionally) a
  small dedicated skill the user runs ad hoc. **Not coupled to `review-performance`** (D15):
  universe curation is a separate concern on a different cadence. Promotion stays a human action
  through the server (D13).

### 5.5 Add-to-universe action
Appends the ticker to `config/prophet_tradable_universe.txt` — the **sanctioned, human-gated
curation write**, explicitly distinct from the *automated* catalyst top-up the file's header
forbids. Promotes the candidate per D7. **Operational caveat for the plan:** the Go guard reads
the file at startup; a live add is effective on next restart/reload (plan decides: document "next
restart" vs add a reload signal/endpoint).

### 5.6 Dashboard surfaces (`agent/public/index.html`, served by `agent/server.js`)
New **Tips** tab (paper theme, per mockup v3): views A/B/C clearly separated; the human-exclusive
vs agent-discoverable split; the source breakdown with per-source n and small-sample guards;
**misses at equal prominence (D12)** (losing + not-traded tips share visual weight with hits,
each showing forward return). News-candidate feed, log form, and candidate queue (+ Evaluate +
Add-to-universe) as designed.

**Trades tab:** influenced trades carry a `Tipped · <source>` badge + "tipped only" filter.
**Settings tab:** editable Tip-sources list (`news` reserved/locked).

### 5.7 review-performance integration — read-only (D13/D15)
Appends a read-only ledger **scorecard summary** (views A/B with per-source n, human-exclusive
split) so tip performance shows up in the weekly review. It does **not** run candidate evaluation
(D15) and never mutates the tip store or the universe.

### 5.8 Server endpoints (Node, behind the flag)
list/create/dismiss tips; get ledger (A/B/C + split + per-source); list/approve news candidates;
list/evaluate candidates; add-to-universe; get/update source list. The server is the sole writer (D13).

---

## 6. The out-of-universe loop (end to end)

```
news scan (catalyst-news/analyst-actions)
   │  surfaces OUT-OF-UNIVERSE catalyst (in-universe hits → agent's own credit, no lane entry)
   ▼
News-candidate feed  ──Approve──►  pending_candidate (report-only)
   │                                      │
manual log of OOU ticker ────────────────►│
                                          ▼
                              Evaluate candidates (eligibility-first)
                                   reject │ watch │ strong
                                          │ (human clicks Add-to-universe via server)
                                          ▼
                       append to prophet_tradable_universe.txt (sanctioned write)
                       + tip flips to active, window starts now (D7)
                                          ▼
                       Prophet may now trade it via the normal gates;
                       trades within 3 trading days score as influenced
```

Nothing trades outside the universe; nothing is added without a human click; the news lane
never triggers the agent; the firewall stays solid.

---

## 7. Feature flag & rollout
- `ENABLE_TIPS_SCORECARD` (default **OFF**). Gates the Tips tab, endpoints, Trades-tab badge,
  and the review-performance section.
- Scorer/store are read-only/local; the only state-changing action is the human-gated universe
  write, which already has a deliberate confirmation.

---

## 8. Testing strategy
- **`agent/tips-store.test.mjs`** (`node:test`): CRUD, id/normalization, source validation,
  phase transition, dedupe-on-promote, atomic write, **serialized concurrent mutations (D13)**.
- **`agent/tips-scorer.test.mjs`**: matching by ticker + window; holiday-aware boundaries;
  closed-only; friction-adjusted P&L + raw-fallback; **view A forward-return + SPY benchmark**;
  **view B entangled P&L**; **`agentSurfaced` split (D9)**; **per-source small-sample guard +
  ranking suppression (D11)**; P&L-distribution vs profit-factor handling; tipped-not-traded.
- **News-candidate feed tests**: in-universe hits produce no lane entry; out-of-universe approve
  → candidate (not a scored tip), no agent trigger (D14).
- **Candidate evaluation tests**: verdict buckets vs spread/OI/cap; 3-day move never gates.
- **Add-to-universe tests**: appends exactly the ticker; promotes the right candidate; no tip on
  non-candidate edits.
- Mirror `review-performance`'s loading so the two never diverge.

---

## 9. Edge cases
- OOU tip whose window would have expired before promotion → window starts fresh at add-time (D7).
- Same ticker tipped by multiple sources → counted once per matching trade; attributed to the
  earliest active tip in window.
- Tip logged, Prophet never trades → still scored in **view A** (forward return), shown as a miss
  or a "you were right, Prophet passed" at equal prominence (D12).
- News candidate already covered by an existing candidate/tip → link, don't duplicate.
- `agentSurfaced` for a manual tip is computed by cross-referencing the scan JSON over the window;
  news-fed candidates are agent-discoverable by definition (D9/D14).
- Small per-source n → rows shown, ranking/headline suppressed (D11).
- Concurrent promote (dashboard) + eval display (review-performance) → safe: only the server
  writes; the skill reads (D13).

---

## 10. Suggested implementation phasing (within Approach 3)
1. **Phase 1 — core honest ledger:** tip store (single-writer) + scorer with **views A/B/C,
   benchmarks, the `agentSurfaced` split, and per-source small-sample discipline** + Tips-tab
   (log form, the three views, source breakdown, matched tips, misses at equal prominence).
   (The `agentSurfaced` cross-reference reads the scan JSON read-only — pulled forward even though
   the news feed UI is Phase 3.)
2. **Phase 2 — candidate loop:** candidate queue, **standalone** eligibility evaluation (dashboard
   button + optional dedicated skill), Add-to-universe, D7 transition. (Read-only review-performance
   scorecard summary can land here or in 1b.)
3. **Phase 3 — news + polish:** News-candidate feed (out-of-universe suggestions), Trades-tab
   badge + filter, Settings source editor.

---

## 11. Open questions for the implementation plan
- Exact path/shape of the `catalyst-news` / `analyst-actions` emitted JSON (used by both the
  news-candidate feed and the `agentSurfaced` split).
- Options-spread / OI data source for evaluation: reuse the Go spread-gate quote path vs an
  FMP/Alpaca call from Node.
- Underlying/SPY forward-return source: `bar-cache` vs FMP, and intraday vs daily granularity
  for the window benchmark.
- Universe live-reload vs "effective next restart" (Section 5.5).
- Scorer on a schedule/cache vs computed on dashboard request.
