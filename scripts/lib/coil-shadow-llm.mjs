import Anthropic from '@anthropic-ai/sdk';

const SYSTEM = `You are a trading-signal judge for a research shadow evaluation. For each large-cap stock — a mechanical mean-reversion near-miss (RSI(2) just above the 5 trigger, in a pullback within an uptrend) — decide whether it will bounce SOON enough to "fire early" on. Use ONLY the numeric signals given; no outside knowledge. Respond with STRICT JSON: {"per_name":[{"ticker","fire_early":bool,"reason":string}]}. No prose outside the JSON.`;

// tagCandidates asks the model to tag each candidate fire_early or not. Retries
// once. Missing / unparseable names default to 'declined' (never fabricate a
// fire). Returns the tag map plus the raw request/response for the audit log.
export async function tagCandidates(candidates, { client, model }) {
  const request = { model, max_tokens: 4096, system: SYSTEM,
    messages: [{ role: 'user', content: JSON.stringify({ candidates }) }] };

  let lastErr;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const resp = await client.messages.create(request);
      const text = (resp.content || []).map((b) => b.text || '').join('');
      const parsed = JSON.parse(text);
      const fire = new Set((parsed.per_name || [])
        .filter((r) => r && r.fire_early === true)
        .map((r) => String(r.ticker).toUpperCase()));
      const tags = {};
      for (const c of candidates) tags[c.name] = fire.has(c.name) ? 'fire_early' : 'declined';
      return { tags, request, response: text, stopReason: resp.stop_reason ?? null };
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

export function makeAnthropicTagger(model = 'claude-sonnet-5') {
  const apiKey = process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('CLAUDE_API_KEY or ANTHROPIC_API_KEY required');
  const client = new Anthropic({ apiKey });
  return { client, model };
}
