// Tests for the projects-sync workflow's artifact contract (T367) — the
// github-sync -> project-summarize boundary. Run via `npm test`.
//
// Contract checks are exercised against SYNTHETIC fixtures in a temp dir — NO
// live GitHub API call and NO real clone.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDag, deriveGates } from '../../core/dag.js';
import { projectsCatalogContract } from './contracts.js';

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

const dir = mkdtempSync(join(tmpdir(), 'lj-projects-sync-contracts-'));
const f = (name: string) => join(dir, name);
const writeJson = (name: string, obj: unknown) => {
  const p = f(name);
  writeFileSync(p, JSON.stringify(obj));
  return p;
};

const entry = (repoId: string, name: string) => ({
  repoId,
  name,
  fullName: `owner/${name}`,
  description: 'a repo',
  url: `https://github.com/owner/${name}`,
  language: 'TypeScript',
  topics: [],
  pushedAt: '2026-01-01T00:00:00Z',
  defaultBranch: 'main',
});

test('projects-catalog: a well-formed non-empty array passes', () => {
  const p = writeJson('catalog-ok.json', [entry('1', 'repo-a'), entry('2', 'repo-b')]);
  const r = projectsCatalogContract(p).check();
  assert.ok(!(r instanceof Promise));
  assert.equal(r.ok, true, r.violations?.join('; '));
  assert.ok(r.sample?.includes('2 repo'));
});

test('projects-catalog: missing file fails', () => {
  const r = projectsCatalogContract(f('missing.json')).check();
  assert.ok(!(r instanceof Promise));
  assert.equal(r.ok, false);
  assert.ok(r.violations?.some((v) => v.includes('file missing')));
});

test('projects-catalog: invalid JSON fails', () => {
  const p = f('bad.json');
  writeFileSync(p, '{ not json');
  const r = projectsCatalogContract(p).check();
  assert.ok(!(r instanceof Promise));
  assert.equal(r.ok, false);
  assert.ok(r.violations?.some((v) => v.toLowerCase().includes('not valid json')));
});

test('projects-catalog: non-array top-level fails', () => {
  const p = writeJson('not-array.json', { foo: 'bar' });
  const r = projectsCatalogContract(p).check();
  assert.ok(!(r instanceof Promise));
  assert.equal(r.ok, false);
  assert.ok(r.violations?.some((v) => v.includes('array')));
});

test('projects-catalog: empty array fails', () => {
  const p = writeJson('empty.json', []);
  const r = projectsCatalogContract(p).check();
  assert.ok(!(r instanceof Promise));
  assert.equal(r.ok, false);
  assert.ok(r.violations?.some((v) => v.includes('0 entr')));
});

test('projects-catalog: an entry missing repoId/name fails', () => {
  const p = writeJson('bad-entry.json', [entry('1', 'repo-a'), { ...entry('2', 'repo-b'), repoId: '' }]);
  const r = projectsCatalogContract(p).check();
  assert.ok(!(r instanceof Promise));
  assert.equal(r.ok, false);
  assert.ok(r.violations?.some((v) => v.includes('repoId or name')));
});

// ─────────── gates DERIVE: exactly 1 gate for the github-sync -> project-summarize edge ───────────
// Direct regression guard for the bug the owner reported: this workflow's run
// showing no gate at all.
test('projects-sync: exactly 1 gate derives between github-sync and project-summarize', () => {
  const dag = buildDag([
    { job: 'github-sync' },
    { job: 'project-summarize', dependsOn: ['github-sync'] },
  ]);
  const produces = new Map<string, string[]>([
    ['github-sync', ['projects-catalog']],
    ['project-summarize', []],
  ]);
  const consumes = new Map<string, string[]>([
    ['github-sync', []],
    ['project-summarize', ['projects-catalog']],
  ]);
  const gates = deriveGates(dag, produces, consumes);
  assert.equal(gates.length, 1);
  assert.deepEqual(gates.map((g) => g.key), ['projects-catalog']);
});

console.log(`\n${passed} test(s) passed in contracts.test.ts (projects-sync)`);
