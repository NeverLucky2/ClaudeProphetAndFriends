// scripts/cef-universe.mjs
// Curated liquid CEF universe for the discount-reversion study. SURVIVORSHIP-BIASED by
// construction (current-snapshot; funds liquidated/merged by 2026 are invisible) — a loud
// RESULTS caveat per spec §10. tier drives the friction half-spread (cef-friction.mjs).
export const CEF_UNIVERSE = [
  { ticker: 'PDI', type: 'fixed_income', tier: 'liquid' }, { ticker: 'PTY', type: 'fixed_income', tier: 'liquid' },
  { ticker: 'PDO', type: 'fixed_income', tier: 'liquid' }, { ticker: 'PCN', type: 'fixed_income', tier: 'mid' },
  { ticker: 'PCM', type: 'fixed_income', tier: 'thin' }, { ticker: 'DSL', type: 'fixed_income', tier: 'liquid' },
  { ticker: 'RA', type: 'fixed_income', tier: 'mid' }, { ticker: 'EIC', type: 'fixed_income', tier: 'mid' },
  { ticker: 'ECC', type: 'fixed_income', tier: 'mid' }, { ticker: 'OXLC', type: 'fixed_income', tier: 'mid' },
  { ticker: 'BGT', type: 'fixed_income', tier: 'thin' }, { ticker: 'JQC', type: 'fixed_income', tier: 'mid' },
  { ticker: 'NCV', type: 'fixed_income', tier: 'thin' }, { ticker: 'NCZ', type: 'fixed_income', tier: 'thin' },
  { ticker: 'PFN', type: 'fixed_income', tier: 'mid' }, { ticker: 'PFL', type: 'fixed_income', tier: 'thin' },
  { ticker: 'FAX', type: 'fixed_income', tier: 'thin' }, { ticker: 'AWF', type: 'fixed_income', tier: 'mid' },
  { ticker: 'BHK', type: 'fixed_income', tier: 'mid' }, { ticker: 'BTZ', type: 'fixed_income', tier: 'liquid' },
  { ticker: 'NAD', type: 'muni', tier: 'liquid' }, { ticker: 'NEA', type: 'muni', tier: 'mid' },
  { ticker: 'NZF', type: 'muni', tier: 'liquid' }, { ticker: 'NVG', type: 'muni', tier: 'mid' },
  { ticker: 'PML', type: 'muni', tier: 'mid' }, { ticker: 'PMX', type: 'muni', tier: 'thin' },
  { ticker: 'BLE', type: 'muni', tier: 'thin' }, { ticker: 'MUB', type: 'muni', tier: 'mid' },
  { ticker: 'VKQ', type: 'muni', tier: 'thin' }, { ticker: 'MQY', type: 'muni', tier: 'thin' },
  { ticker: 'ADX', type: 'equity', tier: 'liquid' }, { ticker: 'USA', type: 'equity', tier: 'mid' },
  { ticker: 'GAB', type: 'equity', tier: 'mid' }, { ticker: 'ETV', type: 'equity', tier: 'mid' },
  { ticker: 'ETY', type: 'equity', tier: 'mid' }, { ticker: 'ETB', type: 'equity', tier: 'thin' },
  { ticker: 'QQQX', type: 'equity', tier: 'mid' }, { ticker: 'BST', type: 'equity', tier: 'liquid' },
  { ticker: 'BSTZ', type: 'equity', tier: 'mid' }, { ticker: 'BME', type: 'equity', tier: 'mid' },
  { ticker: 'BMEZ', type: 'equity', tier: 'mid' }, { ticker: 'STK', type: 'equity', tier: 'thin' },
  { ticker: 'EOS', type: 'equity', tier: 'thin' }, { ticker: 'EOI', type: 'equity', tier: 'thin' },
  { ticker: 'UTF', type: 'multi_asset', tier: 'liquid' }, { ticker: 'UTG', type: 'multi_asset', tier: 'liquid' },
  { ticker: 'RNP', type: 'multi_asset', tier: 'mid' }, { ticker: 'RQI', type: 'multi_asset', tier: 'mid' },
  { ticker: 'AOD', type: 'multi_asset', tier: 'thin' }, { ticker: 'HTD', type: 'multi_asset', tier: 'thin' },
  { ticker: 'PEO', type: 'multi_asset', tier: 'thin' }, { ticker: 'BCAT', type: 'multi_asset', tier: 'mid' },
];
export function tierOf(ticker) {
  const t = String(ticker).toUpperCase().trim();
  const hit = CEF_UNIVERSE.find((c) => c.ticker === t);
  return hit ? hit.tier : '';
}
export function allCefTickers() { return [...new Set(CEF_UNIVERSE.map((c) => c.ticker))]; }
