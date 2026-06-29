import { callService } from '../../../core/services.js';
import { markWorkItem, workItemCounts } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';
import { dynamoPut } from '../../../services/dynamodb.service.js';

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
}

export interface ProjectsTableItem {
  repoId: string;
  name: string;
  fullName: string;
  description: string;
  url: string;
  homepage: string;
  language: string;
  stars: number;
  forks: number;
  topics: string[];
  pushedAt: string;
  createdAt: string;
  updatedAt: string;
  syncedAt: string;
}

// ---------------------------------------------------------------------------
// Injectable fetch (real implementation uses globalThis.fetch; tests inject a stub)
// ---------------------------------------------------------------------------

export type ReposFetcher = (username: string, token: string) => Promise<GitHubRepo[]>;

export async function fetchAllRepos(username: string, token: string): Promise<GitHubRepo[]> {
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
    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`GitHub API error ${res.status}: ${await res.text()}`);
    }
    const repos = (await res.json()) as GitHubRepo[];
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

// ---------------------------------------------------------------------------
// DynamoDB write helper (injectable for testing)
// ---------------------------------------------------------------------------

export type DynamoPutter = (table: string, item: Record<string, unknown>) => Promise<void>;

export function repoToTableItem(repo: GitHubRepo, syncedAt: string): ProjectsTableItem {
  return {
    repoId: String(repo.id),
    name: repo.name,
    fullName: repo.full_name,
    description: repo.description ?? '',
    url: repo.html_url,
    homepage: repo.homepage ?? '',
    language: repo.language ?? '',
    stars: repo.stargazers_count,
    forks: repo.forks_count,
    topics: repo.topics ?? [],
    pushedAt: repo.pushed_at ?? repo.created_at,
    createdAt: repo.created_at,
    updatedAt: repo.updated_at,
    syncedAt,
  };
}

// ---------------------------------------------------------------------------
// Core sync logic (injectable dependencies for hermeticity in tests)
// ---------------------------------------------------------------------------

export async function runGithubSync(
  ctx: JobContext,
  opts: {
    fetchRepos?: ReposFetcher;
    putItem?: DynamoPutter;
    projectsTable?: string;
    syncedAt?: string;
  } = {},
): Promise<void> {
  const username = process.env.GITHUB_USERNAME ?? '';
  if (!username) throw new Error('GITHUB_USERNAME is not set');

  const token = process.env.GITHUB_TOKEN ?? '';
  const projectsTable = opts.projectsTable ?? process.env.PROJECTS_TABLE ?? 'Projects';
  const syncedAt = opts.syncedAt ?? new Date().toISOString();

  const fetchRepos = opts.fetchRepos ?? ((u, t) => callService('github', () => fetchAllRepos(u, t)));
  const putItem = opts.putItem ?? ((t, i) => callService('dynamodb', () => dynamoPut(t, i)));

  ctx.log(`info: projects-sync starting — user: ${username}, table: ${projectsTable}`);
  if (!token) ctx.log('warn: GITHUB_TOKEN not set — using unauthenticated requests (60 req/hr limit)');

  ctx.log('info: fetching repos from GitHub…');
  const allRepos = await fetchRepos(username, token);
  ctx.log(`info: fetched ${allRepos.length} total repos from GitHub`);

  const filtered = filterAndSortRepos(allRepos);
  ctx.log(
    `info: after filter (no forks, no archived, no private): ${filtered.length} repos to upsert` +
    ` (${allRepos.length - filtered.length} excluded)`,
  );

  const counts = workItemCounts(JOB_NAME);
  ctx.log(
    `info: ledger: ${counts['success'] ?? 0} previously synced, ${counts['failed'] ?? 0} failed`,
  );

  if (filtered.length === 0) {
    ctx.log('info: no repos to upsert — done');
    ctx.progress(100, 'no repos to upsert');
    return;
  }

  let done = 0;
  let failed = 0;

  for (const repo of filtered) {
    const repoId = String(repo.id);
    ctx.log(`info: upserting repo ${repoId} "${repo.name}" (stars=${repo.stargazers_count})`);
    try {
      const item = repoToTableItem(repo, syncedAt);
      await putItem(projectsTable, item as unknown as Record<string, unknown>);
      markWorkItem(JOB_NAME, repoId, 'success');
      done++;
      ctx.log(`info: upserted ${done}/${filtered.length} — ${repo.full_name}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.log(`error: failed to upsert repo ${repoId} "${repo.name}": ${msg}`);
      markWorkItem(JOB_NAME, repoId, 'failed');
      failed++;
    }
    ctx.progress(((done + failed) / filtered.length) * 100, `${done}/${filtered.length} upserted`);
  }

  ctx.log(
    `info: projects-sync complete — upserted ${done}, failed ${failed} out of ${filtered.length} repos`,
  );

  if (failed > 0) {
    throw new Error(`${failed} repo(s) failed to upsert — see logs above`);
  }
}
