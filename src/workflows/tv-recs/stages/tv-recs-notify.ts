import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { push } from '../../../core/notifier.js';
import { ignoredItemKeys, isWorkItemDone, markWorkItem } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';
import { tvRecsConfig } from '../config.js';
import { ensureDirs } from '../lib.js';
import { RECS_JOB, recKey } from '../recs.js';
import type { Recommendation, RecommendationsFile, RecsHistoryFile } from '../types.js';

/** A push function shaped like core/notifier `push` (injectable for tests). */
export type PushFn = typeof push;

export interface NotifyOpts {
  push?: PushFn;
  now?: Date;
  recsFile?: string;
  historyFile?: string;
  reportDir?: string;
}

/** Build a digest title + body for the new TV recommendations. */
export function buildDigest(recs: Recommendation[]): { count: number; title: string; body: string } {
  const r = recs.length;
  const names = recs.map((x) => x.title).slice(0, 10);
  const body = names.join(', ') + (recs.length > names.length ? `, +${recs.length - names.length} more` : '');
  const title = `📺 ${r} TV show recommendation${r === 1 ? '' : 's'}`;
  return { count: r, title, body };
}

/**
 * Stage: monthly TV recommendations digest. Reads the verified recommendations.json
 * from tv-rec-merge, drops owner-ignored and already-notified shows, sends ONE digest
 * of just the new picks, marks each notified show success in the tv-recs ledger (so
 * it's never re-notified), and writes a markdown report under data/out/reports/.
 */
export async function runTvRecsNotify(ctx: JobContext, opts: NotifyOpts = {}): Promise<void> {
  ensureDirs();
  const pushFn = opts.push ?? push;
  const now = opts.now ?? new Date();
  const recsFile = opts.recsFile ?? tvRecsConfig.recsOut;
  const historyFile = opts.historyFile ?? tvRecsConfig.recsHistoryOut;
  const reportDir = opts.reportDir ?? tvRecsConfig.reportDir;

  ctx.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ctx.log('tv-recs-notify starting');
  ctx.log(`recsFile: ${recsFile}`);
  ctx.log(`reportDir: ${reportDir}`);

  if (!existsSync(recsFile)) {
    throw new Error(`recommendations.json not found — run tv-rec-merge first (${recsFile}).`);
  }

  const file = JSON.parse(readFileSync(recsFile, 'utf8')) as RecommendationsFile;
  const allRecs = file.recommendations ?? [];
  ctx.log(`Loaded ${allRecs.length} recommendation(s) from merge stage.`);

  // Drop owner-ignored recs.
  const ignoredKeys = ignoredItemKeys(RECS_JOB);
  const activeRecs = allRecs.filter((r) => !ignoredKeys.has(recKey(r.tmdbId)));
  const ignoredCount = allRecs.length - activeRecs.length;
  ctx.log(`Owner-ignored: ${ignoredCount} → ${activeRecs.length} active.`);
  if (ignoredCount > 0) {
    const excluded = allRecs.filter((r) => ignoredKeys.has(recKey(r.tmdbId)));
    for (const r of excluded) ctx.log(`  ✕ ignored: "${r.title}"${r.year ? ` (${r.year})` : ''} tmdb=${r.tmdbId}`);
  }

  // Already-notified (in the ledger as success/ignored).
  const newRecs = activeRecs.filter((r) => !isWorkItemDone(RECS_JOB, recKey(r.tmdbId), 1));
  const alreadyNotifiedCount = activeRecs.length - newRecs.length;
  ctx.log(`Already notified: ${alreadyNotifiedCount} → ${newRecs.length} new this run.`);
  for (const r of activeRecs.filter((r) => isWorkItemDone(RECS_JOB, recKey(r.tmdbId), 1))) {
    ctx.log(`  ↩ already notified: "${r.title}"${r.year ? ` (${r.year})` : ''}`);
  }
  for (const r of newRecs) {
    ctx.log(`  🆕 new rec: "${r.title}"${r.year ? ` (${r.year})` : ''} [${r.lens}]`);
  }

  // Always write the full active-backlog markdown report.
  const reportPath = writeReport(activeRecs, newRecs, now, reportDir);
  ctx.log(`Wrote report → ${reportPath}`);

  if (newRecs.length === 0) {
    ctx.progress(100, 'nothing new to notify');
    ctx.log('Nothing new — no digest sent. ✓');
    return;
  }

  // Send ONE digest of the new picks.
  const digest = buildDigest(newRecs);
  ctx.log(`Digest: ${digest.title} — ${digest.body}`);
  const res = await pushFn(digest.title, digest.body, { job: 'tv-recs', tags: 'television', priority: 'default' });
  ctx.log(res.ok ? `digest push sent — ${digest.title}` : `digest push FAILED (${res.error})`, res.ok ? 'info' : 'error');
  if (!res.ok) throw new Error(`Digest push failed — ${res.error}`);

  // Mark each notified rec in the ledger so it's never re-notified.
  for (const r of newRecs) {
    markWorkItem(RECS_JOB, recKey(r.tmdbId), 'success', {
      detail: {
        name: `${r.title}${r.year ? ` (${r.year})` : ''}`,
        markdown: reportPath,
        title: r.title,
        year: r.year,
        lens: r.lens,
        genre: r.genre,
        reason: r.reason,
        tmdbRating: r.tmdbRating,
        tmdbUrl: tmdbLink(r.tmdbId),
      },
    });
  }

  // Append to history so future branches can avoid re-suggesting.
  appendHistory(historyFile, newRecs, now);

  ctx.progress(100, `${newRecs.length} TV show(s) notified`);
  ctx.log(`Marked ${newRecs.length} recommendation(s) notified. ✓`);
}

function tmdbLink(tmdbId: number): string {
  return `https://www.themoviedb.org/tv/${tmdbId}`;
}

/** Write the monthly markdown report listing the current active recommendations. */
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
    '# TV show recommendations',
    '',
    '## Recommendations',
    '',
  ];

  if (recs.length === 0) {
    lines.push('_No active recommendations._', '');
  } else {
    const sorted = [...recs].sort((a, b) => a.genre.localeCompare(b.genre) || a.title.localeCompare(b.title));
    for (const r of sorted) {
      const isNew = newRecKeys.has(recKey(r.tmdbId));
      const rating = r.tmdbRating != null ? ` — TMDB ${r.tmdbRating.toFixed(1)}` : '';
      lines.push(`- [${r.title}](${tmdbLink(r.tmdbId)})${r.year ? ` (${r.year})` : ''} _(${r.lens})_${rating}${isNew ? ' 🆕' : ''}  \n  ${r.reason}`);
    }
    lines.push('');
  }

  const reportPath = join(reportDir, 'tv-recommendations.md');
  writeFileSync(reportPath, lines.join('\n'));
  return reportPath;
}

/** Append newly-notified shows to the recs-history file (fed back into branch prompts). */
function appendHistory(historyFile: string, newRecs: Recommendation[], now: Date): void {
  let hist: RecsHistoryFile = { recommended: [] };
  if (existsSync(historyFile)) {
    try {
      const parsed = JSON.parse(readFileSync(historyFile, 'utf8')) as RecsHistoryFile;
      if (Array.isArray(parsed.recommended)) hist = parsed;
    } catch { /* corrupt history → start fresh */ }
  }
  for (const r of newRecs) {
    hist.recommended.push({ title: r.title, year: r.year });
  }
  writeFileSync(historyFile, JSON.stringify(hist, null, 2));
}
