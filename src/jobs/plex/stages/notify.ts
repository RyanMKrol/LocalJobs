import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { push } from '../../../core/notifier.js';
import { isWorkItemDone, markWorkItem } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';
import { plexConfig } from '../config.js';
import { ensureDirs, formatSeasonRanges } from '../lib.js';
import type { MissingSeasonsFile, ShowMissingSeasons } from '../types.js';

/** The work_items key-space for the "already-notified" ledger. */
export const NOTIFY_JOB = 'plex-seasons-notify';

/** Ledger key for one (show, season) pair: `<tmdbId>::S<season>`. */
export function pairKey(tmdbId: number, season: number): string {
  return `${tmdbId}::S${season}`;
}

/** Newly-detected seasons per show, in input order. */
interface NewShow {
  title: string;
  tmdbId: number;
  seasons: number[];
}

/** Build the single digest push: title carries the count, body the show list. */
export function buildDigest(newShows: NewShow[]): { count: number; title: string; body: string } {
  const count = newShows.reduce((n, s) => n + s.seasons.length, 0);
  const lines = newShows.map((s) => `${s.title} ${formatSeasonRanges(s.seasons)}`);
  return {
    count,
    title: `📺 ${count} new season${count === 1 ? '' : 's'} available`,
    body: lines.join(', '),
  };
}

/** A push function shaped like core/notifier `push` (injectable for tests). */
export type PushFn = typeof push;

export interface NotifyOpts {
  /** Override the digest push (tests). Defaults to the real `push`. */
  push?: PushFn;
  /** Override "now" (tests). Defaults to a fresh Date. */
  now?: Date;
  /** Override the missing-seasons file path (tests). */
  missingFile?: string;
}

/**
 * Stage 3 — gather every (show, complete-missing-season) pair, find the ones NOT
 * already in the "notified" ledger, send ONE digest push of the newly-detected
 * seasons, then mark each notified pair done so it's never repeated. Also writes a
 * markdown report (recorded as the ledger items' `detail.markdown`, T110). FIRST
 * run = one big digest of the whole backlog; if nothing is new, sends nothing.
 *
 * The ledger here is a "notified" log, NOT a work-done log — only this stage uses
 * it. Ledger rows are recorded ONLY for actionable shows so the workflow-run IO
 * panel highlights those, not 600+ "up to date" rows.
 */
export async function runNotify(ctx: JobContext, opts: NotifyOpts = {}): Promise<void> {
  ensureDirs();
  const pushFn = opts.push ?? push;
  const now = opts.now ?? new Date();
  const missingFile = opts.missingFile ?? plexConfig.missingOut;

  ctx.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ctx.log('plex-seasons-notify starting');
  if (!existsSync(missingFile)) {
    throw new Error(`missing-seasons.json not found — run tmdb-season-check first (${missingFile}).`);
  }
  const file = JSON.parse(readFileSync(missingFile, 'utf8')) as MissingSeasonsFile;
  const shows = file.shows ?? [];
  ctx.log(`Loaded ${shows.length} actionable show(s) from the season check.`);

  // Split each actionable show's complete-missing seasons into newly-detected
  // (not yet in the ledger) vs already-notified.
  const newShows: NewShow[] = [];
  let alreadyKnown = 0;
  for (const s of shows) {
    const fresh = s.completeMissingSeasons.filter((season) => !isWorkItemDone(NOTIFY_JOB, pairKey(s.tmdbId, season), 1));
    alreadyKnown += s.completeMissingSeasons.length - fresh.length;
    if (fresh.length) newShows.push({ title: s.title, tmdbId: s.tmdbId, seasons: fresh });
  }
  const totalNew = newShows.reduce((n, s) => n + s.seasons.length, 0);
  ctx.log(`Newly-detected complete missing seasons: ${totalNew} (already notified previously: ${alreadyKnown}).`);

  // Always (re)write the markdown report of the current backlog, marking new vs known.
  const reportPath = writeReport(shows, newShows, now);
  ctx.log(`Wrote report ${reportPath}`);

  if (totalNew === 0) {
    ctx.progress(100, 'nothing new to notify');
    ctx.log('Nothing new — no digest sent. ✓');
    return;
  }

  // Send ONE digest, then record each notified pair so it never repeats.
  const digest = buildDigest(newShows);
  ctx.log(`Digest: ${digest.title} — ${digest.body}`);
  const res = await pushFn(digest.title, digest.body, { job: 'plex', tags: 'tv', priority: 'default' });
  ctx.log(res.ok ? `digest push sent — ${digest.title}` : `digest push FAILED (${res.error})`, res.ok ? 'info' : 'error');

  for (const s of newShows) {
    for (const season of s.seasons) {
      markWorkItem(NOTIFY_JOB, pairKey(s.tmdbId, season), 'success', {
        detail: { name: `${s.title} S${season}`, markdown: reportPath },
      });
    }
  }

  ctx.progress(100, `${totalNew} new season(s) notified`);
  ctx.log(`Marked ${totalNew} (show, season) pair(s) notified.`);
}

/** Write a markdown report of the current backlog; returns its absolute path. */
function writeReport(shows: ShowMissingSeasons[], newShows: NewShow[], now: Date): string {
  const newKeys = new Set<string>();
  for (const s of newShows) for (const season of s.seasons) newKeys.add(pairKey(s.tmdbId, season));

  const lines: string[] = [
    '---',
    `generatedAt: ${now.toISOString()}`,
    `actionableShows: ${shows.length}`,
    `newlyDetected: ${newShows.reduce((n, s) => n + s.seasons.length, 0)}`,
    '---',
    '',
    '# Plex — complete seasons you don\'t own',
    '',
  ];
  if (shows.length === 0) {
    lines.push('_Nothing missing — your library is up to date._', '');
  }
  for (const s of [...shows].sort((a, b) => a.title.localeCompare(b.title))) {
    const parts = s.completeMissingSeasons.map((season) => {
      const isNew = newKeys.has(pairKey(s.tmdbId, season));
      return `S${season}${isNew ? ' 🆕' : ''}`;
    });
    lines.push(`- **${s.title}**${s.year ? ` (${s.year})` : ''} — ${parts.join(', ')} _[${s.tmdbStatus}]_`);
  }
  lines.push('');

  const path = join(plexConfig.reportDir, 'missing-seasons.md');
  writeFileSync(path, lines.join('\n'));
  return path;
}
