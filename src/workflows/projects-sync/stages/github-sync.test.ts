// github-sync tests — hermetic: no live GitHub API calls, no filesystem writes to
// the real job data dir. Uses a stub fetcher + stub catalog writer + the scratch DB
// (npm test sets LOCALJOBS_DB).
// Covers: filtering forks/archived/private; sorting by pushed_at; catalog entries
// have correct fields; ledger records one success row per repo id; repeat runs
// re-record (refresh pattern, no skip-if-done).
import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';

import { isWorkItemDone, getWorkItem } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';
import {
  runGithubSync,
  filterAndSortRepos,
  repoToCatalogEntry,
  repoIdsFromCatalog,
  fetchAllRepos,
  githubSyncInputKeys,
  type GitHubRepo,
  type CatalogEntry,
  type CatalogWriter,
} from './github-sync.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeCtx(): JobContext {
  return {
    log() {},
    progress() {},
    selectedRoots: () => null,
    rootAllowed: () => true,
  };
}

function makeRepo(overrides: Partial<GitHubRepo> = {}): GitHubRepo {
  return {
    id: Math.floor(Math.random() * 1_000_000),
    name: 'my-repo',
    full_name: 'user/my-repo',
    description: 'A test repo',
    html_url: 'https://github.com/user/my-repo',
    homepage: null,
    language: 'TypeScript',
    stargazers_count: 5,
    forks_count: 1,
    topics: ['typescript', 'test'],
    fork: false,
    archived: false,
    private: false,
    pushed_at: '2026-01-10T12:00:00Z',
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2026-01-10T12:00:00Z',
    default_branch: 'main',
    ...overrides,
  };
}

function makeCatalogWriterSpy() {
  const calls: CatalogEntry[][] = [];
  const write: CatalogWriter = (entries) => {
    calls.push(entries);
  };
  return { write, calls };
}

let idCounter = 0;
function uid(): number {
  return 9_000_000 + ++idCounter;
}

// ---------------------------------------------------------------------------
// filterAndSortRepos
// ---------------------------------------------------------------------------

describe('filterAndSortRepos', () => {
  it('excludes forks', () => {
    const repos = [makeRepo({ fork: true }), makeRepo({ fork: false })];
    const result = filterAndSortRepos(repos);
    assert.equal(result.length, 1);
    assert.equal(result[0].fork, false);
  });

  it('excludes archived repos', () => {
    const repos = [makeRepo({ archived: true }), makeRepo({ archived: false })];
    const result = filterAndSortRepos(repos);
    assert.equal(result.length, 1);
    assert.equal(result[0].archived, false);
  });

  it('excludes private repos', () => {
    const repos = [makeRepo({ private: true }), makeRepo({ private: false })];
    const result = filterAndSortRepos(repos);
    assert.equal(result.length, 1);
    assert.equal(result[0].private, false);
  });

  it('sorts by pushed_at descending', () => {
    const older = makeRepo({ pushed_at: '2025-01-01T00:00:00Z', name: 'older' });
    const newer = makeRepo({ pushed_at: '2026-06-01T00:00:00Z', name: 'newer' });
    const result = filterAndSortRepos([older, newer]);
    assert.equal(result[0].name, 'newer');
    assert.equal(result[1].name, 'older');
  });

  it('falls back to created_at when pushed_at is null', () => {
    const a = makeRepo({ pushed_at: null, created_at: '2025-06-01T00:00:00Z', name: 'a' });
    const b = makeRepo({ pushed_at: '2026-01-01T00:00:00Z', name: 'b' });
    const result = filterAndSortRepos([a, b]);
    assert.equal(result[0].name, 'b');
  });

  it('returns empty array when all repos are excluded', () => {
    const repos = [makeRepo({ fork: true }), makeRepo({ archived: true })];
    assert.equal(filterAndSortRepos(repos).length, 0);
  });
});

// ---------------------------------------------------------------------------
// repoToCatalogEntry
// ---------------------------------------------------------------------------

describe('repoToCatalogEntry', () => {
  it('maps all fields correctly', () => {
    const repo = makeRepo({ id: 42, description: 'hello', default_branch: 'develop' });
    const entry = repoToCatalogEntry(repo);
    assert.equal(entry.repoId, '42');
    assert.equal(entry.description, 'hello');
    assert.equal(entry.defaultBranch, 'develop');
  });

  it('defaults null description/language to empty string', () => {
    const repo = makeRepo({ description: null, language: null });
    const entry = repoToCatalogEntry(repo);
    assert.equal(entry.description, '');
    assert.equal(entry.language, '');
  });

  it('uses created_at for pushedAt when pushed_at is null', () => {
    const repo = makeRepo({ pushed_at: null, created_at: '2025-05-01T00:00:00Z' });
    const entry = repoToCatalogEntry(repo);
    assert.equal(entry.pushedAt, '2025-05-01T00:00:00Z');
  });
});

// ---------------------------------------------------------------------------
// repoIdsFromCatalog
// ---------------------------------------------------------------------------

describe('repoIdsFromCatalog', () => {
  it('returns the repoId of each entry', () => {
    const entries: CatalogEntry[] = [
      { repoId: '1', name: 'a', fullName: 'u/a', description: '', url: '', language: '', topics: [], pushedAt: '', defaultBranch: 'main' },
      { repoId: '2', name: 'b', fullName: 'u/b', description: '', url: '', language: '', topics: [], pushedAt: '', defaultBranch: 'main' },
    ];
    assert.deepEqual(repoIdsFromCatalog(entries), ['1', '2']);
  });
});

// ---------------------------------------------------------------------------
// fetchAllRepos — one callService('github', ...) reservation PER PAGE, not one
// for the whole paginated fetch (T424).
// ---------------------------------------------------------------------------

describe('fetchAllRepos', () => {
  it('calls callServiceFn once per page fetched, not once for the whole fetch', async () => {
    const perPage = 100;
    const pages = [
      Array.from({ length: perPage }, () => makeRepo({ id: uid() })),
      Array.from({ length: perPage }, () => makeRepo({ id: uid() })),
      Array.from({ length: 7 }, () => makeRepo({ id: uid() })), // short final page
    ];

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      const match = /[?&]page=(\d+)/.exec(String(url));
      const page = match ? Number(match[1]) : 1;
      const body = pages[page - 1] ?? [];
      return {
        ok: true,
        json: async () => body,
        text: async () => '',
      } as unknown as Response;
    }) as typeof fetch;

    const serviceCalls: string[] = [];
    try {
      const result = await fetchAllRepos('testuser', 'token', async (name, fn) => {
        serviceCalls.push(name);
        return fn();
      });

      assert.equal(serviceCalls.length, 3, 'one callService invocation per page fetched');
      assert.ok(serviceCalls.every((n) => n === 'github'));
      assert.equal(result.length, perPage + perPage + 7);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('passes a stable cacheKey to callServiceFn keyed by endpoint + page for read caching', async () => {
    const perPage = 100;
    const pages = [
      Array.from({ length: perPage }, () => makeRepo({ id: uid() })),
      Array.from({ length: 7 }, () => makeRepo({ id: uid() })), // short final page
    ];

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      const match = /[?&]page=(\d+)/.exec(String(url));
      const page = match ? Number(match[1]) : 1;
      const body = pages[page - 1] ?? [];
      return {
        ok: true,
        json: async () => body,
        text: async () => '',
      } as unknown as Response;
    }) as typeof fetch;

    const cacheKeys: (string | undefined)[] = [];
    try {
      await fetchAllRepos('testuser', 'token', async (name, fn, opts) => {
        cacheKeys.push(opts?.cacheKey);
        return fn();
      });

      assert.equal(cacheKeys.length, 2);
      assert.equal(cacheKeys[0], 'github:repos:testuser:page:1');
      assert.equal(cacheKeys[1], 'github:repos:testuser:page:2');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// githubSyncInputKeys — must be a LIVE API-derived candidate list, not a
// read-back of data/out/projects.json (T486: that file is written by this
// SAME stage, so reading it back is self-referential — a reset/fresh checkout
// with no catalog file yet would wrongly report zero candidates).
// ---------------------------------------------------------------------------

describe('githubSyncInputKeys', () => {
  beforeEach(() => {
    process.env.GITHUB_USERNAME = 'testuser';
    process.env.GITHUB_TOKEN = 'test-token';
  });

  it('returns repo ids from a live fetch, simulating a reset with no catalog file on disk', async () => {
    // Simulate `data/out/projects.json` having been deleted (a fresh checkout / reset) by
    // never touching the filesystem at all here — the old implementation would have caught
    // an ENOENT and returned [].
    const repos = [makeRepo({ id: uid() }), makeRepo({ id: uid() }), makeRepo({ id: uid(), fork: true })];
    const keys = await githubSyncInputKeys(async () => repos);

    assert.equal(keys.length, 2, 'excludes the forked repo, same filter as the real sync');
    assert.deepEqual(keys.sort(), [String(repos[0].id), String(repos[1].id)].sort());
  });

  it('returns [] when GITHUB_USERNAME is not set, without attempting a fetch', async () => {
    const saved = process.env.GITHUB_USERNAME;
    delete process.env.GITHUB_USERNAME;
    try {
      let called = false;
      const keys = await githubSyncInputKeys(async () => {
        called = true;
        return [];
      });
      assert.deepEqual(keys, []);
      assert.equal(called, false);
    } finally {
      if (saved !== undefined) process.env.GITHUB_USERNAME = saved;
    }
  });

  it('returns [] if the live fetch fails, rather than throwing', async () => {
    const keys = await githubSyncInputKeys(async () => {
      throw new Error('GitHub API error 500');
    });
    assert.deepEqual(keys, []);
  });
});

// ---------------------------------------------------------------------------
// runGithubSync
// ---------------------------------------------------------------------------

const JOB = 'github-sync';

describe('runGithubSync', () => {
  beforeEach(() => {
    process.env.GITHUB_USERNAME = 'testuser';
    process.env.GITHUB_TOKEN = 'test-token';
  });

  it('throws if GITHUB_USERNAME is missing', async () => {
    const saved = process.env.GITHUB_USERNAME;
    delete process.env.GITHUB_USERNAME;
    try {
      await assert.rejects(
        () =>
          runGithubSync(fakeCtx(), {
            fetchRepos: async () => [],
            writeCatalog: () => {},
          }),
        /GITHUB_USERNAME/,
      );
    } finally {
      if (saved !== undefined) process.env.GITHUB_USERNAME = saved;
    }
  });

  it('writes the catalog and marks each repo done in the ledger', async () => {
    const repo = makeRepo({ id: uid() });
    const { write, calls } = makeCatalogWriterSpy();

    await runGithubSync(fakeCtx(), {
      fetchRepos: async () => [repo],
      writeCatalog: write,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].length, 1);
    assert.equal(calls[0][0].repoId, String(repo.id));
    assert.ok(isWorkItemDone(JOB, String(repo.id), 3), 'repo should be marked done');

    const row = getWorkItem(JOB, String(repo.id));
    assert.ok(row, 'work item row should exist');
    const detail = JSON.parse(row!.detail ?? '{}');
    assert.equal(detail.description, repo.description);
    assert.equal(detail.language, repo.language);
    assert.equal(detail.url, repo.html_url);
    assert.deepEqual(detail.topics, repo.topics);
  });

  it('re-records a repo already in the ledger (refresh pattern)', async () => {
    const repo = makeRepo({ id: uid() });
    const { write: write1 } = makeCatalogWriterSpy();
    await runGithubSync(fakeCtx(), { fetchRepos: async () => [repo], writeCatalog: write1 });

    const { write, calls } = makeCatalogWriterSpy();
    await runGithubSync(fakeCtx(), {
      fetchRepos: async () => [repo],
      writeCatalog: write,
    });

    assert.equal(calls.length, 1, 'catalog is always re-written on each run');
    assert.equal(calls[0].length, 1);
  });

  it('excludes forks and archived repos before writing', async () => {
    const normal = makeRepo({ id: uid() });
    const fork = makeRepo({ id: uid(), fork: true });
    const archived = makeRepo({ id: uid(), archived: true });

    const { write, calls } = makeCatalogWriterSpy();
    await runGithubSync(fakeCtx(), {
      fetchRepos: async () => [normal, fork, archived],
      writeCatalog: write,
    });

    assert.equal(calls[0].length, 1, 'only the non-fork non-archived repo is written');
    assert.equal(calls[0][0].repoId, String(normal.id));
  });

  it('handles empty repo list gracefully', async () => {
    const { write, calls } = makeCatalogWriterSpy();
    await runGithubSync(fakeCtx(), {
      fetchRepos: async () => [],
      writeCatalog: write,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].length, 0);
  });

  it('records multiple repos and reports progress', async () => {
    const repos = [makeRepo({ id: uid() }), makeRepo({ id: uid() }), makeRepo({ id: uid() })];
    const progressCalls: number[] = [];
    const ctx: JobContext = {
      log() {},
      progress(pct) {
        progressCalls.push(pct);
      },
      selectedRoots: () => null,
      rootAllowed: () => true,
    };

    const { write, calls } = makeCatalogWriterSpy();
    await runGithubSync(ctx, {
      fetchRepos: async () => repos,
      writeCatalog: write,
    });

    assert.equal(calls[0].length, 3);
    for (const repo of repos) {
      assert.ok(isWorkItemDone(JOB, String(repo.id), 3), `repo ${repo.id} should be marked done`);
    }
    assert.ok(progressCalls.length >= 3, 'progress called at least once per repo');
    assert.equal(progressCalls[progressCalls.length - 1], 100, 'final progress is 100');
  });
});
