// Tests for the stock-digest artifact contract (T369) and that it makes the
// workflow executor derive a gate. Run via `npm test`.
//
// Contract checks are exercised against SYNTHETIC fixtures in a temp dir — NO
// live Finnhub API call.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArtifactContract, GateResult } from '../../core/types.js';
import { buildDag, deriveGates } from '../../core/dag.js';
import { stockDigestPortfolioContract, stockRawPortfolioContract, stockSectorsContract } from './contracts.js';

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

const dir = mkdtempSync(join(tmpdir(), 'lj-stock-digest-contracts-'));
const f = (name: string) => join(dir, name);
const writeJson = (name: string, obj: unknown) => {
  const p = f(name);
  writeFileSync(p, JSON.stringify(obj));
  return p;
};

// ─────────────────────────── stock-sectors ───────────────────────────

test('stock-sectors: missing file is ok (optional — FINNHUB_API_KEY may be unset)', () => {
  const c = stockSectorsContract(f('nope-sectors.json'));
  const r = run(c);
  assert.equal(r.ok, true);
});

test('stock-sectors: empty object is ok (nothing resolved yet)', () => {
  const p = writeJson('sectors-empty.json', {});
  const r = run(stockSectorsContract(p));
  assert.equal(r.ok, true);
});

test('stock-sectors: well-formed non-empty object is ok', () => {
  const p = writeJson('sectors-good.json', { AAPL: 'Technology', AMD: null });
  const r = run(stockSectorsContract(p));
  assert.equal(r.ok, true);
});

test('stock-sectors: invalid JSON fails', () => {
  const p = f('sectors-bad.json');
  writeFileSync(p, '{not json');
  const r = run(stockSectorsContract(p));
  assert.equal(r.ok, false);
  assert.ok(r.violations && r.violations.length > 0);
});

test('stock-sectors: top-level array fails', () => {
  const p = f('sectors-array.json');
  writeFileSync(p, JSON.stringify(['AAPL', 'AMD']));
  const r = run(stockSectorsContract(p));
  assert.equal(r.ok, false);
});

test('stock-sectors: non-string/non-null value fails', () => {
  const p = writeJson('sectors-badval.json', { AAPL: 123 });
  const r = run(stockSectorsContract(p));
  assert.equal(r.ok, false);
});

// ────────────────────────── stock-raw-portfolio ──────────────────────────

test('stock-raw-portfolio: missing file fails (not optional — this stage always writes it)', () => {
  const c = stockRawPortfolioContract(f('nope-raw-portfolio.json'));
  const r = run(c);
  assert.equal(r.ok, false);
});

test('stock-raw-portfolio: empty array is ok (every position sold)', () => {
  const p = writeJson('raw-portfolio-empty.json', []);
  const r = run(stockRawPortfolioContract(p));
  assert.equal(r.ok, true);
});

test('stock-raw-portfolio: well-formed non-empty array is ok', () => {
  const p = writeJson('raw-portfolio-good.json', [{ ticker: 'AAPL_US_EQ', account: 'invest' }]);
  const r = run(stockRawPortfolioContract(p));
  assert.equal(r.ok, true);
});

test('stock-raw-portfolio: invalid JSON fails', () => {
  const p = f('raw-portfolio-bad.json');
  writeFileSync(p, '{not json');
  const r = run(stockRawPortfolioContract(p));
  assert.equal(r.ok, false);
});

test('stock-raw-portfolio: top-level object (not array) fails', () => {
  const p = writeJson('raw-portfolio-obj.json', { ticker: 'AAPL_US_EQ' });
  const r = run(stockRawPortfolioContract(p));
  assert.equal(r.ok, false);
});

test('stock-raw-portfolio: entry missing ticker/account fails', () => {
  const p = writeJson('raw-portfolio-badentry.json', [{ ticker: 'AAPL_US_EQ' }]);
  const r = run(stockRawPortfolioContract(p));
  assert.equal(r.ok, false);
});

// ────────────────────── stock-digest-portfolio ──────────────────────

test('stock-digest-portfolio: missing file fails (not optional — this stage always writes it)', () => {
  const c = stockDigestPortfolioContract(f('nope-portfolio.json'));
  const r = run(c);
  assert.equal(r.ok, false);
});

test('stock-digest-portfolio: empty array is ok (every position sold)', () => {
  const p = writeJson('portfolio-empty.json', []);
  const r = run(stockDigestPortfolioContract(p));
  assert.equal(r.ok, true);
});

test('stock-digest-portfolio: well-formed non-empty array is ok', () => {
  const p = writeJson('portfolio-good.json', [{ ticker: 'AAPL_US_EQ', account: 'invest' }]);
  const r = run(stockDigestPortfolioContract(p));
  assert.equal(r.ok, true);
});

test('stock-digest-portfolio: invalid JSON fails', () => {
  const p = f('portfolio-bad.json');
  writeFileSync(p, '{not json');
  const r = run(stockDigestPortfolioContract(p));
  assert.equal(r.ok, false);
});

test('stock-digest-portfolio: top-level object (not array) fails', () => {
  const p = writeJson('portfolio-obj.json', { ticker: 'AAPL_US_EQ' });
  const r = run(stockDigestPortfolioContract(p));
  assert.equal(r.ok, false);
});

test('stock-digest-portfolio: entry missing ticker/account fails', () => {
  const p = writeJson('portfolio-badentry.json', [{ ticker: 'AAPL_US_EQ' }]);
  const r = run(stockDigestPortfolioContract(p));
  assert.equal(r.ok, false);
});

// ─────────────────────────── DAG gates ───────────────────────────

test('stock-digest: gate derives at every edge of the 4-stage fan-in DAG (count == 4)', () => {
  const dag = buildDag([
    { job: 'stock-portfolio-fetch' },
    { job: 'stock-portfolio-snapshot', dependsOn: ['stock-portfolio-fetch'] },
    { job: 'stock-sector-lookup', dependsOn: ['stock-portfolio-snapshot'] },
    { job: 'stock-digest-build', dependsOn: ['stock-portfolio-snapshot', 'stock-sector-lookup'] },
  ]);
  const produces = new Map<string, string[]>([
    ['stock-portfolio-fetch', ['stock-raw-portfolio']],
    ['stock-portfolio-snapshot', ['stock-digest-portfolio']],
    ['stock-sector-lookup', ['stock-sectors']],
    ['stock-digest-build', []],
  ]);
  const consumes = new Map<string, string[]>([
    ['stock-portfolio-fetch', []],
    ['stock-portfolio-snapshot', ['stock-raw-portfolio']],
    ['stock-sector-lookup', ['stock-digest-portfolio']],
    ['stock-digest-build', ['stock-digest-portfolio', 'stock-sectors']],
  ]);
  const gates = deriveGates(dag, produces, consumes);
  assert.equal(gates.length, 4);
  assert.deepEqual(
    gates.map((g) => `${g.producer}->${g.consumer}:${g.key}`).sort(),
    [
      'stock-portfolio-fetch->stock-portfolio-snapshot:stock-raw-portfolio',
      'stock-portfolio-snapshot->stock-digest-build:stock-digest-portfolio',
      'stock-portfolio-snapshot->stock-sector-lookup:stock-digest-portfolio',
      'stock-sector-lookup->stock-digest-build:stock-sectors',
    ].sort(),
  );
});

rmSync(dir, { recursive: true, force: true });

console.log(`\n${passed} stock-digest contract test(s) passed`);
if (process.exitCode) process.exit(process.exitCode);
