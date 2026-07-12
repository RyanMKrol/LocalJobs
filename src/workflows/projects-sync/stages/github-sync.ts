import { mkdirSync, writeFileSync } from 'fs';

import { callService } from '../../../core/services.js';
import type { CallServiceOpts } from '../../../core/services.js';
import { markWorkItem, workItemCounts } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';
import { projectsSyncConfig } from '../config.js';

const JOB_NAME = 'github-sync';
const GITHUB_API = 'https://api.github.com';

// ---------------------------------------------------------------------------
// Types matching the GitHub REST API repo shape
// ---------------------------------------------------------------------------

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  homepage: string | null;
  language: string | null;
  stargazers_count: number;
  forks_count: number;
  topics: string[];
  fork: boolean;
  archived: boolean;
  private: boolean;
  pushed_at: string | null;
  created_at: string;
  updated_at: string;
  default_branch: string;
}

/** The trimmed projection written to data/out/projects.json. */
export interface CatalogEntry {
  repoId: string;
  name: string;
  fullName: string;
  description: string;
  url: string;
  language: string;
  topics: string[];
  pushedAt: string;
  defaultBranch: string;
}

// ---------------------------------------------------------------------------
// Injectable fetch (real implementation uses globalThis.fetch; tests inject a stub)
// ---------------------------------------------------------------------------

export type ReposFetcher = (username: string, token: string) => Promise<GitHubRepo[]>;

/** Injectable so tests can spy on how many times a service-gated call is made,
 *  without depending on the real cross-process SQLite meter. Defaults to the
 *  real `callService`. */
export type ServiceCaller = <T>(name: string, fn: () => Promise<T>, opts?: CallServiceOpts) => Promise<T>;

export async function fetchAllRepos(
  username: string,
  token: string,
  callServiceFn: ServiceCaller = callService,
): Promise<GitHubRepo[]> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const all: GitHubRepo[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const url = `${GITHUB_API}/users/${username}/repos?per_page=${perPage}&page=${page}&sort=pushed&direction=desc`;
    // Gate EACH page fetch through the shared `github` service — a multi-page
    // catalog must reserve one rate/quota slot per request, not one for the
    // whole paginated fetch. Cache the read keyed by endpoint + page so repeated
    // fetches within 22 hours are served from cache.
    const repos = await callServiceFn('github', async () => {
      const res = await fetch(url, { headers });
      if (!res.ok) {
        throw new Error(`GitHub API error ${res.status}: ${await res.text()}`);
      }
      return (await res.json()) as GitHubRepo[];
    }, { cacheKey: `github:repos:${username}:page:${page}` });
    all.push(...repos);
    if (repos.length < perPage) break;
    page++;
  }

  return all;
}

// ---------------------------------------------------------------------------
// Filter + sort (mirrors the website's repos.js logic)
// ---------------------------------------------------------------------------

export function filterAndSortRepos(repos: GitHubRepo[]): GitHubRepo[] {
  return repos
    .filter((r) => !r.fork && !r.archived && !r.private)
    .sort((a, b) => {
      const aTime = a.pushed_at ?? a.created_at;
      const bTime = b.pushed_at ?? b.created_at;
      return bTime.localeCompare(aTime);
    });
}

export function repoToCatalogEntry(repo: GitHubRepo): CatalogEntry {
  return {
    repoId: String(repo.id),
    name: repo.name,
    fullName: repo.full_name,
    description: repo.description ?? '',
    url: repo.html_url,
    language: repo.language ?? '',
    topics: repo.topics ?? [],
    pushedAt: repo.pushed_at ?? repo.created_at,
    defaultBranch: repo.default_branch,
  };
}

// ---------------------------------------------------------------------------
// Catalog write (injectable for testing — avoids touching the real data dir)
// ---------------------------------------------------------------------------

export type CatalogWriter = (entries: CatalogEntry[]) => void;

export function writeCatalog(entries: CatalogEntry[]): void {
  mkdirSync(projectsSyncConfig.outDir, { recursive: true });
  writeFileSync(projectsSyncConfig.catalogPath, JSON.stringify(entries, null, 2));
}

/** Root stage (T094): each filtered repo id is an originating input. */
export function repoIdsFromCatalog(entries: CatalogEntry[]): string[] {
  return entries.map((e) => e.repoId);
}

// ---------------------------------------------------------------------------
// Core sync logic (injectable dependencies for hermeticity in tests)
// ---------------------------------------------------------------------------

export async function runGithubSync(
  ctx: JobContext,
  opts: {
    fetchRepos?: ReposFetcher;
    writeCatalog?: CatalogWriter;
  } = {},
): Promise<void> {
  const username = process.env.GITHUB_USERNAME ?? '';
  if (!username) throw new Error('GITHUB_USERNAME is not set');

  const token = process.env.GITHUB_TOKEN ?? '';

  const fetchRepos = opts.fetchRepos ?? fetchAllRepos;
  const writeCatalogFn = opts.writeCatalog ?? writeCatalog;

  ctx.log(`info: projects-sync starting — user: ${username}`);
  if (!token) ctx.log('warn: GITHUB_TOKEN not set — using unauthenticated requests (60 req/hr limit)');

  ctx.log('info: fetching repos from GitHub…');
  const allRepos = await fetchRepos(username, token);
  ctx.log(`info: fetched ${allRepos.length} total repos from GitHub`);

  const filtered = filterAndSortRepos(allRepos);
  ctx.log(
    `info: after filter (no forks, no archived, no private): ${filtered.length} repos to catalog` +
    ` (${allRepos.length - filtered.length} excluded)`,
  );

  const counts = workItemCounts(JOB_NAME);
  ctx.log(
    `info: ledger: ${counts['success'] ?? 0} previously synced, ${counts['failed'] ?? 0} failed`,
  );

  const entries = filtered.map(repoToCatalogEntry);
  writeCatalogFn(entries);
  ctx.log(`info: wrote ${entries.length} repos to data/out/projects.json`);

  if (entries.length === 0) {
    ctx.log('info: no repos to record — done');
    ctx.progress(100, 'no repos to record');
    return;
  }

  let done = 0;
  for (const entry of entries) {
    markWorkItem(JOB_NAME, entry.repoId, 'success', {
      detail: {
        name: entry.fullName,
        description: entry.description,
        language: entry.language,
        topics: entry.topics,
        url: entry.url,
        pushedAt: entry.pushedAt,
      },
    });
    done++;
    ctx.log(`info: recorded ${done}/${entries.length} — ${entry.fullName}`);
    ctx.progress((done / entries.length) * 100, `${done}/${entries.length} recorded`);
  }

  ctx.log(`info: projects-sync complete — recorded ${done} out of ${entries.length} repos`);
}

/**
 * Root stage inputKeys(): the repo ids GitHub reports RIGHT NOW, via a live API call —
 * NOT a read-back of `data/out/projects.json`. This stage is the SAME stage that writes
 * that catalog file, so reading it back is self-referential: a reset/fresh checkout with
 * no catalog file yet would return `[]` and make every repo look "already complete" to the
 * run-limit selector (T094), even though nothing has ever actually synced (T486).
 */
export async function githubSyncInputKeys(
  fetchRepos: ReposFetcher = fetchAllRepos,
): Promise<string[]> {
  const username = process.env.GITHUB_USERNAME ?? '';
  if (!username) return [];

  const token = process.env.GITHUB_TOKEN ?? '';

  try {
    const repos = await fetchRepos(username, token);
    return repoIdsFromCatalog(filterAndSortRepos(repos).map(repoToCatalogEntry));
  } catch {
    return [];
  }
}
