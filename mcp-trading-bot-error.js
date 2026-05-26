// Formats an error from a callTradingBot axios call into a message that
// preserves the trading bot's response body. Guard rejections (HTTP 422) and
// placement failures (HTTP 500) carry the actual reason in the JSON body
// ({error, details}); surfacing only "Request failed with status code NNN"
// leaves the agent blind and forces it to guess (e.g. mistaking a structural
// spread-gate block for stale quotes). Pure function so it is unit-testable
// without axios or a live bot.
export function formatTradingBotError(error) {
  const resp = error.response;
  const body = resp && resp.data;
  // Only override the generic message when the server actually returned a body.
  if (body !== undefined && body !== null && body !== '') {
    let reason;
    if (typeof body === 'string') {
      reason = body;
    } else {
      reason = body.error || body.message || JSON.stringify(body);
      if (body.details) {
        reason += ` (${body.details})`;
      }
    }
    return `Trading bot error (${resp.status}): ${reason}`;
  }
  return `Trading bot error: ${error.message}`;
}
