// scripts/resolve-current-epoch.mjs
// Decide which strategyVersion(s) are "current" — i.e. what the live agent is
// stamping — for adapt-strategy. Source of truth is the marker, NOT a config
// recompute, so a config edit after the agent started cannot reclassify valid
// current-epoch trades as prior.
// Spec: docs/superpowers/specs/2026-05-23-adapt-strategy-epoch-conditional-split-design.md
import { fileURLToPath } from 'node:url';
import { resolve as resolvePath } from 'node:path';

export function resolveCurrentEpoch({ markers = [], newestStampedVersion = null, configVersion = null } = {}) {
  const markerVersions = (markers ?? []).map(m => m && m.strategyVersion).filter(Boolean);
  let source, currentVersions;
  if (markerVersions.length) {
    source = 'marker';
    currentVersions = [...new Set(markerVersions)];
  } else if (newestStampedVersion) {
    source = 'newest-trade';
    currentVersions = [newestStampedVersion];
  } else if (configVersion) {
    source = 'config-inferred';
    currentVersions = [configVersion];
  } else {
    source = 'none';
    currentVersions = [];
  }
  let consistencyWarning = null;
  if (source === 'marker' && configVersion && !currentVersions.includes(configVersion)) {
    consistencyWarning = `Config implies version ${configVersion} but the running agent is stamping ${currentVersions.join(', ')}. Un-deployed rule change — loaded trades reflect the running rules, not the edited config.`;
  }
  return { currentVersions, source, consistencyWarning, divergent: currentVersions.length > 1 };
}

// CLI: reads { markers, newestStampedVersion, configVersion } JSON on stdin.
{
  const __filename = fileURLToPath(import.meta.url);
  const argv1abs = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (__filename === argv1abs) {
    let stdin = '';
    process.stdin.on('data', c => { stdin += c; });
    process.stdin.on('end', () => {
      let input;
      try { input = JSON.parse(stdin); } catch (err) {
        process.stderr.write(`stdin is not valid JSON: ${err.message}\n`); process.exit(6);
      }
      process.stdout.write(JSON.stringify(resolveCurrentEpoch(input), null, 2) + '\n');
    });
  }
}
