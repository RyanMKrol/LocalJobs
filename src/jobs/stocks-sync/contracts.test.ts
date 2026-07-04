// Tests for the stocks-sync artifact contracts (T366) and that the workflow's
// DAG derives the expected gates. Run via `npm test`.
//
// Contract checks are exercised against SYNTHETIC fixtures in a temp dir — NO
// live Trading212 API call.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArtifactContract, GateResult } from '../../core/types.js';
import { buildDag, deriveGates } from '../../core/dag.js';
import { stocksFreshBreachesContract, stocksPortfolioContract, stocksRawPositionsContract } from './contracts.js';

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  }
}

function run(c: ArtifactContract): GateResult {
  const r = c.check();
  assert.ok(!(r instanceof Promise), 'contract check should be synchronous');
  return r;
}

const dir = mkdtempSync(join(tmpdir(), 'lj-stocks-contracts-'));
const f = (name: string) => join(dir, name);
const writeJson = (name: string, obj: unknown) => {
  const p = f(name);
  writeFileSync(p, JSON.stringify(obj));
  return p;
};

// ─────────────────────────── stocks-raw-positions ───────────────────────────

test('stocks-raw-positions: a well-formed non-empty array passes', () => {
  const p = writeJson('raw-positions-ok.json', [
    { ticker: 'AAPL', quantity: 5, averageBuyPrice: 100, currentPrice: 150, currentValue: 750, account: 'invest' },
    { ticker: 'VUSA_EQ', quantity: 2, averageBuyPrice: 80, currentPrice: 90, currentValue: 180, account: 'isa' },
  ]);
  const r = run(stocksRawPositionsContract(p));
  assert.equal(r.ok, true, r.violations?.join('; '));
  assert.ok(r.sample?.includes('2 position'));
});

test('stocks-raw-positions: an EMPTY array is a legitimate state, not a violation', () => {
  const p = writeJson('raw-positions-empty.json', []);
  const r = run(stocksRawPositionsContract(p));
  assert.equal(r.ok, true, r.violations?.join('; '));
  assert.ok(r.sample?.includes('0 position'));
});

test('stocks-raw-positions: a missing file fails', () => {
  const r = run(stocksRawPositionsContract(f('raw-positions-does-not-exist.json')));
  assert.equal(r.ok, false);
});

test('stocks-raw-positions: invalid JSON fails', () => {
  const p = f('raw-positions-bad.json');
  writeFileSync(p, '{ not json');
  const r = run(stocksRawPositionsContract(p));
  assert.equal(r.ok, false);
});

test('stocks-raw-positions: a non-array top-level value fails', () => {
  const p = writeJson('raw-positions-object.json', { positions: [] });
  const r = run(stocksRawPositionsContract(p));
  assert.equal(r.ok, false);
  assert.ok(r.violations?.some((v) => /array/i.test(v)));
});

test('stocks-raw-positions: a malformed entry (missing ticker) fails', () => {
  const p = writeJson('raw-positions-malformed.json', [
    { quantity: 5, averageBuyPrice: 100, currentPrice: 150, currentValue: 750, account: 'invest' },
  ]);
  const r = run(stocksRawPositionsContract(p));
  assert.equal(r.ok, false);
});

test('stocks-raw-positions: a malformed entry (bad account) fails', () => {
  const p = writeJson('raw-positions-badaccount.json', [
    { ticker: 'AAPL', quantity: 5, averageBuyPrice: 100, currentPrice: 150, currentValue: 750, account: 'other' },
  ]);
  const r = run(stocksRawPositionsContract(p));
  assert.equal(r.ok, false);
});

// ─────────────────────────── stocks-portfolio ───────────────────────────

test('stocks-portfolio: a well-formed non-empty array passes', () => {
  const p = writeJson('portfolio-ok.json', [
    { ticker: 'AAPL', quantity: 5, averageBuyPrice: 100, currentPrice: 150, currentValue: 750, account: 'invest' },
    { ticker: 'VUSA_EQ', quantity: 2, averageBuyPrice: 80, currentPrice: 90, currentValue: 180, account: 'isa' },
  ]);
  const r = run(stocksPortfolioContract(p));
  assert.equal(r.ok, true, r.violations?.join('; '));
  assert.ok(r.sample?.includes('2 position'));
});

test('stocks-portfolio: an EMPTY array is a legitimate state, not a violation', () => {
  const p = writeJson('portfolio-empty.json', []);
  const r = run(stocksPortfolioContract(p));
  assert.equal(r.ok, true, r.violations?.join('; '));
  assert.ok(r.sample?.includes('0 position'));
});

test('stocks-portfolio: a missing file fails', () => {
  const r = run(stocksPortfolioContract(f('does-not-exist.json')));
  assert.equal(r.ok, false);
});

test('stocks-portfolio: invalid JSON fails', () => {
  const p = f('portfolio-bad.json');
  writeFileSync(p, '{ not json');
  const r = run(stocksPortfolioContract(p));
  assert.equal(r.ok, false);
});

test('stocks-portfolio: a non-array top-level value fails', () => {
  const p = writeJson('portfolio-object.json', { positions: [] });
  const r = run(stocksPortfolioContract(p));
  assert.equal(r.ok, false);
  assert.ok(r.violations?.some((v) => /array/i.test(v)));
});

test('stocks-portfolio: a malformed entry (missing ticker) fails', () => {
  const p = writeJson('portfolio-malformed.json', [
    { quantity: 5, averageBuyPrice: 100, currentPrice: 150, currentValue: 750, account: 'invest' },
  ]);
  const r = run(stocksPortfolioContract(p));
  assert.equal(r.ok, false);
});

test('stocks-portfolio: a malformed entry (bad account) fails', () => {
  const p = writeJson('portfolio-badaccount.json', [
    { ticker: 'AAPL', quantity: 5, averageBuyPrice: 100, currentPrice: 150, currentValue: 750, account: 'other' },
  ]);
  const r = run(stocksPortfolioContract(p));
  assert.equal(r.ok, false);
});

// ─────────────────────────── stocks-fresh-breaches ───────────────────────────

test('stocks-fresh-breaches: a well-formed non-empty array passes', () => {
  const p = writeJson('breaches-ok.json', [
    { ticker: 'AAPL', account: 'invest', gain: 0.42, averageBuyPrice: 100, currentPrice: 142 },
  ]);
  const r = run(stocksFreshBreachesContract(p));
  assert.equal(r.ok, true, r.violations?.join('; '));
  assert.ok(r.sample?.includes('1 breach'));
});

test('stocks-fresh-breaches: an EMPTY array is the normal, healthy state, not a violation', () => {
  const p = writeJson('breaches-empty.json', []);
  const r = run(stocksFreshBreachesContract(p));
  assert.equal(r.ok, true, r.violations?.join('; '));
  assert.ok(r.sample?.includes('0 breach'));
});

test('stocks-fresh-breaches: a missing file fails', () => {
  const r = run(stocksFreshBreachesContract(f('does-not-exist-2.json')));
  assert.equal(r.ok, false);
});

test('stocks-fresh-breaches: invalid JSON fails', () => {
  const p = f('breaches-bad.json');
  writeFileSync(p, 'not json at all');
  const r = run(stocksFreshBreachesContract(p));
  assert.equal(r.ok, false);
});

test('stocks-fresh-breaches: a non-array top-level value fails', () => {
  const p = writeJson('breaches-object.json', { breaches: [] });
  const r = run(stocksFreshBreachesContract(p));
  assert.equal(r.ok, false);
  assert.ok(r.violations?.some((v) => /array/i.test(v)));
});

test('stocks-fresh-breaches: a malformed entry (non-numeric gain) fails', () => {
  const p = writeJson('breaches-malformed.json', [
    { ticker: 'AAPL', account: 'invest', gain: 'lots', averageBuyPrice: 100, currentPrice: 142 },
  ]);
  const r = run(stocksFreshBreachesContract(p));
  assert.equal(r.ok, false);
});

// ─────────────────────────── shape declarations ───────────────────────────

test('all three contracts declare a shape with a summary + non-empty expectations', () => {
  for (const c of [stocksRawPositionsContract(), stocksPortfolioContract(), stocksFreshBreachesContract()]) {
    assert.ok(c.shape, `${c.key} has no shape`);
    assert.ok(c.shape!.summary.length > 0, `${c.key} shape has no summary`);
    assert.ok(c.shape!.expectations.length > 0, `${c.key} shape has no expectations`);
  }
});

test('contract keys are stable', () => {
  assert.equal(stocksRawPositionsContract().key, 'stocks-raw-positions');
  assert.equal(stocksPortfolioContract().key, 'stocks-portfolio');
  assert.equal(stocksFreshBreachesContract().key, 'stocks-fresh-breaches');
});

// ─────────────────────── DAG gate derivation (regression guard) ───────────────────────

test('the stocks-sync DAG derives exactly 3 gates matching its stage boundaries', () => {
  const dag = buildDag([
    { job: 'stocks-fetch' },
    { job: 'stocks-snapshot', dependsOn: ['stocks-fetch'] },
    { job: 'stocks-watch', dependsOn: ['stocks-snapshot'] },
    { job: 'stocks-notify', dependsOn: ['stocks-watch'] },
  ]);
  const produces = new Map<string, string[]>([
    ['stocks-fetch', [stocksRawPositionsContract().key]],
    ['stocks-snapshot', [stocksPortfolioContract().key]],
    ['stocks-watch', [stocksFreshBreachesContract().key]],
  ]);
  const consumes = new Map<string, string[]>([
    ['stocks-snapshot', [stocksRawPositionsContract().key]],
    ['stocks-watch', [stocksPortfolioContract().key]],
    ['stocks-notify', [stocksFreshBreachesContract().key]],
  ]);
  const gates = deriveGates(dag, produces, consumes);
  assert.equal(gates.length, 3, JSON.stringify(gates));
  assert.ok(
    gates.some((g) => g.producer === 'stocks-fetch' && g.consumer === 'stocks-snapshot' && g.key === 'stocks-raw-positions'),
    'missing stocks-fetch → stocks-snapshot gate',
  );
  assert.ok(
    gates.some((g) => g.producer === 'stocks-snapshot' && g.consumer === 'stocks-watch' && g.key === 'stocks-portfolio'),
    'missing stocks-snapshot → stocks-watch gate',
  );
  assert.ok(
    gates.some(
      (g) => g.producer === 'stocks-watch' && g.consumer === 'stocks-notify' && g.key === 'stocks-fresh-breaches',
    ),
    'missing stocks-watch → stocks-notify gate',
  );
});

rmSync(dir, { recursive: true, force: true });
console.log(`  ${passed} assertions passed`);
