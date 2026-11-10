// Tests for the places artifact contracts (T027) and that they make the
// workflow executor derive gates. Run via `npm test`. (The perfumes workflow is
// on ports: its artifact checks are tested in src/workflows/perfumes/contracts.test.ts.)
//
// Contract checks are exercised against SYNTHETIC fixtures in a temp dir (the
// real data/ folders are gitignored and absent in CI) — NO live API/scrape.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArtifactContract, GateResult } from './types.js';
import { buildDag, deriveGates } from '../engine/dag.js';
import {
  enrichedPlacesContract,
  normalizedPlacesContract,
  resolvedPlacesContract,
} from '../workflows/places/contracts.js';

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

// These contracts' checks are all synchronous; assert + narrow the union.
function run(c: ArtifactContract): GateResult {
  const r = c.check();
  assert.ok(!(r instanceof Promise), 'contract check should be synchronous');
  return r;
}

const dir = mkdtempSync(join(tmpdir(), 'lj-contracts-'));
const f = (name: string) => join(dir, name);
const writeJson = (name: string, obj: unknown) => {
  const p = f(name);
  writeFileSync(p, JSON.stringify(obj));
  return p;
};

// ─────────────────────────── places: places-normalized ────────────────────────────
test('places-normalized: a non-empty Takeout-sourced places[] passes', () => {
  const p = writeJson('places-ok.json', {
    source: 'google-takeout',
    places: [{ name: 'Acme Fire Cult', cid: '123' }],
  });
  const r = run(normalizedPlacesContract(p));
  assert.equal(r.ok, true, r.violations?.join('; '));
});

test('places-normalized: an empty places[] fails (non-empty contract)', () => {
  const p = writeJson('places-empty.json', { source: 'google-takeout', places: [] });
  assert.equal(run(normalizedPlacesContract(p)).ok, false);
});

test('places-normalized: a wrong source fails (shape drift)', () => {
  const p = writeJson('places-drift.json', { source: 'something-else', places: [{ name: 'X' }] });
  assert.equal(run(normalizedPlacesContract(p)).ok, false);
});

// ─────────────────────────── places: resolved-place-ids ───────────────────────────
test('resolved-place-ids: a map with a place_id passes', () => {
  const p = writeJson('resolved-ok.json', {
    resolved: { '123': { cid: '123', placeId: 'ChIJabc', status: 'success' } },
  });
  const r = run(resolvedPlacesContract(p));
  assert.equal(r.ok, true, r.violations?.join('; '));
});

test('resolved-place-ids: an empty map fails', () => {
  const p = writeJson('resolved-empty.json', { resolved: {} });
  assert.equal(run(resolvedPlacesContract(p)).ok, false);
});

test('resolved-place-ids: no entry with a place_id fails (shape drift)', () => {
  const p = writeJson('resolved-drift.json', {
    resolved: { '123': { cid: '123', placeId: null, status: 'error' } },
  });
  assert.equal(run(resolvedPlacesContract(p)).ok, false);
});

// ─────────────────────────── places: enriched-places ──────────────────────────────
test('enriched-places: a map with a place_id passes', () => {
  const p = writeJson('enriched-ok.json', {
    enriched: { '123': { cid: '123', placeId: 'ChIJabc', status: 'success' } },
  });
  const r = run(enrichedPlacesContract(p));
  assert.equal(r.ok, true, r.violations?.join('; '));
});

test('enriched-places: an empty map fails', () => {
  const p = writeJson('enriched-empty.json', { enriched: {} });
  assert.equal(run(enrichedPlacesContract(p)).ok, false);
});

// ─────────────── gates DERIVE + FIRE: keys wire up across each workflow edge ───────
// Mirror the keys declared on the real jobs (verified statically by tsc) and prove
// deriveGates yields one gate per stage boundary — i.e. the workflow start-log
// gate count is > 0.
test('places: gates derive between every stage (count > 0)', () => {
  const dag = buildDag([
    { job: 'places-ingest' },
    { job: 'cid-to-place-id-resolver', dependsOn: ['places-ingest'] },
    { job: 'places-enrich', dependsOn: ['cid-to-place-id-resolver'] },
    { job: 'enrich-with-llm', dependsOn: ['places-enrich'] },
  ]);
  const produces = new Map<string, string[]>([
    ['places-ingest', ['places-normalized']],
    ['cid-to-place-id-resolver', ['resolved-place-ids']],
    ['places-enrich', ['enriched-places']],
    ['enrich-with-llm', []],
  ]);
  const consumes = new Map<string, string[]>([
    ['places-ingest', []],
    ['cid-to-place-id-resolver', ['places-normalized']],
    ['places-enrich', ['resolved-place-ids']],
    ['enrich-with-llm', ['enriched-places']],
  ]);
  const gates = deriveGates(dag, produces, consumes);
  assert.equal(gates.length, 3);
  assert.deepEqual(gates.map((g) => g.key), ['places-normalized', 'resolved-place-ids', 'enriched-places']);
});

// ───────── expected shape + expected-vs-actual reporting (T065) ─────────
// Every contract declares a machine-readable `shape` for the gate page, and a
// passing check returns per-expectation `checks` (aligned by label) + a `sample`.
const allContracts: Array<[string, ArtifactContract]> = [
  ['places-normalized', normalizedPlacesContract()],
  ['resolved-place-ids', resolvedPlacesContract()],
  ['enriched-places', enrichedPlacesContract()],
];

test('every contract declares a shape with a summary + non-empty expectations', () => {
  for (const [key, c] of allContracts) {
    assert.ok(c.shape, `${key} has no shape`);
    assert.ok(c.shape!.summary.length > 0, `${key} shape has no summary`);
    assert.ok(c.shape!.expectations.length > 0, `${key} shape has no expectations`);
  }
});

test('a passing check reports per-expectation results aligned to the shape + a sample', () => {
  const p = writeJson('shape-ok.json', {
    source: 'google-takeout',
    places: [{ name: 'Acme Fire Cult', cid: '123' }],
  });
  const c = normalizedPlacesContract(p);
  const r = run(c);
  assert.equal(r.ok, true, r.violations?.join('; '));
  assert.ok(Array.isArray(r.checks) && r.checks.length > 0, 'no checks reported');
  assert.ok(r.checks!.every((ch) => ch.ok), 'a passing check has a failed expectation');
  // Every reported check label is a declared expectation (alignment holds).
  const labels = new Set(c.shape!.expectations.map((e) => e.label));
  for (const ch of r.checks!) assert.ok(labels.has(ch.label), `check label "${ch.label}" not in shape`);
  assert.ok(r.sample && r.sample.includes('Acme Fire Cult'), `sample missing actual data: ${r.sample}`);
});

test('a failing check marks the offending expectation ok:false (expected-vs-actual)', () => {
  const p = writeJson('shape-drift.json', { source: 'something-else', places: [{ name: 'X' }] });
  const c = normalizedPlacesContract(p);
  const r = run(c);
  assert.equal(r.ok, false);
  const sourceExp = c.shape!.expectations.find((e) => /takeout/i.test(e.label))!;
  const sourceCheck = r.checks!.find((ch) => ch.label === sourceExp.label);
  assert.ok(sourceCheck && sourceCheck.ok === false, 'source expectation not reported as failed');
  assert.ok(sourceCheck!.actual && sourceCheck!.actual.includes('something-else'), 'actual value not surfaced');
});

// Assert the contract `key`s the jobs actually use match the keys the gate
// derivation above relies on — so a rename can't silently break wiring.
test('contract keys are stable + match the workflow wiring', () => {
  assert.equal(normalizedPlacesContract().key, 'places-normalized');
  assert.equal(resolvedPlacesContract().key, 'resolved-place-ids');
  assert.equal(enrichedPlacesContract().key, 'enriched-places');
});

rmSync(dir, { recursive: true, force: true });
console.log(`  ${passed} assertions passed`);
