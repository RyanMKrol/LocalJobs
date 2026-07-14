// Generic recommender notify stage (T561) — the terminal digest/report/history
// stage shared by every domain. Reads the TMDB-verified recommendations, drops
// anything the owner has manually IGNORED, finds the ones NOT already in the
// "notified" ledger, sends a digest, then marks each notified recommendation
// done so it never repeats. Also (re)writes a report and appends newly-notified
// recommendations to the history file.
//
// The push-then-mark guard is load-bearing: the digest is sent BEFORE any
// ledger row is written or history appended, and a failed push THROWS instead
// of marking anything — so a retried run re-sends instead of silently losing
// recommendations.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { push } from '../notifier.js';
import { ignoredItemKeys, isWorkItemDone, markWorkItem } from '../../db/store.js';
import type { JobContext } from '../types.js';
import { recKey } from './pure.js';
import type { Recommendation, RecommendationsFile, RecommenderDomain, RecsHistoryFile } from './types.js';

/** A push function shaped like core/notifier `push` (injectable for tests). */
export type PushFn = typeof push;

export interface NotifyRunOpts {
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
 * Terminal stage — the recommendations digest. Reads the TMDB-verified
 * recommendations, drops anything the owner has manually IGNORED, finds the
 * ones NOT already in the "notified" ledger, sends a digest, then marks each
 * notified recommendation done so it never repeats. Also (re)writes a report
 * and appends newly-notified recommendations to the history file, which is fed
 * back into future branch prompts so picks vary.
 *
 * The ledger (`domain.recsJob`) is a "notified" log, NOT a work-done log —
 * keyed by the recommended item's tmdb id — so an item is recommended at most
 * once ever and an `ignored` rec leaves BOTH the report AND notifications.
 */
export async function runRecsNotify<M, P>(
  ctx: JobContext,
  domain: RecommenderDomain<M, P>,
  opts: NotifyRunOpts = {},
): Promise<void> {
  const pushFn = opts.push ?? push;
  const now = opts.now ?? new Date();
  const recsFile = opts.recsFile ?? domain.config.recsOut;
  const historyFile = opts.historyFile ?? domain.config.recsHistoryOut;
  const reportDir = opts.reportDir ?? domain.config.reportDir;

  ctx.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ctx.log(`${domain.notifyStageName} starting`);

  const allRecs: Recommendation[] = existsSync(recsFile)
    ? ((JSON.parse(readFileSync(recsFile, 'utf8')) as RecommendationsFile).recommendations ?? [])
    : [];
  const ignoredRecs = ignoredItemKeys(domain.recsJob);
  const recs = allRecs.filter((r) => !ignoredRecs.has(recKey(r.tmdbId)));
  const ignoredRecCount = allRecs.length - recs.length;
  ctx.log(`Loaded ${allRecs.length} recommendation(s); ${ignoredRecCount} owner-ignored excluded → ${recs.length} active.`);
  if (ignoredRecCount > 0) {
    const excludedRecs = allRecs.filter((r) => ignoredRecs.has(recKey(r.tmdbId)));
    for (const r of excludedRecs) ctx.log(`  ✕ ignored rec: "${r.title}"${r.year ? ` (${r.year})` : ''} tmdb=${r.tmdbId}`);
  }

  const newRecs = recs.filter((r) => !isWorkItemDone(domain.recsJob, recKey(r.tmdbId), 1));
  ctx.log(`Newly-detected: ${newRecs.length} recommendation(s) (already notified: ${recs.length - newRecs.length}).`);
  const alreadyNotifiedRecs = recs.filter((r) => isWorkItemDone(domain.recsJob, recKey(r.tmdbId), 1));
  for (const r of alreadyNotifiedRecs) ctx.log(`  ↩ already notified rec: "${r.title}"${r.year ? ` (${r.year})` : ''}`);

  // Always (re)write the markdown report of the current active recommendations.
  const reportPath = writeReport(domain, recs, newRecs, now, reportDir);
  ctx.log(`Wrote report ${reportPath}`);

  if (newRecs.length === 0) {
    ctx.progress(100, 'nothing new to notify');
    ctx.log('Nothing new — no digest sent. ✓');
    return;
  }

  const digest = domain.buildDigest(newRecs);
  ctx.log(`Digest: ${digest.title} — ${digest.body}`);
  const res = await pushFn(digest.title, digest.body, { job: domain.pushJob, tags: domain.pushTags, priority: 'default' });
  ctx.log(res.ok ? `digest push sent — ${digest.title}` : `digest push FAILED (${res.error})`, res.ok ? 'info' : 'error');

  if (!res.ok) {
    throw new Error(
      `digest push failed (${res.error}) — ${newRecs.length} rec(s) ` +
      'were NOT marked notified so the next run retries the digest.',
    );
  }

  for (const r of newRecs) {
    markWorkItem(domain.recsJob, recKey(r.tmdbId), 'success', {
      detail: {
        name: `${r.title}${r.year ? ` (${r.year})` : ''}`,
        markdown: reportPath,
        title: r.title,
        year: r.year,
        lens: r.lens,
        genre: r.genre,
        reason: r.reason,
        tmdbRating: r.tmdbRating,
        ...(domain.extraNotifyDetail ? domain.extraNotifyDetail(r) : {}),
      },
    });
  }
  appendHistory(historyFile, newRecs, now);

  ctx.progress(100, `${newRecs.length} rec(s) notified`);
  ctx.log(`Marked ${newRecs.length} recommendation(s) notified.`);
}

/**
 * Write the report markdown listing the current active recommendations. Returns
 * its absolute path. Newly-detected recommendations are flagged 🆕.
 */
function writeReport<M, P>(
  domain: RecommenderDomain<M, P>,
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
    domain.reportHeading,
    '',
    '## Recommendations',
    '',
  ];
  if (recs.length === 0) {
    lines.push(domain.reportEmptyLine, '');
  } else {
    for (const r of [...recs].sort((a, b) => a.genre.localeCompare(b.genre) || a.title.localeCompare(b.title))) {
      const isNew = newRecKeys.has(recKey(r.tmdbId));
      const rating = r.tmdbRating != null ? ` — TMDB ${r.tmdbRating.toFixed(1)}` : '';
      lines.push(`- [${r.title}](${domain.tmdbUrl(r.tmdbId)})${r.year ? ` (${r.year})` : ''} _(${r.lens})_${rating}${isNew ? ' 🆕' : ''}  \n  ${r.reason}`);
    }
    lines.push('');
  }

  const path = join(reportDir, domain.reportFilename);
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
