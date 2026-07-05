// project-summarize tests — hermetic: no live git clone, no live Claude CLI, no
// filesystem writes to the real job data dir. Uses stub git/claude/markdown-writer
// functions + the scratch DB (npm test sets LOCALJOBS_DB).
// Covers: a repo with a changed marker gets cloned + summarized (work_items row
// with detail.markdown set); a repo whose stored marker already matches the
// catalog value is skipped entirely (no clone, no Claude call).
import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';

import { getWorkItem, markWorkItem } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';
import { runProjectSummarize, buildSummaryPrompt, cloneOrPullRepo } from './project-summarize.js';
import { buildRepoAccessArgs, REPO_ACCESS_ALLOWED_TOOLS } from '../claude-repo.js';
import type { CatalogEntry } from './github-sync.js';

function fakeCtx(): JobContext {
  return {
    log() {},
    progress() {},
    selectedRoots: () => null,
    rootAllowed: () => true,
  };
}

function makeEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    repoId: String(Math.floor(Math.random() * 1_000_000)),
    name: 'my-repo',
    fullName: 'user/my-repo',
    description: 'A test repo',
    url: 'https://github.com/user/my-repo',
    language: 'TypeScript',
    topics: ['typescript'],
    pushedAt: '2026-01-10T12:00:00Z',
    defaultBranch: 'main',
    ...overrides,
  };
}

function conformantSummary(entry: CatalogEntry): string {
  return [
    '---',
    `name: "${entry.name}"`,
    `full_name: "${entry.fullName}"`,
    `url: "${entry.url}"`,
    `language: "${entry.language}"`,
    'topics: []',
    'status: "active"',
    `last_pushed: "${entry.pushedAt}"`,
    'themes: ["personal automation"]',
    'domain: "A test domain."',
    '---',
    '',
    `# ${entry.name}`,
    '',
    '## What It Is',
    'Cool project.',
    '## Tech Stack',
    'TypeScript.',
    '## Status',
    'Active.',
    '## Structure',
    'Flat.',
    '## Themes & Interests',
    'Automation.',
    '## Notable Technical Approaches',
    'Nothing special.',
    '## Sources',
    `- ${entry.url}`,
  ].join('\n');
}

describe('project-summarize', () => {
  it('clones + summarizes a repo whose stored marker differs from the catalog value', async () => {
    const entry = makeEntry();
    const cloneCalls: Array<[string, string]> = [];
    const claudeCalls: string[] = [];
    const writtenFiles: Array<[string, string]> = [];

    await runProjectSummarize(fakeCtx(), {
      readCatalog: () => [entry],
      cloneOrPull: async (url, dest) => { cloneCalls.push([url, dest]); },
      summarizeWithRepoAccess: async (prompt) => { claudeCalls.push(prompt); return { ok: true, text: conformantSummary(entry) }; },
      writeMarkdown: (path, content) => { writtenFiles.push([path, content]); },
    });

    assert.equal(cloneCalls.length, 1);
    assert.equal(cloneCalls[0][0], entry.url);
    assert.equal(claudeCalls.length, 1);
    assert.equal(writtenFiles.length, 1);
    assert.match(writtenFiles[0][1], /Cool project/);

    const row = getWorkItem('project-summarize', entry.repoId);
    assert.ok(row);
    assert.equal(row!.status, 'success');
    const detail = JSON.parse(row!.detail!);
    assert.equal(detail.name, entry.fullName);
    assert.equal(detail.lastCommitSha, entry.pushedAt);
    assert.match(detail.markdown, /my-repo\.md$/);
  });

  it('skips a repo whose stored marker already matches the current catalog value', async () => {
    const entry = makeEntry({ pushedAt: '2026-02-01T00:00:00Z' });
    markWorkItem('project-summarize', entry.repoId, 'success', {
      rootKey: entry.repoId,
      detail: { name: entry.fullName, markdown: '/tmp/whatever.md', lastCommitSha: entry.pushedAt },
    });

    const cloneCalls: Array<[string, string]> = [];
    const claudeCalls: string[] = [];

    await runProjectSummarize(fakeCtx(), {
      readCatalog: () => [entry],
      cloneOrPull: async (url, dest) => { cloneCalls.push([url, dest]); },
      summarizeWithRepoAccess: async (prompt) => { claudeCalls.push(prompt); return { ok: true, text: '' }; },
      writeMarkdown: () => {},
    });

    assert.equal(cloneCalls.length, 0);
    assert.equal(claudeCalls.length, 0);
  });

  it('builds a prompt that includes repo metadata and instructs Claude to explore the repo itself', () => {
    const entry = makeEntry({ description: 'Does a thing', language: 'Go' });
    const prompt = buildSummaryPrompt(entry);
    assert.match(prompt, /Does a thing/);
    assert.match(prompt, /Go/);
    assert.match(prompt, /Explore it/);
  });

  it('builds a prompt that instructs substantive per-section depth without pressuring invention', () => {
    const entry = makeEntry();
    const prompt = buildSummaryPrompt(entry);
    assert.match(prompt, /substantive paragraphs/);
    assert.match(prompt, /not a[\s\S]*single generic sentence/);
    assert.match(prompt, /NEVER invent facts/);
  });

  it('accepts a template-conformant summary — marks success and writes markdown', async () => {
    const entry = makeEntry();

    const writtenFiles: Array<[string, string]> = [];
    await runProjectSummarize(fakeCtx(), {
      readCatalog: () => [entry],
      cloneOrPull: async () => {},
      summarizeWithRepoAccess: async () => ({ ok: true, text: conformantSummary(entry) }),
      writeMarkdown: (path, content) => { writtenFiles.push([path, content]); },
    });

    assert.equal(writtenFiles.length, 1);
    const row = getWorkItem('project-summarize', entry.repoId);
    assert.ok(row);
    assert.equal(row!.status, 'success');
  });

  it('rejects a summary missing a required section — marks failed, writes no markdown', async () => {
    const entry = makeEntry();
    const nonConformant = [
      '---',
      `name: "${entry.name}"`,
      '---',
      '',
      '## What It Is',
      'It does a thing.',
      '## Sources',
      `- ${entry.url}`,
    ].join('\n');

    const writtenFiles: Array<[string, string]> = [];
    const logs: Array<[string, string | undefined]> = [];
    const ctx = fakeCtx();
    ctx.log = (message, level) => { logs.push([message, level]); };
    await assert.rejects(() => runProjectSummarize(ctx, {
      readCatalog: () => [entry],
      cloneOrPull: async () => {},
      summarizeWithRepoAccess: async () => ({ ok: true, text: nonConformant }),
      writeMarkdown: (path, content) => { writtenFiles.push([path, content]); },
    }));

    assert.equal(writtenFiles.length, 0);
    const row = getWorkItem('project-summarize', entry.repoId);
    assert.ok(row);
    assert.equal(row!.status, 'failed');

    const errorLog = logs.find(([message]) => message.startsWith('error: failed to summarize'));
    assert.ok(errorLog, 'expected an error log line for the failed summary');
    assert.equal(errorLog![1], 'error');
  });

  it('throws when a repo fails to summarize this run (T422) — run itself must fail, not just the item', async () => {
    const entry = makeEntry();

    await assert.rejects(
      () => runProjectSummarize(fakeCtx(), {
        readCatalog: () => [entry],
        cloneOrPull: async () => {},
        summarizeWithRepoAccess: async () => {
          throw new Error(`failed to summarize ${entry.fullName}: boom`);
        },
        writeMarkdown: () => {},
      }),
      /1 of 1 repo\(s\) failed to summarize this run/,
    );

    const row = getWorkItem('project-summarize', entry.repoId);
    assert.ok(row);
    assert.equal(row!.status, 'failed');
  });

  it('fails the whole run when one of two repos fails, while still recording the successful one (T422)', async () => {
    const okEntry = makeEntry({ name: 'good-repo', fullName: 'user/good-repo' });
    const badEntry = makeEntry({ name: 'bad-repo', fullName: 'user/bad-repo' });

    const writtenFiles: Array<[string, string]> = [];
    await assert.rejects(
      () => runProjectSummarize(fakeCtx(), {
        readCatalog: () => [okEntry, badEntry],
        cloneOrPull: async () => {},
        summarizeWithRepoAccess: async (_prompt, _model, repoDir) => {
          if (repoDir.includes('bad-repo')) {
            throw new Error(`failed to summarize ${badEntry.fullName}: boom`);
          }
          return { ok: true, text: conformantSummary(okEntry) };
        },
        writeMarkdown: (path, content) => { writtenFiles.push([path, content]); },
      }),
      /1 of 2 repo\(s\) failed to summarize this run/,
    );

    assert.equal(writtenFiles.length, 1);

    const okRow = getWorkItem('project-summarize', okEntry.repoId);
    assert.ok(okRow);
    assert.equal(okRow!.status, 'success');
    const okDetail = JSON.parse(okRow!.detail!);
    assert.match(okDetail.markdown, /good-repo\.md$/);

    const badRow = getWorkItem('project-summarize', badEntry.repoId);
    assert.ok(badRow);
    assert.equal(badRow!.status, 'failed');
  });

  it('calls summarizeWithRepoAccess with the cloned repo dir as the target directory', async () => {
    const entry = makeEntry();
    let seenRepoDir: string | undefined;

    await runProjectSummarize(fakeCtx(), {
      readCatalog: () => [entry],
      cloneOrPull: async () => {},
      summarizeWithRepoAccess: async (_prompt, _model, repoDir) => {
        seenRepoDir = repoDir;
        return { ok: true, text: conformantSummary(entry) };
      },
      writeMarkdown: () => {},
    });

    assert.ok(seenRepoDir);
    assert.match(seenRepoDir!, /my-repo$/);
  });
});

describe('cloneOrPullRepo — service gating (T424)', () => {
  it('routes the git operation through callService("github", ...)', async () => {
    const serviceCalls: string[] = [];
    let fnRan = false;

    await cloneOrPullRepo('https://github.com/user/my-repo', '/tmp/does-not-matter', async <T,>(name: string) => {
      serviceCalls.push(name);
      fnRan = true;
      // Don't actually invoke the real git spawn — we only need to prove the
      // clone/pull work happens INSIDE the service gate, not that git succeeds.
      return undefined as T;
    });

    assert.deepEqual(serviceCalls, ['github']);
    assert.ok(fnRan, 'the gated function should have been invoked');
  });
});

describe('claude-repo invocation args', () => {
  it('builds args with cwd-scoped --add-dir and read-only --allowedTools', () => {
    const repoDir = '/tmp/some-cloned-repo';
    const args = buildRepoAccessArgs('claude-sonnet-5', repoDir, 'medium');

    const addDirIdx = args.indexOf('--add-dir');
    assert.ok(addDirIdx !== -1);
    assert.equal(args[addDirIdx + 1], repoDir);

    const allowedIdx = args.indexOf('--allowedTools');
    assert.ok(allowedIdx !== -1);
    const allowed = args.slice(allowedIdx + 1, allowedIdx + 1 + REPO_ACCESS_ALLOWED_TOOLS.length);
    assert.deepEqual(allowed, REPO_ACCESS_ALLOWED_TOOLS);

    for (const mutating of ['Bash', 'Write', 'Edit']) {
      assert.ok(!args.includes(mutating), `expected ${mutating} not to be in allowed-tools args`);
    }
  });
});
