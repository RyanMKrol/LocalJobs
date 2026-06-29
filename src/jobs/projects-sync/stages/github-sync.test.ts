// github-sync tests — hermetic: no live GitHub API calls, no live AWS writes.
// Uses a stub fetcher + stub putter + the scratch DB (npm test sets LOCALJOBS_DB).
// Covers: filtering forks/archived/private; sorting by pushed_at; upsert writes
// item with correct fields; already-synced repos are overwritten (refresh pattern);
// putter failure is recorded and re-thrown at end.
import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';

import { isWorkItemDone, markWorkItem } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';
import {
  runGithubSync,
  filterAndSortRepos,
  repoToTableItem,
  type GitHubRepo,
  type DynamoPutter,
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
    ...overrides,
  };
}

function makePutSpy() {
  const calls: { table: string; item: Record<string, unknown> }[] = [];
  const put: DynamoPutter = async (table, item) => {
    calls.push({ table, item });
  };
  return { put, calls };
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
// repoToTableItem
// ---------------------------------------------------------------------------

describe('repoToTableItem', () => {
  it('maps all fields correctly', () => {
    const repo = makeRepo({ id: 42, description: 'hello', homepage: 'https://example.com' });
    const item = repoToTableItem(repo, '2026-01-01T00:00:00.000Z');
    assert.equal(item.repoId, '42');
    assert.equal(item.description, 'hello');
    assert.equal(item.homepage, 'https://example.com');
    assert.equal(item.syncedAt, '2026-01-01T00:00:00.000Z');
  });

  it('defaults null description/homepage/language to empty string', () => {
    const repo = makeRepo({ description: null, homepage: null, language: null });
    const item = repoToTableItem(repo, 'now');
    assert.equal(item.description, '');
    assert.equal(item.homepage, '');
    assert.equal(item.language, '');
  });

  it('uses created_at for pushedAt when pushed_at is null', () => {
    const repo = makeRepo({ pushed_at: null, created_at: '2025-05-01T00:00:00Z' });
    const item = repoToTableItem(repo, 'now');
    assert.equal(item.pushedAt, '2025-05-01T00:00:00Z');
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
            putItem: async () => {},
            projectsTable: 'P',
          }),
        /GITHUB_USERNAME/,
      );
    } finally {
      if (saved !== undefined) process.env.GITHUB_USERNAME = saved;
    }
  });

  it('upserts a new repo and marks it done in the ledger', async () => {
    const repo = makeRepo({ id: uid() });
    const { put, calls } = makePutSpy();

    await runGithubSync(fakeCtx(), {
      fetchRepos: async () => [repo],
      putItem: put,
      projectsTable: 'Projects',
      syncedAt: '2026-01-01T00:00:00.000Z',
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].table, 'Projects');
    assert.equal(calls[0].item['repoId'], String(repo.id));
    assert.ok(isWorkItemDone(JOB, String(repo.id), 3), 'repo should be marked done');
  });

  it('re-upserts a repo already in the ledger (refresh pattern)', async () => {
    const repo = makeRepo({ id: uid() });
    markWorkItem(JOB, String(repo.id), 'success');

    const { put, calls } = makePutSpy();
    await runGithubSync(fakeCtx(), {
      fetchRepos: async () => [repo],
      putItem: put,
      projectsTable: 'P',
      syncedAt: 'now',
    });

    // Projects-sync always refreshes (unlike workouts which skips done items)
    assert.equal(calls.length, 1, 'repo is always re-upserted on each run');
  });

  it('excludes forks and archived repos before writing', async () => {
    const normal = makeRepo({ id: uid() });
    const fork = makeRepo({ id: uid(), fork: true });
    const archived = makeRepo({ id: uid(), archived: true });

    const { put, calls } = makePutSpy();
    await runGithubSync(fakeCtx(), {
      fetchRepos: async () => [normal, fork, archived],
      putItem: put,
      projectsTable: 'P',
      syncedAt: 'now',
    });

    assert.equal(calls.length, 1, 'only the non-fork non-archived repo is written');
    assert.equal(calls[0].item['repoId'], String(normal.id));
  });

  it('handles empty repo list gracefully', async () => {
    const { put, calls } = makePutSpy();
    await runGithubSync(fakeCtx(), {
      fetchRepos: async () => [],
      putItem: put,
      projectsTable: 'P',
      syncedAt: 'now',
    });
    assert.equal(calls.length, 0);
  });

  it('marks repo failed in ledger when putter throws, then throws at end', async () => {
    const repo = makeRepo({ id: uid() });

    const failingPut: DynamoPutter = async () => {
      throw new Error('DynamoDB unavailable');
    };

    await assert.rejects(
      () =>
        runGithubSync(fakeCtx(), {
          fetchRepos: async () => [repo],
          putItem: failingPut,
          projectsTable: 'P',
          syncedAt: 'now',
        }),
      /failed to upsert/,
    );

    assert.ok(!isWorkItemDone(JOB, String(repo.id), 3), 'failed repo should not be marked done');
  });

  it('upserts multiple repos and reports progress', async () => {
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

    const { put, calls } = makePutSpy();
    await runGithubSync(ctx, {
      fetchRepos: async () => repos,
      putItem: put,
      projectsTable: 'P',
      syncedAt: 'now',
    });

    assert.equal(calls.length, 3);
    assert.ok(progressCalls.length >= 3, 'progress called at least once per repo');
    assert.equal(progressCalls[progressCalls.length - 1], 100, 'final progress is 100');
  });
});
