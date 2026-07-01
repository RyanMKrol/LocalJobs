import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

import { runClaude } from '../../../services/claude.js';
import { getWorkItem, markWorkItem } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';
import { projectsSyncConfig } from '../config.js';
import type { CatalogEntry } from './github-sync.js';

const JOB_NAME = 'project-summarize';

const README_CANDIDATES = ['README.md', 'Readme.md', 'README', 'readme.md'];

export const claudeModel = process.env.PROJECTS_SYNC_CLAUDE_MODEL ?? 'claude-sonnet-5';

// ---------------------------------------------------------------------------
// Injectable git clone/pull + Claude call (real implementations shell out /
// call the shared service; tests inject stubs)
// ---------------------------------------------------------------------------

export type GitCloneOrPull = (repoUrl: string, dest: string) => Promise<void>;

export function runGit(args: string[], cwd?: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`git ${args.join(' ')} failed (${code}): ${err.trim()}`));
    });
  });
}

export async function cloneOrPullRepo(repoUrl: string, dest: string): Promise<void> {
  if (existsSync(resolve(dest, '.git'))) {
    await runGit(['fetch', '--depth', '1', 'origin'], dest);
    await runGit(['reset', '--hard', 'origin/HEAD'], dest);
  } else {
    mkdirSync(dest, { recursive: true });
    await runGit(['clone', '--depth', '1', repoUrl, dest]);
  }
}

export type ClaudeSummarizer = (prompt: string, model: string) => Promise<{ ok: boolean; text: string; error?: string }>;

// ---------------------------------------------------------------------------
// Repo context (README + metadata)
// ---------------------------------------------------------------------------

export function readRepoReadme(repoDir: string): string {
  for (const name of README_CANDIDATES) {
    const path = resolve(repoDir, name);
    if (existsSync(path)) {
      try {
        return readFileSync(path, 'utf-8');
      } catch {
        return '';
      }
    }
  }
  return '';
}

export function buildSummaryPrompt(entry: CatalogEntry, readme: string): string {
  return [
    `Write a short markdown summary of the following GitHub project.`,
    `Cover: what the project is, what it's for / what it covers, and its last-commit date.`,
    ``,
    `Name: ${entry.fullName}`,
    `Description: ${entry.description || '(none)'}`,
    `Language: ${entry.language || '(unknown)'}`,
    `Topics: ${entry.topics.join(', ') || '(none)'}`,
    `Last pushed: ${entry.pushedAt}`,
    `URL: ${entry.url}`,
    ``,
    `README contents:`,
    readme ? readme.slice(0, 8000) : '(no README found)',
  ].join('\n');
}

export function repoMarkdownPath(repoName: string): string {
  return resolve(projectsSyncConfig.outDir, `${repoName}.md`);
}

export function repoCloneDir(repoName: string): string {
  return resolve(projectsSyncConfig.reposDir, repoName);
}

interface WorkItemDetail {
  name?: string;
  markdown?: string;
  lastCommitSha?: string;
}

function readStoredMarker(itemKey: string): string | undefined {
  const row = getWorkItem(JOB_NAME, itemKey);
  if (!row?.detail) return undefined;
  try {
    return (JSON.parse(row.detail) as WorkItemDetail).lastCommitSha;
  } catch {
    return undefined;
  }
}

export async function runProjectSummarize(
  ctx: JobContext,
  opts: {
    readCatalog?: () => CatalogEntry[];
    cloneOrPull?: GitCloneOrPull;
    summarize?: ClaudeSummarizer;
    readReadme?: (repoDir: string) => string;
    writeMarkdown?: (path: string, content: string) => void;
  } = {},
): Promise<void> {
  const readCatalog = opts.readCatalog ?? (() => {
    const raw = readFileSync(projectsSyncConfig.catalogPath, 'utf-8');
    return JSON.parse(raw) as CatalogEntry[];
  });
  const cloneOrPull = opts.cloneOrPull ?? cloneOrPullRepo;
  const summarize = opts.summarize ?? runClaude;
  const readReadme = opts.readReadme ?? readRepoReadme;
  const writeMarkdown = opts.writeMarkdown ?? ((path: string, content: string) => {
    mkdirSync(projectsSyncConfig.outDir, { recursive: true });
    writeFileSync(path, content);
  });

  let entries: CatalogEntry[];
  try {
    entries = readCatalog();
  } catch (e) {
    throw new Error(`could not read catalog (data/out/projects.json) — run github-sync first: ${String(e)}`);
  }

  ctx.log(`info: project-summarize starting — ${entries.length} repos in catalog`);

  const todo = entries.filter((e) => ctx.rootAllowed(e.repoId));
  let processed = 0;
  let skipped = 0;

  for (let i = 0; i < todo.length; i++) {
    const entry = todo[i];
    const marker = entry.pushedAt;
    const stored = readStoredMarker(entry.repoId);

    if (stored === marker) {
      skipped++;
      ctx.log(`info: repo ${entry.fullName} unchanged since last summary (pushedAt ${marker}) — skipping`);
      ctx.progress(((i + 1) / todo.length) * 100, `${i + 1}/${todo.length} — skipped ${entry.fullName}`);
      continue;
    }

    ctx.log(`info: summarizing ${entry.fullName} (marker ${stored ?? '(none)'} -> ${marker})`);
    const dest = repoCloneDir(entry.name);
    try {
      ctx.log(`info: cloning/pulling ${entry.url} -> ${dest}`);
      await cloneOrPull(entry.url, dest);

      const readme = readReadme(dest);
      ctx.log(`info: read README for ${entry.fullName} (${readme.length} chars)`);

      const prompt = buildSummaryPrompt(entry, readme);
      const result = await summarize(prompt, claudeModel);
      if (!result.ok) {
        throw new Error(`claude summarize failed: ${result.error ?? 'unknown error'}`);
      }

      const mdPath = repoMarkdownPath(entry.name);
      writeMarkdown(mdPath, result.text);
      ctx.log(`info: wrote summary for ${entry.fullName} -> ${mdPath}`);

      markWorkItem(JOB_NAME, entry.repoId, 'success', {
        rootKey: entry.repoId,
        detail: { name: entry.fullName, markdown: mdPath, lastCommitSha: marker },
      });
      processed++;
    } catch (e) {
      ctx.log(`error: failed to summarize ${entry.fullName}: ${String(e)}`);
      markWorkItem(JOB_NAME, entry.repoId, 'failed', { rootKey: entry.repoId, detail: { name: entry.fullName } });
    }

    ctx.progress(((i + 1) / todo.length) * 100, `${i + 1}/${todo.length} processed`);
  }

  ctx.log(`info: project-summarize complete — ${processed} summarized, ${skipped} skipped (unchanged)`);
}
