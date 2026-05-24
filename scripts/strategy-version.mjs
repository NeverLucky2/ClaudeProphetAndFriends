// scripts/strategy-version.mjs
// Shared rule-resolution + epoch-version hashing for the learning loop.
// Spec: docs/superpowers/specs/2026-05-23-trade-ruleset-epoch-stamp-design.md
import { createHash } from 'node:crypto';
import { readFile as fsReadFile, writeFile as fsWriteFile, mkdir as fsMkdir } from 'node:fs/promises';
import path from 'node:path';

// Returns a stable 12-char hex epoch id for a ruleset, or null for empty rules.
// Normalizes CRLF->LF and strips trailing horizontal whitespace so cosmetic-only
// diffs do not spuriously create a new epoch.
export function computeStrategyVersion(rulesText) {
  if (!rulesText || !rulesText.trim()) return null;
  const normalized = rulesText.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();
  return createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 12);
}

// Resolve effective rules text, same precedence as buildSystemPrompt:
// agent.customStrategyRules -> strategy.rulesFile -> strategy.customRules -> TRADING_RULES.md.
// `strategy` is the already-looked-up strategy object (or null).
export async function resolveStrategyRules(agentConfig, strategy, opts = {}) {
  const {
    readFile = fsReadFile,
    cwd = process.cwd(),
    onReadFileError = (rulesFile, err) =>
      console.error(`Warning: Failed to load strategy rules file "${rulesFile}":`, err.message),
  } = opts;
  if (agentConfig?.customStrategyRules) return agentConfig.customStrategyRules;
  if (strategy) {
    if (strategy.rulesFile) {
      // Note: if rulesFile read fails, we do NOT fall back to customRules — a
      // mis-configured rulesFile path is treated as a config error and falls
      // through to the global default. Matches buildSystemPrompt behavior. (Fix 3)
      try {
        return await readFile(path.join(cwd, strategy.rulesFile), 'utf-8');
      } catch (err) {
        onReadFileError(strategy.rulesFile, err);
        /* fall through */
      }
    } else if (strategy.customRules) {
      return strategy.customRules;
    }
  }
  try { return await readFile(path.join(cwd, 'TRADING_RULES.md'), 'utf-8'); } catch { return ''; }
}

export function buildVersionMarker(agentConfig, strategyVersion, now = new Date()) {
  return {
    strategyId: agentConfig?.strategyId || null,    // '' is treated as absent (matches harness default)
    strategyVersion: strategyVersion ?? null,
    startedAt: now.toISOString(),
  };
}

// Writes data/sandboxes/<accountDir>/.current_strategy_version.json. Returns the path.
export async function writeVersionMarker(accountDir, marker, opts = {}) {
  const { writeFile = fsWriteFile, mkdir = fsMkdir, cwd = process.cwd() } = opts;
  const dir = path.join(cwd, 'data', 'sandboxes', accountDir);
  const file = path.join(dir, '.current_strategy_version.json');
  await mkdir(dir, { recursive: true });
  await writeFile(file, JSON.stringify(marker, null, 2));
  return file;
}
