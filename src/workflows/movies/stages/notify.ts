import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { push } from '../../../core/notifier.js';
import { ignoredItemKeys, isWorkItemDone, markWorkItem } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';
import { moviesConfig } from '../config.js';
import { ensureDirs } from '../lib.js';
import { RECS_JOB, recKey } from '../recs.js';
import type { Recommendation, RecommendationsFile, RecsHistoryFile } from '../types.js';

/**
 * T468 split note — these two constants used to live here alongside the
 * COMBINED gaps+recs digest this job used to send. That combined digest is
 * gone: `movie-gaps-notify` moved to the sibling `missing-movies` workflow
 * (`src/workflows/missing-movies/stages/notify.ts`, its own gaps-only job).
 *
 * `NOTIFY_JOB`/`gapKey` are kept here, UNUSED by this file's own recs-only
 * logic, purely so `src/api/server.ts`'s existing
 * `import { NOTIFY_JOB as MOVIE_GAPS_JOB, gapKey } from '../workflows/movies/stages/notify.js'`
 * keeps resolving without a code change — `src/api/server.ts` was out of scope
 * for the T468 build task. `missing-movies/stages/notify.ts` defines its own
 * copy of the same two constants (identical values) as the source of truth
 * going forward. A future task that also has `src/api/server.ts` in scope
 * should update that import to point at `missing-movies/stages/notify.js` and
 * delete this compatibility re-export.
 */
export const NOTIFY_JOB = 'movie-gaps-notify';
export function gapKey(tmdbId: number): string {
  return String(tmdbId);
}

/** Build the recs-only digest push. */
export function buildDigest(recs: Recommendation[]): { count: number; title: string; body: string } {
  const r = recs.length;
  const names = recs.map((x) => x.title).slice(0, 10);
  const body = names.join(', ') + (recs.length > names.length ? `, +${recs.length - names.length} more` : '');
  const title = `🍿 ${r} film recommendation${r === 1 ? '' : 's'}`;
  return { count: r, title, body };
}

/** A push function shaped like core/notifier `push` (injectable for tests). */
export type PushFn = typeof push;

export interface NotifyOpts {
  /** Override the digest push (tests). Defaults to the real `push`. */
  push?: PushFn;
  /** Override "now" (tests). Defaults to a fresh Date. */
  now?: Date;
  /** Override the recommendations file path (tests). */
  recsFile?: string;
  /** Override the recommended-history file path (tests). */
  historyFile?: string;
  /** Override the report output dir (tests). */
  reportDir?: string;
}

/**
 * Terminal stage — the monthly RECOMMENDATIONS-only digest (T468 split; this
 * used to also cover franchise gaps, now `missing-movies`'s own notify job).
 * Reads the TMDB-verified recommendations, drops anything the owner has
 * manually IGNORED, finds the ones NOT already in the "notified" ledger, sends
 * one digest, then marks each notified item done so it never repeats. Also
 * (re)writes a monthly markdown report and appends newly-notified films to the
 * history file, fed back into next month's branch prompts so picks vary.
 *
 * The ledger (`RECS_JOB`, keyed by the recommended film's tmdb id) is a
 * "notified" log, NOT a work-done log — a film is recommended at most once
 * ever, and an `ignored` rec leaves BOTH the report AND notifications.
 */
export async function runNotify(ctx: JobContext, opts: NotifyOpts = {}): Promise<void> {
  ensureDirs();
  const pushFn = opts.push ?? push;
  const now = opts.now ?? new Date();
  const recsFile = opts.recsFile ?? moviesConfig.recsOut;
  const historyFile = opts.historyFile ?? moviesConfig.recsHistoryOut;
  const reportDir = opts.reportDir ?? moviesConfig.reportDir;

  ctx.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ctx.log('movie-recs-notify starting');
  if (!existsSync(recsFile)) {
    throw new Error(`recommendations.json not found — run rec-merge first (${recsFile}).`);
  }
  const file = JSON.parse(readFileSync(recsFile, 'utf8')) as RecommendationsFile;
  const allRecs = file.recommendations ?? [];

  // Drop owner-ignored recs up front — they leave BOTH the report AND notifications.
  const ignoredRecs = ignoredItemKeys(RECS_JOB);
  const recs = allRecs.filter((r) => !ignoredRecs.has(recKey(r.tmdbId)));
  const ignoredRecCount = allRecs.length - recs.length;
  ctx.log(`Loaded ${allRecs.length} recommendation(s); ${ignoredRecCount} owner-ignored excluded → ${recs.length} active.`);
  if (ignoredRecCount > 0) {
    const excludedRecs = allRecs.filter((r) => ignoredRecs.has(recKey(r.tmdbId)));
    for (const r of excludedRecs) ctx.log(`  ✕ ignored rec: "${r.title}"${r.year ? ` (${r.year})` : ''} tmdb=${r.tmdbId}`);
  }

  // Newly-detected (not yet in the ledger).
  const newRecs = recs.filter((r) => !isWorkItemDone(RECS_JOB, recKey(r.tmdbId), 1));
  ctx.log(`Newly-detected: ${newRecs.length} recommendation(s) (already notified: ${recs.length - newRecs.length}).`);
  const alreadyNotifiedRecs = recs.filter((r) => isWorkItemDone(RECS_JOB, recKey(r.tmdbId), 1));
  for (const r of alreadyNotifiedRecs) ctx.log(`  ↩ already notified rec: "${r.title}"${r.year ? ` (${r.year})` : ''}`);

  // Always (re)write the markdown report of the current active backlog.
  const reportPath = writeReport(recs, newRecs, now, reportDir);
  ctx.log(`Wrote report ${reportPath}`);

  if (newRecs.length === 0) {
    ctx.progress(100, 'nothing new to notify');
    ctx.log('Nothing new — no digest sent. ✓');
    return;
  }

  // Send ONE digest of the new picks, then record each notified item.
  const digest = buildDigest(newRecs);
  ctx.log(`Digest: ${digest.title} — ${digest.body}`);
  const res = await pushFn(digest.title, digest.body, { job: 'movies', tags: 'movie_camera', priority: 'default' });
  ctx.log(res.ok ? `digest push sent — ${digest.title}` : `digest push FAILED (${res.error})`, res.ok ? 'info' : 'error');

  if (!res.ok) {
    throw new Error(
      `digest push failed (${res.error}) — ${newRecs.length} rec(s) ` +
      'were NOT marked notified so the next run retries the digest.',
    );
  }

  for (const r of newRecs) {
    markWorkItem(RECS_JOB, recKey(r.tmdbId), 'success', {
      detail: {
        name: `${r.title} (${r.lens})`,
        markdown: reportPath,
        title: r.title,
        year: r.year,
        lens: r.lens,
        genre: r.genre,
        reason: r.reason,
        tmdbRating: r.tmdbRating,
      },
    });
  }
  appendHistory(historyFile, newRecs, now);

  ctx.progress(100, `${newRecs.length} rec(s) notified`);
  ctx.log(`Marked ${newRecs.length} recommendation(s) notified.`);
}

/** A TMDB movie link for the report. */
function tmdbLink(tmdbId: number): string {
  return `https://www.themoviedb.org/movie/${tmdbId}`;
}

/**
 * Write the monthly markdown report of the current active recommendation
 * backlog (each rec with its lens, reason, and TMDB link). Returns its
 * absolute path. Newly-detected items are flagged 🆕.
 */
function writeReport(
  recs: Recommendation[],
  newRecs: Recommendation[],
  now: Date,
  reportDir: string,
): string {
  const newRecKeys = new Set(newRecs.map((r) => recKey(r.tmdbId)));

  const lines: string[] = [
    '---',
    `generatedAt: ${now.toISOString()}`,
    `recommendations: ${recs.length}`,
    `newRecommendations: ${newRecs.length}`,
    '---',
    '',
    '# Plex movie recommendations',
    '',
    '## Recommendations',
    '',
  ];
  if (recs.length === 0) {
    lines.push('_No recommendations this month._', '');
  } else {
    for (const r of [...recs].sort((a, b) => a.genre.localeCompare(b.genre) || a.title.localeCompare(b.title))) {
      const isNew = newRecKeys.has(recKey(r.tmdbId));
      const rating = r.tmdbRating != null ? ` — TMDB ${r.tmdbRating.toFixed(1)}` : '';
      lines.push(`- [${r.title}](${tmdbLink(r.tmdbId)})${r.year ? ` (${r.year})` : ''} _(${r.lens})_${rating}${isNew ? ' 🆕' : ''}  \n  ${r.reason}`);
    }
    lines.push('');
  }

  const path = join(reportDir, 'recommendations.md');
  writeFileSync(path, lines.join('\n'));
  return path;
}

/** Append newly-notified recommendations to the history file (fed back into prompts). */
function appendHistory(historyFile: string, newRecs: Recommendation[], now: Date): void {
  let hist: RecsHistoryFile = { recommended: [] };
  if (existsSync(historyFile)) {
    try {
      const parsed = JSON.parse(readFileSync(historyFile, 'utf8')) as RecsHistoryFile;
      if (Array.isArray(parsed.recommended)) hist = parsed;
    } catch { /* corrupt history → start fresh */ }
  }
  for (const r of newRecs) {
    hist.recommended.push({ tmdbId: r.tmdbId, title: r.title, year: r.year, at: now.toISOString() });
  }
  writeFileSync(historyFile, JSON.stringify(hist, null, 2));
}
