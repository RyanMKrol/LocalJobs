// The data the projects-sync stages hand to each other.
//
//   github-sync ──catalog──▶ project-summarize ──▶ summaries
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { dirArtifact, fromChecks, jsonArtifact } from '../../engine/index.js';
import type { CatalogEntry } from './stages/github-sync.js';

/** The owner's public, non-fork, non-archived GitHub repos, rebuilt from GitHub every run. */
export const projectsCatalog = jsonArtifact<CatalogEntry[]>({
  key: 'projects-catalog',
  description: 'The catalog of the owner\'s GitHub repos: one entry per repo, most recently pushed first.',
  shape: {
    summary: 'The catalog of GitHub repos to summarize.',
    format: 'JSON array of catalog entries (projects.json)',
    expectations: [
      { label: 'A JSON array', detail: 'The file is a JSON array of catalog entries.' },
      { label: 'Contains at least one repo', detail: 'A non-empty array. Otherwise there is nothing to summarize, and GitHub returning no repos at all is far more likely an API problem than the truth.' },
      { label: 'Every entry has a repoId and a name', detail: 'Each entry carries a text repoId and name.' },
    ],
  },
  check(v) {
    if (!Array.isArray(v)) return fromChecks([{ label: 'A JSON array', ok: false, actual: typeof v }]);
    const bad = v.find((e) => !e || typeof e.repoId !== 'string' || !e.repoId || typeof e.name !== 'string' || !e.name);
    return fromChecks([
      { label: 'A JSON array', ok: true, actual: 'array' },
      { label: 'Contains at least one repo', ok: v.length > 0, actual: `${v.length} repo(s)` },
      { label: 'Every entry has a repoId and a name', ok: !bad, actual: bad ? `bad entry: ${JSON.stringify(bad).slice(0, 200)}` : 'all entries well-formed' },
    ], `${v.length} repo(s)`);
  },
  summary: (v) => `${v.length} repo(s)`,
  items: (v) => v.map((e) => ({
    id: e.repoId,
    title: e.fullName,
    subtitle: e.description ?? undefined,
    fields: [
      ...(e.language ? [{ label: 'Language', value: e.language }] : []),
      { label: 'Pushed', value: String(e.pushedAt).slice(0, 10) },
    ],
  })),
});


/** One markdown profile per repo. A repo is re-summarized only when it has been pushed to. */
export const projectSummaries = dirArtifact({
  key: 'project-summaries',
  description: 'The markdown profile of each repo: <repo>.md.',
  format: 'markdown',
  // The profiles share data/out with the catalog (projects.json): only the .md files are this artifact.
  files: (name) => name.endsWith('.md'),
  check(d) {
    const empty = d.files.filter((f) => statSync(join(d.path, f)).size === 0);
    return fromChecks([{ label: 'no profile is empty', ok: empty.length === 0, actual: empty.length ? `empty: ${empty.join(', ')}` : `${d.files.length} profile(s)` }], `${d.files.length} profile(s)`);
  },
  count: (d) => d.files.length,
  summary: (d) => `${d.files.length} profile(s)`,
  items: (d) => d.files.map((f) => ({ id: f, title: f.replace(/\.md$/, ''), preview: { path: join(d.path, f), format: 'markdown' } })),
});
