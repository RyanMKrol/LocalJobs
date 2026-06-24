import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { push } from '../../../core/notifier.js';
import { ignoredItemKeys, isWorkItemDone, markWorkItem } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';
import { moviesConfig } from '../config.js';
import { ensureDirs } from '../lib.js';
import type { FranchiseGap, FranchiseGapsFile } from '../types.js';

/** The work_items key-space for the "already-notified / ignored" ledger. */
export const NOTIFY_JOB = 'movie-gaps-notify';

/** Ledger key for one franchise gap: the missing film's tmdb id, as a string. */
export function gapKey(tmdbId: number): string {
  return String(tmdbId);
}

/** Build the single digest push: title carries the count, body a sample of titles. */
export function buildDigest(newGaps: FranchiseGap[]): { count: number; title: string; body: string } {
  const count = newGaps.length;
  // Body lists the missing films (cap the body so a 167-item first run isn't huge).
  const names = newGaps.map((g) => g.title);
  const shown = names.slice(0, 12);
  const body = shown.join(', ') + (names.length > shown.length ? `, +${names.length - shown.length} more` : '');
  return {
    count,
    title: `🎬 ${count} franchise gap${count === 1 ? '' : 's'} detected`,
    body,
  };
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
 * Stage 3 — read the fresh franchise gaps, drop any the owner has manually
 * IGNORED, find the ones NOT already in the "notified" ledger, send ONE digest
 * push of the newly-detected gaps, then mark each notified gap done so it's never
 * repeated. Also (re)writes a monthly markdown report of all CURRENT non-ignored
 * gaps grouped by collection (recorded as the ledger items' `detail.markdown`,
 * T110). FIRST run = one big digest of the whole backlog (~167); if nothing is
 * new, sends nothing.
 *
 * The ledger here is a "notified" log, NOT a work-done log — only this stage uses
 * it. Ledger rows are recorded ONLY for surfaced gaps so the workflow-run IO
 * panel highlights those. An `ignored` row (set by the owner) excludes the gap
 * from BOTH the report AND notifications and never resurfaces.
 */
export async function runNotify(ctx: JobContext, opts: NotifyOpts = {}): Promise<void> {
  ensureDirs();
  const pushFn = opts.push ?? push;
  const now = opts.now ?? new Date();
  const gapsFile = opts.gapsFile ?? moviesConfig.gapsOut;
  const reportDir = opts.reportDir ?? moviesConfig.reportDir;

  ctx.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ctx.log('movie-gaps-notify starting');
  if (!existsSync(gapsFile)) {
    throw new Error(`franchise-gaps.json not found — run franchise-gaps first (${gapsFile}).`);
  }
  const file = JSON.parse(readFileSync(gapsFile, 'utf8')) as FranchiseGapsFile;
  const allGaps = file.gaps ?? [];

  // Drop owner-ignored gaps up front — they leave BOTH the report AND notifications.
  const ignored = ignoredItemKeys(NOTIFY_JOB);
  const gaps = allGaps.filter((g) => !ignored.has(gapKey(g.tmdbId)));
  const ignoredCount = allGaps.length - gaps.length;
  ctx.log(`Loaded ${allGaps.length} franchise gap(s); ${ignoredCount} owner-ignored excluded → ${gaps.length} active.`);

  // Newly-detected (not yet in the ledger) vs already-notified.
  const newGaps = gaps.filter((g) => !isWorkItemDone(NOTIFY_JOB, gapKey(g.tmdbId), 1));
  const alreadyKnown = gaps.length - newGaps.length;
  ctx.log(`Newly-detected gaps: ${newGaps.length} (already notified previously: ${alreadyKnown}).`);

  // Always (re)write the markdown report of the current active backlog.
  const reportPath = writeReport(gaps, newGaps, now, reportDir);
  ctx.log(`Wrote report ${reportPath}`);

  if (newGaps.length === 0) {
    ctx.progress(100, 'nothing new to notify');
    ctx.log('Nothing new — no digest sent. ✓');
    return;
  }

  // Send ONE digest, then record each notified gap so it never repeats.
  const digest = buildDigest(newGaps);
  ctx.log(`Digest: ${digest.title} — ${digest.body}`);
  const res = await pushFn(digest.title, digest.body, { job: 'movies', tags: 'movie_camera', priority: 'default' });
  ctx.log(res.ok ? `digest push sent — ${digest.title}` : `digest push FAILED (${res.error})`, res.ok ? 'info' : 'error');

  for (const g of newGaps) {
    markWorkItem(NOTIFY_JOB, gapKey(g.tmdbId), 'success', {
      detail: { name: `${g.collectionName}: ${g.title}`, markdown: reportPath },
    });
  }

  ctx.progress(100, `${newGaps.length} new gap(s) notified`);
  ctx.log(`Marked ${newGaps.length} gap(s) notified.`);
}

/** A TMDB movie link for the report. */
function tmdbLink(tmdbId: number): string {
  return `https://www.themoviedb.org/movie/${tmdbId}`;
}

/**
 * Write a markdown report of the current active backlog grouped by collection;
 * returns its absolute path. Each gap carries its TMDB rating + a TMDB link;
 * newly-detected gaps are flagged 🆕.
 */
function writeReport(gaps: FranchiseGap[], newGaps: FranchiseGap[], now: Date, reportDir: string): string {
  const newKeys = new Set(newGaps.map((g) => gapKey(g.tmdbId)));

  // Group by collection (sorted by name; films sorted by year then title).
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
    `newlyDetected: ${newGaps.length}`,
    '---',
    '',
    '# Plex — franchise films you don\'t own',
    '',
  ];
  if (gaps.length === 0) {
    lines.push('_No franchise gaps — every collection you own a film from is complete._', '');
  }
  for (const name of [...byCollection.keys()].sort((a, b) => a.localeCompare(b))) {
    const films = (byCollection.get(name) ?? []).sort(
      (a, b) => (a.year ?? 0) - (b.year ?? 0) || a.title.localeCompare(b.title));
    lines.push(`## ${name}`, '');
    for (const g of films) {
      const isNew = newKeys.has(gapKey(g.tmdbId));
      const rating = g.tmdbRating != null ? ` — TMDB ${g.tmdbRating.toFixed(1)}` : '';
      lines.push(`- [${g.title}](${tmdbLink(g.tmdbId)})${g.year ? ` (${g.year})` : ''}${rating}${isNew ? ' 🆕' : ''}`);
    }
    lines.push('');
  }

  const path = join(reportDir, 'franchise-gaps.md');
  writeFileSync(path, lines.join('\n'));
  return path;
}
