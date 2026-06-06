# Coil Options-Overlay — Feasibility Model Results

**CALL: not cheap-killed, but central cell underperforms the stock (per-notional 0.12% < 0.48%)** · **PUT: gate FAIL**

MODEL, not a backtest — assumption-driven (entry IV = trailing-RV proxy; state-dependent exit IV; BS-European, no American early assignment; no skew). Decides "is real options data worth buying," NOT "trade this." n=468 Coil [0,5) trades (0 dropped). **Coil stock edge: mean 0.48%/trade, tail-risk ratio 0.073** — the bar any overlay must beat.

## Long calls (mirror Coil stock exit)

- **KILL test = best PER-NOTIONAL cell vs the stock.** A leveraged overlay must beat simply holding the name. Best per-notional cell = 0.83% ({"w":5,"p":1.5,"cr":0,"sp":0.6,"s":0.05,"dte":30}) vs stock 0.48% → KILLED iff ≤ stock → **survives — investigate**.
- central cell per-notional: 0.12% (vs stock 0.48%); win 44.66%.
- *return-on-premium (NOT a decision basis — right-skewed + cheap-IV-denominator gamed):* central mean 16.73%, **median -6.13%** (the typical trade), best-cell mean 96.30% at {"w":5,"p":0.8,"cr":0,"sp":0.6,"s":0.05,"dte":7} (the cheapest-premium corner — an artifact, not edge).

## Short put — hold to expiry (natural CSP; return on collateral)

- central cell: mean 0.29%, win 73.72%, worst-decile -7.54%, **tail-risk ratio 0.039 (vs stock 0.073)**.
- band (CI lo must be >0 in ALL for a pass):
  - {"w":5,"p":1.2,"s":0.1,"dte":14}: mean 0.29% CI [-0.19%, 0.69%]
  - {"w":20,"p":1.2,"s":0.1,"dte":14}: mean 0.42% CI [-0.01%, 0.80%]
  - {"w":5,"p":0.8,"s":0.1,"dte":14}: mean -0.40% CI [-0.89%, 0.00%]
  - {"w":5,"p":1.5,"s":0.1,"dte":14}: mean 0.81% CI [0.32%, 1.22%]
  - {"w":5,"p":1.2,"s":0.1,"dte":30}: mean 0.59% CI [0.00%, 1.14%]
- **gate:** band-all-CI>0 = false; tail-ratio beats stock = false; tail modeled = true → **FAIL**.

## Short put — mirror exit corroboration (where the loser vol-spike bites)

- central (spike 30%): mean -0.13% CI [-0.40%, 0.12%]
- loser-spike STRESS (spike 60%): mean -0.32% CI [-0.61%, -0.04%]

## Honest ceiling & limitations

- BS-European cannot model American **early assignment** (clusters on the deep-ITM losers) nor skew/term-structure — all err ROSY on the short-put tail. A put pass = **"buy real options chains to test the assignment tail,"** never "trade it." The model reliably KILLS calls; it only gates the data-spend for puts.
- Long-call return-on-premium is intentionally NOT the decision metric: it is right-skewed (a few big winners) and inflated where entry IV is understated (cheap premium → huge %); the per-notional-vs-stock test is the sound one.
- Entry IV is an RV proxy (5-day primary, spike-aware); loser-spike magnitude is a guess; r=0.04 flat (immaterial). ATM only (strike is the next axis if puts survive). Off the fleet ballast thesis regardless (leveraged/short-vol overlay on a long-biased edge).