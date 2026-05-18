import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ADAPT_SKILLS = [
  '.claude/skills/adapt-strategy/SKILL.md',
  '.claude/skills/adapt-strategy-penny/SKILL.md',
  '.claude/skills/harvest-parameter-review/SKILL.md',
  '.claude/skills/trend-parameter-review/SKILL.md',
];

for (const path of ADAPT_SKILLS) {
  test(`${path}: has Step 0.5 — Build regime history exactly once`, () => {
    const content = readFileSync(path, 'utf8');
    const matches = content.match(/## Step 0\.5 — Build regime history/g) ?? [];
    assert.equal(matches.length, 1, `expected exactly 1 occurrence of Step 0.5 header; got ${matches.length}`);
  });

  test(`${path}: references build-regime-history.mjs`, () => {
    const content = readFileSync(path, 'utf8');
    assert.match(content, /scripts\/build-regime-history\.mjs/);
  });

  test(`${path}: references --regime-history flag in scorer invocation`, () => {
    const content = readFileSync(path, 'utf8');
    assert.match(content, /--regime-history data\/reports\/regime_history\.json/);
  });

  test(`${path}: references --adapt-set-distribution flag`, () => {
    const content = readFileSync(path, 'utf8');
    assert.match(content, /--adapt-set-distribution/);
  });
}

const REVIEW_SKILLS = [
  '.claude/skills/review-performance/SKILL.md',
  '.claude/skills/review-performance-penny/SKILL.md',
];

for (const path of REVIEW_SKILLS) {
  test(`${path}: has Step 0.5 — Build regime history`, () => {
    const content = readFileSync(path, 'utf8');
    assert.match(content, /## Step 0\.5 — Build regime history/);
  });

  test(`${path}: references build-regime-history.mjs`, () => {
    const content = readFileSync(path, 'utf8');
    assert.match(content, /scripts\/build-regime-history\.mjs/);
  });

  test(`${path}: does NOT call score-rule-against-holdout (review-only, no scorer)`, () => {
    const content = readFileSync(path, 'utf8');
    assert.doesNotMatch(content, /score-rule-against-holdout\.mjs/);
  });
}

test('.claude/skills/stress-test-friction/SKILL.md: references friction-stress-compare.mjs', () => {
  const content = readFileSync('.claude/skills/stress-test-friction/SKILL.md', 'utf8');
  assert.match(content, /scripts\/friction-stress-compare\.mjs/);
});

test('.claude/skills/stress-test-friction/SKILL.md: codifies flip-rate thresholds', () => {
  const content = readFileSync('.claude/skills/stress-test-friction/SKILL.md', 'utf8');
  assert.match(content, /flip_rate < 0\.05/);
  assert.match(content, /0\.05 ≤ flip_rate < 0\.20/);
  assert.match(content, /flip_rate ≥ 0\.20/);
});

const ADAPT_FOR_GATE = [
  '.claude/skills/adapt-strategy/SKILL.md',
  '.claude/skills/adapt-strategy-penny/SKILL.md',
  '.claude/skills/harvest-parameter-review/SKILL.md',
  '.claude/skills/trend-parameter-review/SKILL.md',
];

for (const path of ADAPT_FOR_GATE) {
  test(`${path}: references significance-gate.mjs`, () => {
    const content = readFileSync(path, 'utf8');
    assert.match(content, /scripts\/significance-gate\.mjs/);
  });

  test(`${path}: has the FINAL precedence rule list`, () => {
    const content = readFileSync(path, 'utf8');
    assert.match(content, /FINAL precedence/);
    assert.match(content, /NEEDS-OVERRIDE/);
  });

  test(`${path}: has the asset-class tagging table`, () => {
    const content = readFileSync(path, 'utf8');
    assert.match(content, /iron condor/);
    assert.match(content, /Asset-class tagging/);
  });
}
