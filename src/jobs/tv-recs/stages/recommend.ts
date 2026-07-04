// Shared recommender implementation each TV branch job calls.
// Mirrors src/jobs/movies/stages/recommend.ts, adapted for TV shows.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JobContext } from '../../../core/types.js';
import { extractJsonObject, runClaude } from '../../../services/claude.js';
import type { ClaudeResult } from '../../../services/claude.js';
import { ignoredWorkItemDetails } from '../../../db/store.js';
import { tvBranchSuggestionsContract, tvSnapshotContract } from '../contracts.js';
import { tvRecsConfig } from '../config.js';
import { ensureDirs } from '../lib.js';
import { RECS_JOB } from '../recs.js';
import { branchById } from './branches.js';
import type {
  BranchOutputFile,
  RawSuggestion,
  RecsHistoryFile,
  TvSnapshotFile,
  TvTasteProfileFile,
} from '../types.js';
import type { BranchContext, BranchSpec } from './branches.js';

/** A Claude runner shaped like the shared helper (injectable for tests). */
export type RunClaudeFn = (prompt: string, model: string) => Promise<ClaudeResult>;

export interface BranchOpts {
  runClaude?: RunClaudeFn;
  snapshotFile?: string;
  tasteFile?: string;
  historyFile?: string;
  recsDir?: string;
  now?: Date;
}

/** Parse a Claude branch reply into raw suggestions; throws on junk (no JSON). */
export function parseSuggestions(text: string, lens: string): RawSuggestion[] {
  const obj = extractJsonObject(text) as { recommendations?: unknown };
  const arr = Array.isArray(obj.recommendations) ? obj.recommendations : null;
  if (!arr) throw new Error('no "recommendations" array in result');
  const out: RawSuggestion[] = [];
  for (const r of arr) {
    if (!r || typeof r !== 'object') continue;
    const rec = r as { title?: unknown; year?: unknown; reason?: unknown };
    const title = typeof rec.title === 'string' ? rec.title.trim() : '';
    if (!title) continue;
    const year = typeof rec.year === 'number' ? rec.year
      : typeof rec.year === 'string' && /^\d{4}$/.test(rec.year) ? Number(rec.year)
        : null;
    out.push({ title, year, reason: typeof rec.reason === 'string' ? rec.reason.trim() : '', lens });
  }
  return out;
}

export function recentTitles(historyFile: string, window: number): string[] {
  if (!existsSync(historyFile)) return [];
  try {
    const hist = JSON.parse(readFileSync(historyFile, 'utf8')) as RecsHistoryFile;
    const recs = Array.isArray(hist.recommended) ? hist.recommended : [];
    return recs.slice(-window).map((r) => `${r.title}${r.year ? ` (${r.year})` : ''}`);
  } catch {
    return [];
  }
}

/** Load ALL recommendation history titles up to `cap` (full already-recommended/ignored set). */
export function allHistoryTitles(historyFile: string, cap: number): string[] {
  if (!existsSync(historyFile)) return [];
  try {
    const hist = JSON.parse(readFileSync(historyFile, 'utf8')) as RecsHistoryFile;
    const recs = Array.isArray(hist.recommended) ? hist.recommended : [];
    return recs.slice(-cap).map((r) => `${r.title}${r.year ? ` (${r.year})` : ''}`);
  } catch {
    return [];
  }
}

/**
 * Titles of currently owner-IGNORED recommendations (T404) — formatted identically
 * to {@link allHistoryTitles}'s `"Title (Year)"` / bare `"Title"` output, so it can
 * be concatenated straight into the same exclude list. An ignore recorded before
 * this fix (or without a recoverable title) has no `detail.title` and is skipped
 * rather than crashing.
 */
export function ignoredSuggestionTitles(jobName: string = RECS_JOB): string[] {
  return ignoredWorkItemDetails(jobName)
    .map((row) => row.detail as { title?: unknown; year?: unknown } | null)
    .filter((d): d is { title?: unknown; year?: unknown } => !!d && typeof d.title === 'string' && d.title.trim() !== '')
    .map((d) => `${d.title as string}${typeof d.year === 'number' ? ` (${d.year})` : ''}`);
}

function writeBranchFile(recsDir: string, file: BranchOutputFile): string {
  const path = join(recsDir, `${file.branchId}.json`);
  writeFileSync(path, JSON.stringify(file, null, 2));
  return path;
}

/**
 * Run ONE TV recommender branch: build its prompt from the taste profile + a
 * stratified library sample, call Claude for diverse un-owned show recommendations,
 * and write raw suggestions to data/out/recs/<branchId>.json. Resilient — a
 * Claude error, rate-limit, junk reply, or no-target branch writes an EMPTY
 * suggestions file and returns normally.
 *
 * Every Claude call goes through `runClaude` from `src/services/claude.ts`, which
 * routes via `callService('claude-cli', …)` — the rate-limit + monthly quota are
 * enforced globally. Never call the CLI directly.
 */
export async function runBranch(ctx: JobContext, spec: BranchSpec, opts: BranchOpts = {}): Promise<void> {
  ensureDirs();
  const run = opts.runClaude ?? runClaude;
  const snapshotFile = opts.snapshotFile ?? tvRecsConfig.snapshotOut;
  const tasteFile = opts.tasteFile ?? tvRecsConfig.tasteOut;
  const historyFile = opts.historyFile ?? tvRecsConfig.recsHistoryOut;
  const recsDir = opts.recsDir ?? tvRecsConfig.recsDir;
  const now = opts.now ?? new Date();

  ctx.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ctx.log(`${spec.id} (${spec.lens}) starting`);
  ctx.progress(10, 'loading snapshot');

  if (!existsSync(snapshotFile) || !existsSync(tasteFile)) {
    throw new Error(`snapshot/taste-profile not found — run tv-snapshot first (${snapshotFile}).`);
  }
  const snapshot = JSON.parse(readFileSync(snapshotFile, 'utf8')) as TvSnapshotFile;
  const taste = JSON.parse(readFileSync(tasteFile, 'utf8')) as TvTasteProfileFile;
  const shows = snapshot.shows ?? [];
  const recent = recentTitles(historyFile, tvRecsConfig.recsRecentWindow);
  // T404: also exclude currently owner-ignored recommendations, not just historied ones.
  const alreadySuggested = [...new Set([
    ...allHistoryTitles(historyFile, tvRecsConfig.recsHistoryContext),
    ...ignoredSuggestionTitles(),
  ])];
  ctx.log(`Loaded ${shows.length} owned shows; ${alreadySuggested.length} already-suggested title(s) to avoid (full history + ignored, capped at ${tvRecsConfig.recsHistoryContext}).`);

  const base: BranchOutputFile = { branchId: spec.id, lens: spec.lens, generatedAt: now.toISOString(), suggestions: [] };

  ctx.progress(30, 'building prompt');
  const prompt = spec.build({
    profile: taste.profile, shows, recent, alreadySuggested,
    sampleSize: tvRecsConfig.recsSampleSize, ask: tvRecsConfig.recsPerBranchAsk,
  });
  if (prompt == null) {
    ctx.log('Branch has nothing to target (e.g. no qualifying creators) — skipping gracefully.', 'warn');
    writeBranchFile(recsDir, { ...base, error: 'no targets for this branch' });
    ctx.progress(100, 'skipped (no targets)');
    return;
  }

  ctx.progress(50, 'asking claude');
  ctx.log(`Calling Claude (${tvRecsConfig.recsModel}) for ~${tvRecsConfig.recsPerBranchAsk} recommendations…`);
  const res = await run(prompt, tvRecsConfig.recsModel);
  if (!res.ok) {
    const why = res.rateLimited ? 'rate/usage limit' : (res.error ?? 'claude error');
    ctx.log(`Claude call failed (${why}) — skipping this branch (run continues).`, 'warn');
    writeBranchFile(recsDir, { ...base, error: why });
    ctx.progress(100, 'skipped (claude error)');
    return;
  }

  let suggestions: RawSuggestion[] = [];
  try {
    suggestions = parseSuggestions(res.text, spec.lens);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.log(`Could not parse Claude output as recommendations (${msg}) — skipping branch.`, 'warn');
    writeBranchFile(recsDir, { ...base, error: `unparseable: ${msg}` });
    ctx.progress(100, 'skipped (junk output)');
    return;
  }

  const path = writeBranchFile(recsDir, { ...base, suggestions });
  for (const s of suggestions) ctx.log(`  • ${s.title}${s.year ? ` (${s.year})` : ''} — ${s.reason}`);
  ctx.progress(100, `${suggestions.length} suggestion(s)`);
  ctx.log(`Wrote ${suggestions.length} suggestion(s) → ${path}`);
}

/**
 * Run ONE branch IN-MEMORY for the merge top-up loop: build its prompt (with the
 * top-up `exclude` list), call Claude, parse → raw suggestions. No file I/O.
 * Resilient: null prompt, Claude error, or unparseable output all yield `[]`.
 */
export async function collectBranchSuggestions(
  spec: BranchSpec,
  ctx: BranchContext,
  run: RunClaudeFn,
  model: string,
): Promise<RawSuggestion[]> {
  const prompt = spec.build(ctx);
  if (prompt == null) return [];
  const res = await run(prompt, model);
  if (!res.ok) return [];
  try {
    return parseSuggestions(res.text, spec.lens);
  } catch {
    return [];
  }
}

/**
 * Build the thin JobDefinition wrapper for ONE TV recommender branch.
 * Each branch's *.job.ts calls this with its id.
 */
export function makeBranchJob(id: string) {
  const spec = branchById(id);
  return {
    name: spec.id,
    description: spec.description,
    timeoutMs: 600_000,
    maxRetries: 1,
    // Gate every edge: the branch consumes the TV snapshot and produces its own
    // raw-suggestions file so the framework derives a gate for each branch→merge edge.
    consumes: [tvSnapshotContract()],
    produces: [tvBranchSuggestionsContract(spec.id)],
    async run(ctx: JobContext) {
      await runBranch(ctx, spec);
    },
  };
}
