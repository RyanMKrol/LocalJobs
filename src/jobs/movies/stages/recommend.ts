import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JobContext, JobDefinition } from '../../../core/types.js';
import { extractJsonObject, runClaude } from '../../../services/claude.js';
import type { ClaudeResult } from '../../../services/claude.js';
import { moviesConfig } from '../config.js';
import { branchSuggestionsContract, movieSnapshotContract } from '../contracts.js';
import { ensureDirs } from '../lib.js';
import { branchById } from './branches.js';
import type {
  BranchOutputFile,
  MovieSnapshotFile,
  RawSuggestion,
  RecsHistoryFile,
  TasteProfileFile,
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

/**
 * Load ALL recommendation history titles up to `cap` (T183) — the full already-
 * recommended/ignored set to pass to branch prompts so they avoid re-suggesting
 * across months, not just the recent window. Bounded at `cap` to keep prompts
 * token-sensible. Exported so merge.ts can reuse it in top-up rounds.
 */
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

/** Write a branch's output file (raw suggestions, or empty + error on skip/fail). */
function writeBranchFile(recsDir: string, file: BranchOutputFile): string {
  const path = join(recsDir, `${file.branchId}.json`);
  writeFileSync(path, JSON.stringify(file, null, 2));
  return path;
}

/**
 * Run ONE recommender branch: build its prompt from the taste profile + a
 * stratified library sample, ask Claude for ~5 diverse un-owned films, and write
 * its raw suggestions to data/out/recs/<branchId>.json. Resilient by design — a
 * Claude error, rate-limit, junk/no-JSON reply, or a branch with nothing to ask
 * writes an EMPTY suggestions file and returns normally (the run continues; the
 * merge stage simply has fewer candidates). It NEVER throws on LLM trouble.
 */
export async function runBranch(ctx: JobContext, spec: BranchSpec, opts: BranchOpts = {}): Promise<void> {
  ensureDirs();
  const run = opts.runClaude ?? runClaude;
  const snapshotFile = opts.snapshotFile ?? moviesConfig.snapshotOut;
  const tasteFile = opts.tasteFile ?? moviesConfig.tasteOut;
  const historyFile = opts.historyFile ?? moviesConfig.recsHistoryOut;
  const recsDir = opts.recsDir ?? moviesConfig.recsDir;
  const now = opts.now ?? new Date();

  ctx.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ctx.log(`${spec.id} (${spec.lens}) starting`);
  ctx.progress(10, 'loading snapshot');

  if (!existsSync(snapshotFile) || !existsSync(tasteFile)) {
    throw new Error(`snapshot/taste-profile not found — run movie-snapshot first (${snapshotFile}).`);
  }
  const snapshot = JSON.parse(readFileSync(snapshotFile, 'utf8')) as MovieSnapshotFile;
  const taste = JSON.parse(readFileSync(tasteFile, 'utf8')) as TasteProfileFile;
  const movies = snapshot.movies ?? [];
  const recent = recentTitles(historyFile, moviesConfig.recsRecentWindow);
  // T183: full bounded history so branches avoid re-suggesting across months, not just the recent window.
  const alreadySuggested = allHistoryTitles(historyFile, moviesConfig.recsHistoryContext);
  ctx.log(`Loaded ${movies.length} owned movies; ${alreadySuggested.length} already-suggested title(s) to avoid (full history, capped at ${moviesConfig.recsHistoryContext}).`);

  const base: BranchOutputFile = { branchId: spec.id, lens: spec.lens, generatedAt: now.toISOString(), suggestions: [] };

  ctx.progress(30, 'building prompt');
  const prompt = spec.build({
    profile: taste.profile, movies, recent, alreadySuggested,
    sampleSize: moviesConfig.recsSampleSize, ask: moviesConfig.recsPerBranchAsk,
  });
  if (prompt == null) {
    ctx.log('Branch has nothing to target (e.g. no qualifying directors) — skipping gracefully.', 'warn');
    writeBranchFile(recsDir, { ...base, error: 'no targets for this branch' });
    ctx.progress(100, 'skipped (no targets)');
    return;
  }

  ctx.progress(50, 'asking claude');
  ctx.log(`Calling Claude (${moviesConfig.recsModel}) for ~${moviesConfig.recsPerBranchAsk} recommendations…`);
  const res = await run(prompt, moviesConfig.recsModel);
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
 * Run ONE branch IN-MEMORY for the merge top-up loop (T162): build its prompt
 * (with the top-up `exclude` list folded in), call Claude, parse → raw
 * suggestions. No file I/O. Resilient: a null prompt (no targets), a Claude
 * error/rate-limit, or unparseable output all yield `[]` so the loop continues.
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
 * Build the thin JobDefinition for ONE recommender branch (its `*.job.ts` file
 * just calls this with its id). Each branch depends on movie-snapshot and is a
 * member of the `movies` workflow; it produces no gated artifact (an empty branch
 * is legitimate, so a gate would wrongly fail the run).
 */
export function makeBranchJob(id: string): JobDefinition {
  const spec = branchById(id);
  return {
    name: spec.id,
    description: spec.description,
    timeoutMs: 600_000, // ~10 min headroom for one Claude CLI call
    maxRetries: 1,      // LLM trouble is handled gracefully in-stage, not via retries
    // Gate every edge: the branch consumes the movie snapshot and produces its own raw-suggestions
    // file, so snapshot→branch and branch→rec-merge are both validated boundaries.
    consumes: [movieSnapshotContract()],
    produces: [branchSuggestionsContract(spec.id)],
    async run(ctx) {
      await runBranch(ctx, spec);
    },
  };
}
