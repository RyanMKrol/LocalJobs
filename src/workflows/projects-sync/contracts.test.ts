// The projects-sync artifact checks, and that the two stages bind as the manifest says.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindWorkflowPorts, validateWorkflowContracts } from '../../engine/ports.js';
import type { JobDefinition } from '../../engine/index.js';
import { projectsCatalog } from './contracts.js';
import workflow from './projects-sync.workflow.js';
import type { CatalogEntry } from './stages/github-sync.js';
import githubSync from './stages/github-sync.job.js';
import summarize from './stages/project-summarize.job.js';

const entry = (over: Partial<CatalogEntry> = {}): CatalogEntry => ({
  repoId: '1', name: 'local-jobs', fullName: 'owner/local-jobs', description: 'A job runner', url: 'https://github.com/owner/local-jobs',
  language: 'TypeScript', topics: [], pushedAt: '2026-06-01T00:00:00Z', defaultBranch: 'main', ...over,
});

test('projects-catalog: a non-empty array of well-formed entries passes', () => {
  const r = projectsCatalog.check([entry()]);
  assert.equal(r.ok, true, r.violations?.join('; '));
  assert.equal(projectsCatalog.summary!([entry(), entry({ repoId: '2', name: 'other' })]), '2 repo(s)');
});

test('projects-catalog: an empty catalog, a non-array, and an entry with no repoId all fail', () => {
  assert.equal(projectsCatalog.check([]).ok, false, 'GitHub returning no repos is treated as a problem, not as the truth');
  assert.equal(projectsCatalog.check({ repos: [] } as unknown as CatalogEntry[]).ok, false);
  assert.equal(projectsCatalog.check([entry({ repoId: '' })]).ok, false);
});

test('the summarize stage is handed the catalog by the sync stage', () => {
  const jobs = new Map<string, JobDefinition>([githubSync, summarize].map((j) => [j.name, j]));
  const getJob = (name: string) => jobs.get(name);
  assert.deepEqual(validateWorkflowContracts(workflow, getJob), []);
  assert.deepEqual(
    bindWorkflowPorts(workflow, getJob).bindings.map((b) => `${b.producer} -> ${b.consumer}.${b.port}`),
    ['github-sync -> project-summarize.catalog'],
  );
});
