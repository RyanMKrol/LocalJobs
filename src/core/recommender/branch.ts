// Generic recommender-branch runner (T561) — shared by every domain's branch
// jobs. A domain wires its own item/taste shapes, config paths, and lens prompt
// specs (see movies/tv-recs `stages/branches.ts`); this module owns the
// mechanics: loading the snapshot/taste/history, building the branch context,
// calling Claude, parsing its reply, and writing the per-branch output file.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ArtifactContract, JobContext, JobDefinition } from '../types.js';
import { extractJsonObject, runClaude } from '../../services/claude.js';
import type { ClaudeResult } from '../../services/claude.js';
import { ignoredWorkItemDetails } from '../../db/store.js';
import type {
  BranchContext,
  BranchOutputFile,
  BranchSpec,
  RawSuggestion,
  RecommenderDomain,
  RecsHistoryFile,
} from './types.js';

/** A Claude runner shaped like the shared helper (injectable for tests). */
export type RunClaudeFn = (prompt: string, model: string) => Promise<ClaudeResult>;

export interface BranchRunOpts {
  runClaude?: RunClaudeFn;
  snapshotFile?: string;
  tasteFile?: string;
  historyFile?: string;
  recsDir?: string;
  now?: Date;
  /**
   * Called once, right after `runBranch` writes this branch's suggestions file
   * (on every path — success, skip-no-targets, Claude error, unparseable reply) —
   * the hook that lets a domain (movies/tv-recs) record its own `work_items`
   * ledger row from the REAL job execution path (`makeBranchJob`'s `run(ctx)`),
   * not just from a direct call to a domain wrapper.
   */
  onBranchWritten?: (branchId: string, opts: BranchRunOpts) => void;
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
 * Load ALL recommendation history titles up to `cap` — the full already-
 * recommended/ignored set to pass to branch prompts so they avoid re-suggesting
 * across runs, not just the recent window. Bounded at `cap` to keep prompts
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

/**
 * Titles of currently owner-IGNORED recommendations — formatted identically to
 * {@link allHistoryTitles}'s `"Title (Year)"` / bare `"Title"` output, so it can
 * be concatenated straight into the same exclude list. An ignore recorded before
 * a recoverable-title detail existed (or without one) has no `detail.title` and
 * is skipped rather than crashing.
 */
export function ignoredSuggestionTitles(jobName: string): string[] {
  return ignoredWorkItemDetails(jobName)
    .map((row) => row.detail as { title?: unknown; year?: unknown } | null)
    .filter((d): d is { title?: unknown; year?: unknown } => !!d && typeof d.title === 'string' && d.title.trim() !== '')
    .map((d) => `${d.title as string}${typeof d.year === 'number' ? ` (${d.year})` : ''}`);
}

/** Write a branch's output file (raw suggestions, or empty + error on skip/fail). */
function writeBranchFile(recsDir: string, file: BranchOutputFile): string {
  const path = join(recsDir, `${file.branchId}.json`);
  writeFileSync(path, JSON.stringify(file, null, 2));
  return path;
}

/**
 * Run ONE recommender branch: build its prompt from the taste profile + a
 * stratified library sample, ask Claude for a batch of diverse un-owned items,
 * and write its raw suggestions to data/out/recs/<branchId>.json. Resilient by
 * design — a Claude error, rate-limit, junk/no-JSON reply, or a branch with
 * nothing to ask writes an EMPTY suggestions file and returns normally (the run
 * continues; the merge stage simply has fewer candidates). It NEVER throws on
 * LLM trouble.
 */
export async function runBranch<M, P>(
  ctx: JobContext,
  domain: RecommenderDomain<M, P>,
  spec: BranchSpec<M, P>,
  opts: BranchRunOpts = {},
): Promise<void> {
  const run = opts.runClaude ?? runClaude;
  const snapshotFile = opts.snapshotFile ?? domain.config.snapshotOut;
  const tasteFile = opts.tasteFile ?? domain.config.tasteOut;
  const historyFile = opts.historyFile ?? domain.config.recsHistoryOut;
  const recsDir = opts.recsDir ?? domain.config.recsDir;
  const now = opts.now ?? new Date();

  ctx.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ctx.log(`${spec.id} (${spec.lens}) starting`);
  ctx.progress(10, 'loading snapshot');

  if (!existsSync(snapshotFile) || !existsSync(tasteFile)) {
    throw new Error(`snapshot/taste-profile not found — run ${domain.snapshotStageName} first (${snapshotFile}).`);
  }
  const snapshot = JSON.parse(readFileSync(snapshotFile, 'utf8'));
  const taste = JSON.parse(readFileSync(tasteFile, 'utf8'));
  const items = domain.itemsOf(snapshot);
  const profile = domain.profileOf(taste);
  const recent = recentTitles(historyFile, domain.config.recsRecentWindow);
  const alreadySuggested = [...new Set([
    ...allHistoryTitles(historyFile, domain.config.recsHistoryContext),
    ...ignoredSuggestionTitles(domain.recsJob),
  ])];
  ctx.log(`Loaded ${items.length} owned item(s); ${alreadySuggested.length} already-suggested title(s) to avoid (full history + ignored, capped at ${domain.config.recsHistoryContext}).`);

  const base: BranchOutputFile = { branchId: spec.id, lens: spec.lens, generatedAt: now.toISOString(), suggestions: [] };

  ctx.progress(30, 'building prompt');
  const prompt = spec.build({
    profile, items, recent, alreadySuggested,
    sampleSize: domain.config.recsSampleSize, ask: domain.config.recsPerBranchAsk,
  });
  if (prompt == null) {
    ctx.log('Branch has nothing to target (e.g. no qualifying directors) — skipping gracefully.', 'warn');
    writeBranchFile(recsDir, { ...base, error: 'no targets for this branch' });
    opts.onBranchWritten?.(spec.id, opts);
    ctx.progress(100, 'skipped (no targets)');
    return;
  }

  ctx.progress(50, 'asking claude');
  ctx.log(`Calling Claude (${domain.config.recsModel}) for ~${domain.config.recsPerBranchAsk} recommendations…`);
  const res = await run(prompt, domain.config.recsModel);
  if (!res.ok) {
    const why = res.rateLimited ? 'rate/usage limit' : (res.error ?? 'claude error');
    ctx.log(`Claude call failed (${why}) — skipping this branch (run continues).`, 'warn');
    writeBranchFile(recsDir, { ...base, error: why });
    opts.onBranchWritten?.(spec.id, opts);
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
    opts.onBranchWritten?.(spec.id, opts);
    ctx.progress(100, 'skipped (junk output)');
    return;
  }

  const path = writeBranchFile(recsDir, { ...base, suggestions });
  for (const s of suggestions) ctx.log(`  • ${s.title}${s.year ? ` (${s.year})` : ''} — ${s.reason}`);
  opts.onBranchWritten?.(spec.id, opts);
  ctx.progress(100, `${suggestions.length} suggestion(s)`);
  ctx.log(`Wrote ${suggestions.length} suggestion(s) → ${path}`);
}

/**
 * Run ONE branch IN-MEMORY for the merge top-up loop: build its prompt (with the
 * top-up `exclude` list folded in), call Claude, parse → raw suggestions. No
 * file I/O. Resilient: a null prompt (no targets), a Claude error/rate-limit, or
 * unparseable output all yield `[]` so the loop continues.
 */
export async function collectBranchSuggestions<M, P>(
  spec: BranchSpec<M, P>,
  ctx: BranchContext<M, P>,
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

export interface MakeBranchJobOpts {
  /**
   * Called once, right after this branch's suggestions file is written, from the
   * REAL job execution path (`run(ctx)` below) — this is how a domain
   * (movies/tv-recs) records its own `work_items` ledger row. Without this hook
   * a domain's ledger-writing code is dead: the returned `run(ctx)` calls this
   * module's OWN `runBranch`, not a domain wrapper's, so anything the domain does
   * only after calling ITS OWN `runBranch` never actually executes.
   */
  onBranchWritten?: (branchId: string, opts: BranchRunOpts) => void;
  /** Extra opts to thread into `runBranch` (test-only — e.g. an injected `runClaude` + fixture paths). */
  runOpts?: BranchRunOpts;
}

/**
 * Build the thin JobDefinition for ONE recommender branch (its `*.job.ts` file
 * just calls the domain's own `makeBranchJob(id)` wrapper, which calls this with
 * its domain + gate contracts). Each branch consumes the snapshot and produces
 * its own raw-suggestions file; an empty branch is legitimate, so no gate would
 * wrongly fail the run.
 */
export function makeBranchJob<M, P>(
  domain: RecommenderDomain<M, P>,
  id: string,
  contracts: { consumes: ArtifactContract[]; produces: ArtifactContract[] },
  opts: MakeBranchJobOpts = {},
): JobDefinition {
  const spec = domain.branches.find((b) => b.id === id);
  if (!spec) throw new Error(`unknown recommender branch: ${id}`);
  return {
    name: spec.id,
    description: spec.description,
    timeoutMs: 600_000, // ~10 min headroom for one Claude CLI call
    maxRetries: 1,      // LLM trouble is handled gracefully in-stage, not via retries
    consumes: contracts.consumes,
    produces: contracts.produces,
    async run(ctx) {
      await runBranch(ctx, domain, spec, { ...opts.runOpts, onBranchWritten: opts.onBranchWritten });
    },
  };
}
