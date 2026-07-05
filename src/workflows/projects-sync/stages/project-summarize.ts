import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const REQUIRED_HEADINGS = [
  '## What It Is',
  '## Tech Stack',
  '## Status',
  '## Structure',
  '## Themes & Interests',
  '## Notable Technical Approaches',
  '## Sources',
];

const FALLBACK_TEMPLATE = [
  '---',
  'name: ""',
  'full_name: ""',
  'url: ""',
  'language: ""',
  'topics: []',
  'status: ""',
  'last_pushed: ""',
  'themes: []',
  'domain: ""',
  '---',
  '',
  '# Name — owner/repo',
  '',
  '## What It Is',
  '',
  '## Tech Stack',
  '',
  '## Status',
  '',
  '## Structure',
  '',
  '## Themes & Interests',
  '',
  '## Notable Technical Approaches',
  '',
  '## Sources',
  '',
].join('\n');

import { runClaudeWithRepoAccess } from '../claude-repo.js';
import { callService } from '../../../core/services.js';
import { getWorkItem, markWorkItem } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';
import { projectsSyncConfig } from '../config.js';
import type { CatalogEntry } from './github-sync.js';

const JOB_NAME = 'project-summarize';

export const claudeModel = process.env.PROJECTS_SYNC_CLAUDE_MODEL ?? 'claude-sonnet-5';
export const claudeEffort = process.env.PROJECTS_SYNC_CLAUDE_EFFORT ?? 'medium';

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

/** Injectable so tests can spy on the service gate without depending on the
 *  registry having actually registered the `github` service. Defaults to the
 *  real `callService`. */
export type ServiceCaller = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

export async function cloneOrPullRepo(
  repoUrl: string,
  dest: string,
  callServiceFn: ServiceCaller = callService,
): Promise<void> {
  // Gate the git-over-HTTPS calls against GitHub through the SAME `github` service
  // used by github-sync's REST API calls — one shared "how hard are we hitting
  // GitHub" budget rather than a second, untracked one.
  await callServiceFn('github', async () => {
    if (existsSync(resolve(dest, '.git'))) {
      await runGit(['fetch', '--depth', '1', 'origin'], dest);
      await runGit(['reset', '--hard', 'origin/HEAD'], dest);
    } else {
      mkdirSync(dest, { recursive: true });
      await runGit(['clone', '--depth', '1', repoUrl, dest]);
    }
  });
}

export type ClaudeSummarizer = (prompt: string, model: string, repoDir: string, effort?: string) => Promise<{ ok: boolean; text: string; error?: string }>;

// ---------------------------------------------------------------------------
// Prompt building — Claude has its own read-only filesystem access to the
// cloned repo (via runClaudeWithRepoAccess), so the prompt embeds only the
// catalog metadata GitHub knows (name/description/language/topics/pushedAt/url
// — there is no way to learn these from local file exploration alone) and
// instructs Claude to explore the repo itself (package.json, source layout,
// README, other docs) rather than embedding README text inline.
// ---------------------------------------------------------------------------

export function buildSummaryPrompt(entry: CatalogEntry): string {
  const template = existsSync(projectsSyncConfig.templatePath)
    ? readFileSync(projectsSyncConfig.templatePath, 'utf-8')
    : FALLBACK_TEMPLATE;

  return [
    `Write a summary of the following GitHub project for a personal "second brain" corpus.`,
    `Produce a single Markdown file that EXACTLY follows the TEMPLATE at the end — same YAML`,
    `frontmatter keys, same section headings, valid YAML, no extra keys.`,
    ``,
    `Name: ${entry.fullName}`,
    `Description: ${entry.description || '(none)'}`,
    `Language: ${entry.language || '(unknown)'}`,
    `Topics: ${entry.topics.join(', ') || '(none)'}`,
    `Last pushed: ${entry.pushedAt}`,
    `URL: ${entry.url}`,
    ``,
    `The project's repository is checked out at your current working directory. Explore it`,
    `yourself using your read-only tools (package.json, source layout, README, other docs you`,
    `find) to learn what it actually is, its tech stack, structure, and notable approaches.`,
    ``,
    `Cover: what the project is, what it's for / what it covers, its last-commit date and an`,
    `active/dormant judgement, and the broader interests/domains/technical approaches it reflects`,
    `(these support later cross-project queries like "what kind of work is Ryan interested in").`,
    ``,
    `Each section should be a couple of substantive paragraphs of real prose grounded in what you`,
    `actually found exploring the repo (specific files, patterns, dependencies, structure) — not a`,
    `single generic sentence. If a section genuinely has little to say for a small/simple/dormant`,
    `project, say so honestly and briefly rather than padding, but do not default to brevity when`,
    `there is real substance to draw from your exploration.`,
    ``,
    `NEVER invent facts you cannot support from the data above or from files you actually read —`,
    `use "unknown" or leave prose honest about gaps.`,
    ``,
    `Reply with ONLY the Markdown file content, starting at the opening "---" — no code fences,`,
    `no commentary.`,
    ``,
    '--- TEMPLATE ---',
    template,
  ].join('\n');
}

/** Returns the missing pieces (leading frontmatter marker and/or required
 *  section headings) that a generated summary must contain, or [] if it's shaped correctly. */
export function templateShapeViolations(md: string): string[] {
  const missing: string[] = [];
  if (!md.startsWith('---')) missing.push('leading "---" frontmatter marker');
  for (const heading of REQUIRED_HEADINGS) {
    if (!md.includes(heading)) missing.push(`"${heading}" section`);
  }
  return missing;
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
    summarizeWithRepoAccess?: ClaudeSummarizer;
    writeMarkdown?: (path: string, content: string) => void;
  } = {},
): Promise<void> {
  const readCatalog = opts.readCatalog ?? (() => {
    const raw = readFileSync(projectsSyncConfig.catalogPath, 'utf-8');
    return JSON.parse(raw) as CatalogEntry[];
  });
  const cloneOrPull = opts.cloneOrPull ?? cloneOrPullRepo;
  const summarize = opts.summarizeWithRepoAccess ?? runClaudeWithRepoAccess;
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
  let failed = 0;

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

      const prompt = buildSummaryPrompt(entry);
      const result = await summarize(prompt, claudeModel, dest, claudeEffort);
      if (!result.ok) {
        throw new Error(`claude summarize failed: ${result.error ?? 'unknown error'}`);
      }

      const violations = templateShapeViolations(result.text);
      if (violations.length > 0) {
        throw new Error(`summary output missing template shape: ${violations.join(', ')}`);
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
      ctx.log(`error: failed to summarize ${entry.fullName}: ${String(e)}`, 'error');
      markWorkItem(JOB_NAME, entry.repoId, 'failed', { rootKey: entry.repoId, detail: { name: entry.fullName } });
      failed++;
    }

    ctx.progress(((i + 1) / todo.length) * 100, `${i + 1}/${todo.length} processed`);
  }

  ctx.log(`info: project-summarize complete — ${processed} summarized, ${skipped} skipped (unchanged), ${failed} failed`);

  if (failed > 0) {
    throw new Error(
      `project-summarize: ${failed} of ${todo.length} repo(s) failed to summarize this run — see logs above for per-repo errors`,
    );
  }
}
