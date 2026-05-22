// Candidate-cache warmer gating. The Go warmer (cmd/bot/main.go) is launched
// per-bot only for the cache that bot's agent actually reads: Coil
// (strategyId 'mean-rev-rsi2') reads /meanrev/candidates, Drift ('earnings-drift')
// reads /drift/candidates. Every other agent gets an explicit 'false' so it
// can't inherit a 'true' from the shared .env (same reasoning as the turtle flag).
export function candidateWarmerFlags(strategyId) {
  return {
    ENABLE_MEANREV_WARMER: strategyId === 'mean-rev-rsi2' ? 'true' : 'false',
    ENABLE_DRIFT_WARMER: strategyId === 'earnings-drift' ? 'true' : 'false',
  };
}
