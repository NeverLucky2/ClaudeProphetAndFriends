package services

import "fmt"

// formatHeartbeatLine builds the one-line "heartbeat processed" confirmation shown in a
// Go-scheduled agent's dashboard console (carried there by the Node stdout/stderr→goLog
// forwarder in orchestrator.js). Mirrors the Node agent/heartbeat-line.js format so the
// indicator reads consistently across LLM-beat and Go-scheduled agents.
func formatHeartbeatLine(agent, summary, etTime string) string {
	who := ""
	if agent != "" {
		who = agent + " "
	}
	ctx := ""
	if etTime != "" {
		ctx = " · " + etTime + " ET"
	}
	return fmt.Sprintf("%s✓ heartbeat processed — %s%s", who, summary, ctx)
}
