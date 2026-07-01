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
import { runProjectSummarize, buildSummaryPrompt } from './project-summarize.js';
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

describe('project-summarize', () => {
  it('clones + summarizes a repo whose stored marker differs from the catalog value', async () => {
    const entry = makeEntry();
    const cloneCalls: Array<[string, string]> = [];
    const claudeCalls: string[] = [];
    const writtenFiles: Array<[string, string]> = [];

    await runProjectSummarize(fakeCtx(), {
      readCatalog: () => [entry],
      cloneOrPull: async (url, dest) => { cloneCalls.push([url, dest]); },
      readReadme: () => '# My Repo\nDoes cool stuff.',
      summarize: async (prompt) => { claudeCalls.push(prompt); return { ok: true, text: '# Summary\nCool project.' }; },
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
      readReadme: () => '',
      summarize: async (prompt) => { claudeCalls.push(prompt); return { ok: true, text: '' }; },
      writeMarkdown: () => {},
    });

    assert.equal(cloneCalls.length, 0);
    assert.equal(claudeCalls.length, 0);
  });

  it('builds a prompt that includes repo metadata and README content', () => {
    const entry = makeEntry({ description: 'Does a thing', language: 'Go' });
    const prompt = buildSummaryPrompt(entry, '# Readme body');
    assert.match(prompt, /Does a thing/);
    assert.match(prompt, /Go/);
    assert.match(prompt, /Readme body/);
  });
});
