// The perfumes artifact types: what each check accepts and rejects, and that the
// real stages bind to each other the way the manifest says. Synthetic fixtures
// in a temp dir; no live call.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { bindWorkflowPorts, validateWorkflowContracts } from '../../engine/ports.js';
import type { JobDefinition } from '../../engine/index.js';
import { fragranticaData, fragranticaPages, fragranticaUrls, perfumeProfiles } from './contracts.js';
import workflow from './perfumes.workflow.js';
import findUrl from './stages/find-url.job.js';
import fetch from './stages/fetch.job.js';
import parse from './stages/parse.job.js';
import build from './stages/build.job.js';

const root = mkdtempSync(join(tmpdir(), 'lj-perfumes-contracts-'));
after(() => rmSync(root, { recursive: true, force: true }));
const dir = (name: string, files: Record<string, string> = {}) => {
  const d = join(root, name);
  mkdirSync(d, { recursive: true });
  for (const [f, body] of Object.entries(files)) writeFileSync(join(d, f), body);
  return d;
};

test('fragrantica-urls: a map of Fragrantica URLs passes, and so does an empty one (nothing resolved yet)', () => {
  const ok = fragranticaUrls.check({ a: 'https://www.fragrantica.com/perfume/Amouage/Beach-Hut-Man-46336.html' });
  assert.equal(ok.ok, true, ok.violations?.join('; '));
  assert.equal(fragranticaUrls.check({}).ok, true);
  assert.equal(fragranticaUrls.summary!({ a: 'x', b: 'y' }), '2 URL(s)');
});

test('fragrantica-urls: a value that is not a Fragrantica URL fails, naming the entry', () => {
  const r = fragranticaUrls.check({ x: 'https://example.com/whatever' });
  assert.equal(r.ok, false);
  assert.match(r.violations!.join(' '), /entry "x"/);
  assert.equal(fragranticaUrls.check([] as unknown as Record<string, string>).ok, false, 'an array is not an id to url map');
});

test('fragrantica-pages: captured pages pass, an empty folder passes, an empty capture fails', () => {
  const ok = fragranticaPages.read(dir('pages-ok', { 'a.txt': 'real captured page text', 'a.html': '<html></html>' }));
  assert.equal(fragranticaPages.check(ok).ok, true);
  assert.equal(fragranticaPages.count!(ok), 1, 'the .html beside a capture is not counted as a page');
  assert.equal(fragranticaPages.check(fragranticaPages.read(dir('pages-none'))).ok, true);
  const bad = fragranticaPages.check(fragranticaPages.read(dir('pages-zero', { 'a.txt': '' })));
  assert.equal(bad.ok, false);
  assert.match(bad.violations!.join(' '), /a\.txt/);
});

test('fragrantica-data: one well-formed record is enough; only shapeless records fails', () => {
  const good = JSON.stringify({ name: 'Beach Hut Man', notes: { top: ['Mint'] } });
  const shapeless = JSON.stringify({ notes: { top: ['Mint'] } });
  assert.equal(fragranticaData.check(fragranticaData.read(dir('data-ok', { 'a.json': shapeless, 'b.json': good }))).ok, true);
  assert.equal(fragranticaData.check(fragranticaData.read(dir('data-none'))).ok, true, 'nothing parsed yet is not drift');
  const bad = fragranticaData.check(fragranticaData.read(dir('data-drift', { 'a.json': shapeless })));
  assert.equal(bad.ok, false);
  assert.match(bad.violations!.join(' '), /a\.json: missing or empty "name"/);
  assert.equal(fragranticaData.check(fragranticaData.read(dir('data-broken', { 'a.json': '{not json' }))).ok, false);
});

test('perfume-profiles: every profile must open with frontmatter', () => {
  const ok = perfumeProfiles.read(dir('md-ok', { 'a.md': '---\nname: A\n---\n# A\n' }));
  assert.equal(perfumeProfiles.check(ok).ok, true);
  assert.deepEqual(perfumeProfiles.items!(ok).map((i) => i.id), ['a']);
  assert.equal(perfumeProfiles.check(perfumeProfiles.read(dir('md-bad', { 'a.md': 'Here is your profile:\n---\n' }))).ok, false);
});

test('the stages bind as the manifest says: build takes the parsed data from parse and the URLs from find-url', () => {
  const jobs = new Map<string, JobDefinition>([findUrl, fetch, parse, build].map((j) => [j.name, j]));
  const getJob = (name: string) => jobs.get(name);
  assert.deepEqual(validateWorkflowContracts(workflow, getJob), []);
  const { bindings } = bindWorkflowPorts(workflow, getJob);
  const edges = bindings.map((b) => `${b.producer} -> ${b.consumer}.${b.port}`).sort();
  assert.deepEqual(edges, [
    'perfumes-fetch -> perfumes-parse.pages',
    'perfumes-find-url -> perfumes-build.urls',
    'perfumes-find-url -> perfumes-fetch.urls',
    'perfumes-parse -> perfumes-build.data',
  ]);
});
