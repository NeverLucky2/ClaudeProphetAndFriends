# Coil Stop-Tightening Backtest — Results

**Verdict: KEEP** — no material risk reduction (maxDD not cut >=10%)

Primary stop=−5% vs baseline −7%; friction 20bps; prereg hash `8a268906`. Expected: KEEP.

## Marginal set — save vs whipsaw (holdout, primary −5%)

- marginal n@0.05 = 81
- **saves: n=37, sum 58.11%**
- **whipsaws: n=44, drag -119.42%**
- net marginal Δ -61.31%; bootstrap CI [-1.37%, -0.17%]
- winsorized-upside net Δ CI [-1.40%, -0.17%] (saves capped at p90)

## Portfolio gates (holdout)

- baseline −7%: net 2.69%, maxDD -5.58%, CVaR5% -7.30%, trades 395
- tightened −5%: net 2.54%, maxDD -5.67%, CVaR5% -5.65%, trades 415
- **gate A (risk):** |maxDD| 5.67% vs floor 5.02% → false
- **gate B (returns):** net 2.54% vs floor 2.42% → true
- admitted-by-tightening (filled@−5%, not@−7%): 33 — mean counterfactual net 0.83%

## Stop-slippage sensitivity (fill at stop −10bps; primary verdict reads at 20bps)

- tightened −5% under slip: net 2.24%, maxDD -5.82% → gate A false, gate B false
- verdict stable under the slip arm

## Drawdown-episode placement (gate A audit)

- split boundary 2024-01-04
- baseline deepest DD — train -3.45% @2022-11-11; holdout -5.58% @2025-11-21
- gate A exercised by a holdout drawdown

### Secondary stops (exploratory only — never gate; no post-hoc promotion)

- stop=−3%: marginal net Δ -68.22%, portfolio net 4.97%, maxDD -4.11%, whipsaws 98
- stop=−4%: marginal net Δ -64.15%, portfolio net 2.78%, maxDD -5.56%, whipsaws 65
- stop=−6%: marginal net Δ -9.86%, portfolio net 2.30%, maxDD -5.92%, whipsaws 13

## Limitations

- **Survivorship biases TOWARD KEEP** (removes the disaster names a tight stop would rescue), but Coil's existing −7% already bounds per-name loss, so the residual is small and a KEEP stays credible; a borderline TIGHTEN carries the caveat.
- Gate A is only meaningful if the holdout contains real stress — see the drawdown-episode placement above; an untested gate A makes any TIGHTEN unconfirmed.
- Daily-low stop touch + gap-through fills; regime sizing held normal; earnings = forward 5-trading-bar FMP filter. KEEP@−5% does not prove no tighter level ever helps — pre-register a fresh study with that level as primary.