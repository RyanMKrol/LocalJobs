import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { push } from '../../../core/notifier.js';
import { ignoredItemKeys, isWorkItemDone, markWorkItem } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';
import type { FranchiseGap, FranchiseGapsFile } from '../../movies/types.js';
import { missingMoviesConfig } from '../config.js';
import { ensureDirs } from '../lib.js';

/** The work_items key-space for the franchise-gap "already-notified / ignored" ledger.
 *  Unchanged from before the T468 split — no work_items migration needed. */
export const NOTIFY_JOB = 'movie-gaps-notify';

/** Ledger key for one franchise gap: the missing film's tmdb id, as a string. */
export function gapKey(tmdbId: number): string {
  return String(tmdbId);
}

/** Build the gaps-only digest push. */
export function buildDigest(newGaps: FranchiseGap[]): { count: number; title: string; body: string } {
  const g = newGaps.length;
  const gapNames = newGaps.map((x) => x.title).slice(0, 10);
  const body = gapNames.join(', ') + (newGaps.length > gapNames.length ? `, +${newGaps.length - gapNames.length} more` : '');
  const title = `🎬 ${g} franchise gap${g === 1 ? '' : 's'} detected`;
  return { count: g, title, body };
}

/** A push function shaped like core/notifier `push` (injectable for tests). */
export type PushFn = typeof push;

export interface NotifyOpts {
  /** Override the digest push (tests). Defaults to the real `push`. */
  push?: PushFn;
  /** Override "now" (tests). Defaults to a fresh Date. */
  now?: Date;
  /** Override the franchise-gaps file path (tests). */
  gapsFile?: string;
  /** Override the report output dir (tests). */
  reportDir?: string;
}

/**
 * Stage 3 — the weekly franchise-gap digest. Reads the fresh franchise gaps,
 * drops anything the owner has manually IGNORED, finds the ones NOT already in
 * the "notified" ledger, sends a digest covering the newly-detected gaps, then
 * marks each notified gap done so it never repeats. Also (re)writes a markdown
 * report grouped by collection.
 *
 * The ledger is a "notified" log, NOT a work-done log — keyed by the missing
 * film's tmdb id (`movie-gaps-notify`, unchanged from before the split) — so a
 * gap is notified at most once ever and an `ignored` gap leaves BOTH the report
 * AND notifications.
 */
export async function runNotify(ctx: JobContext, opts: NotifyOpts = {}): Promise<void> {
  ensureDirs();
  const pushFn = opts.push ?? push;
  const now = opts.now ?? new Date();
  const gapsFile = opts.gapsFile ?? missingMoviesConfig.gapsOut;
  const reportDir = opts.reportDir ?? missingMoviesConfig.reportDir;

  ctx.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ctx.log('movie-gaps-notify starting');
  if (!existsSync(gapsFile)) {
    throw new Error(`franchise-gaps.json not found — run franchise-gaps first (${gapsFile}).`);
  }
  const file = JSON.parse(readFileSync(gapsFile, 'utf8')) as FranchiseGapsFile;
  const allGaps = file.gaps ?? [];

  // Drop owner-ignored gaps up front — they leave BOTH the report AND notifications.
  const ignoredGaps = ignoredItemKeys(NOTIFY_JOB);
  const gaps = allGaps.filter((g) => !ignoredGaps.has(gapKey(g.tmdbId)));
  const ignoredGapCount = allGaps.length - gaps.length;
  ctx.log(`Loaded ${allGaps.length} franchise gap(s); ${ignoredGapCount} owner-ignored excluded → ${gaps.length} active.`);
  if (ignoredGapCount > 0) {
    const excluded = allGaps.filter((g) => ignoredGaps.has(gapKey(g.tmdbId)));
    for (const g of excluded) ctx.log(`  ✕ ignored gap: "${g.collectionName}: ${g.title}"${g.year ? ` (${g.year})` : ''} tmdb=${g.tmdbId}`);
  }

  // Newly-detected (not yet in the ledger).
  const newGaps = gaps.filter((g) => !isWorkItemDone(NOTIFY_JOB, gapKey(g.tmdbId), 1));
  ctx.log(`Newly-detected: ${newGaps.length} gap(s) (already notified: ${gaps.length - newGaps.length}).`);
  const alreadyNotifiedGaps = gaps.filter((g) => isWorkItemDone(NOTIFY_JOB, gapKey(g.tmdbId), 1));
  for (const g of alreadyNotifiedGaps) ctx.log(`  ↩ already notified gap: "${g.collectionName}: ${g.title}"${g.year ? ` (${g.year})` : ''}`);

  // Always (re)write the markdown report of the current active franchise gaps.
  const collectionExamples = file.collectionExamples ?? {};
  const reportPath = writeReport(gaps, newGaps, now, reportDir, collectionExamples);
  ctx.log(`Wrote report ${reportPath}`);

  if (newGaps.length === 0) {
    ctx.progress(100, 'nothing new to notify');
    ctx.log('Nothing new — no digest sent. ✓');
    return;
  }

  const digest = buildDigest(newGaps);
  ctx.log(`Digest: ${digest.title} — ${digest.body}`);
  const res = await pushFn(digest.title, digest.body, { job: 'missing-movies', tags: 'movie_camera', priority: 'default' });
  ctx.log(res.ok ? `digest push sent — ${digest.title}` : `digest push FAILED (${res.error})`, res.ok ? 'info' : 'error');

  if (!res.ok) {
    throw new Error(
      `digest push failed (${res.error}) — ${newGaps.length} gap(s) ` +
      'were NOT marked notified so the next run retries the digest.',
    );
  }

  for (const g of newGaps) {
    markWorkItem(NOTIFY_JOB, gapKey(g.tmdbId), 'success', {
      detail: {
        name: `${g.collectionName}: ${g.title}`,
        markdown: reportPath,
        title: g.title,
        year: g.year,
        collectionId: g.collectionId,
        collectionName: g.collectionName,
        tmdbRating: g.tmdbRating,
      },
    });
  }

  ctx.progress(100, `${newGaps.length} gap(s) notified`);
  ctx.log(`Marked ${newGaps.length} gap(s) notified.`);
}

/** A TMDB movie link for the report. */
function tmdbLink(tmdbId: number): string {
  return `https://www.themoviedb.org/movie/${tmdbId}`;
}

/**
 * Write the weekly franchise-gaps markdown report, grouped by collection.
 * Returns its absolute path. Newly-detected gaps are flagged 🆕.
 */
function writeReport(
  gaps: FranchiseGap[],
  newGaps: FranchiseGap[],
  now: Date,
  reportDir: string,
  collectionExamples: Record<string, { title: string; year: number | null }> = {},
): string {
  const newGapKeys = new Set(newGaps.map((g) => gapKey(g.tmdbId)));

  const byCollection = new Map<string, FranchiseGap[]>();
  for (const g of gaps) {
    const arr = byCollection.get(g.collectionName) ?? [];
    arr.push(g);
    byCollection.set(g.collectionName, arr);
  }

  const lines: string[] = [
    '---',
    `generatedAt: ${now.toISOString()}`,
    `franchiseGaps: ${gaps.length}`,
    `collections: ${byCollection.size}`,
    `newlyDetectedGaps: ${newGaps.length}`,
    '---',
    '',
    '# Plex movie franchise-gap audit',
    '',
    '## Franchise films you don\'t own',
    '',
  ];
  if (gaps.length === 0) {
    lines.push('_No franchise gaps — every collection you own a film from is complete._', '');
  }
  for (const name of [...byCollection.keys()].sort((a, b) => a.localeCompare(b))) {
    const films = (byCollection.get(name) ?? []).sort(
      (a, b) => (a.year ?? 0) - (b.year ?? 0) || a.title.localeCompare(b.title));
    lines.push(`### ${name}`, '');
    const example = collectionExamples[name];
    if (example) {
      lines.push(`_You own: ${example.title}${example.year != null ? ` (${example.year})` : ''}_`, '');
    }
    for (const g of films) {
      const isNew = newGapKeys.has(gapKey(g.tmdbId));
      const rating = g.tmdbRating != null ? ` — TMDB ${g.tmdbRating.toFixed(1)}` : '';
      lines.push(`- [${g.title}](${tmdbLink(g.tmdbId)})${g.year ? ` (${g.year})` : ''}${rating}${isNew ? ' 🆕' : ''}`);
    }
    lines.push('');
  }

  const path = join(reportDir, 'franchise-gaps.md');
  writeFileSync(path, lines.join('\n'));
  return path;
}
