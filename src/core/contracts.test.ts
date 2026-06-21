// Tests for the real-job artifact contracts (T027) and that they make the
// pipeline executor derive gates. Run via `npm test`.
//
// Contract checks are exercised against SYNTHETIC fixtures in a temp dir (the
// real data/ folders are gitignored and absent in CI) — NO live API/scrape.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArtifactContract, GateResult } from './types.js';
import { buildDag, deriveGates } from './dag.js';
import {
  fragranticaDataContract,
  fragranticaPagesContract,
  fragranticaUrlsContract,
} from '../jobs/perfumes/contracts.js';
import {
  enrichedPlacesContract,
  normalizedPlacesContract,
  resolvedPlacesContract,
} from '../jobs/places/contracts.js';

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

// ─────────────────────────── perfumes: fragrantica-urls ───────────────────────────
test('fragrantica-urls: a well-formed id→URL map passes', () => {
  const p = writeJson('urls-ok.json', {
    'amouage-beach-hut-man': 'https://www.fragrantica.com/perfume/Amouage/Beach-Hut-Man-46336.html',
  });
  const r = run(fragranticaUrlsContract(p));
  assert.equal(r.ok, true, r.violations?.join('; '));
});

test('fragrantica-urls: an empty map fails (non-empty contract)', () => {
  const p = writeJson('urls-empty.json', {});
  assert.equal(run(fragranticaUrlsContract(p)).ok, false);
});

test('fragrantica-urls: a non-Fragrantica URL fails (shape drift)', () => {
  const p = writeJson('urls-drift.json', { x: 'https://example.com/whatever' });
  assert.equal(run(fragranticaUrlsContract(p)).ok, false);
});

test('fragrantica-urls: a missing file fails', () => {
  assert.equal(run(fragranticaUrlsContract(f('nope.json'))).ok, false);
});

// ─────────────────────────── perfumes: fragrantica-pages ──────────────────────────
test('fragrantica-pages: a dir with a non-empty .txt passes', () => {
  const d = join(dir, 'pages-ok');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'a.txt'), 'real captured page text');
  const r = run(fragranticaPagesContract(d));
  assert.equal(r.ok, true, r.violations?.join('; '));
});

test('fragrantica-pages: an empty dir fails', () => {
  const d = join(dir, 'pages-empty');
  mkdirSync(d, { recursive: true });
  assert.equal(run(fragranticaPagesContract(d)).ok, false);
});

test('fragrantica-pages: only empty .txt files fails (non-empty contract)', () => {
  const d = join(dir, 'pages-zero');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'a.txt'), '');
  assert.equal(run(fragranticaPagesContract(d)).ok, false);
});

// ─────────────────────────── perfumes: fragrantica-data ───────────────────────────
test('fragrantica-data: a parsed perfume with name + notes passes', () => {
  const d = join(dir, 'data-ok');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'a.json'), JSON.stringify({ name: 'Beach Hut Man', notes: { top: ['Mint'] } }));
  const r = run(fragranticaDataContract(d));
  assert.equal(r.ok, true, r.violations?.join('; '));
});

test('fragrantica-data: records missing name fail (shape drift)', () => {
  const d = join(dir, 'data-drift');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'a.json'), JSON.stringify({ notes: { top: ['Mint'] } }));
  assert.equal(run(fragranticaDataContract(d)).ok, false);
});

test('fragrantica-data: an empty dir fails', () => {
  const d = join(dir, 'data-empty');
  mkdirSync(d, { recursive: true });
  assert.equal(run(fragranticaDataContract(d)).ok, false);
});

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

// ─────────────── gates DERIVE + FIRE: keys wire up across each pipeline edge ───────
// Mirror the keys declared on the real jobs (verified statically by tsc) and prove
// deriveGates yields one gate per stage boundary — i.e. the pipeline start-log
// gate count is > 0.
test('perfumes: gates derive between every stage (count > 0)', () => {
  const dag = buildDag([
    { job: 'perfumes-find-url' },
    { job: 'perfumes-fetch', dependsOn: ['perfumes-find-url'] },
    { job: 'perfumes-parse', dependsOn: ['perfumes-fetch'] },
    { job: 'perfumes-build', dependsOn: ['perfumes-parse'] },
  ]);
  const produces = new Map<string, string[]>([
    ['perfumes-find-url', ['fragrantica-urls']],
    ['perfumes-fetch', ['fragrantica-pages']],
    ['perfumes-parse', ['fragrantica-data']],
    ['perfumes-build', []],
  ]);
  const consumes = new Map<string, string[]>([
    ['perfumes-find-url', []],
    ['perfumes-fetch', ['fragrantica-urls']],
    ['perfumes-parse', ['fragrantica-pages']],
    ['perfumes-build', ['fragrantica-data']],
  ]);
  const gates = deriveGates(dag, produces, consumes);
  assert.equal(gates.length, 3);
  assert.deepEqual(gates.map((g) => g.key), ['fragrantica-urls', 'fragrantica-pages', 'fragrantica-data']);
});

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

// Assert the contract `key`s the jobs actually use match the keys the gate
// derivation above relies on — so a rename can't silently break wiring.
test('contract keys are stable + match the pipeline wiring', () => {
  assert.equal(fragranticaUrlsContract().key, 'fragrantica-urls');
  assert.equal(fragranticaPagesContract().key, 'fragrantica-pages');
  assert.equal(fragranticaDataContract().key, 'fragrantica-data');
  assert.equal(normalizedPlacesContract().key, 'places-normalized');
  assert.equal(resolvedPlacesContract().key, 'resolved-place-ids');
  assert.equal(enrichedPlacesContract().key, 'enriched-places');
});

rmSync(dir, { recursive: true, force: true });
console.log(`  ${passed} assertions passed`);
