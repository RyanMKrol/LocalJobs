import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { push } from '../../../core/notifier.js';
import { ignoredItemKeys, isWorkItemDone, markWorkItem } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';
import { moviesConfig } from '../config.js';
import { ensureDirs } from '../lib.js';
import { RECS_JOB, recKey } from '../recs.js';
import type {
  FranchiseGap,
  FranchiseGapsFile,
  Recommendation,
  RecommendationsFile,
  RecsHistoryFile,
} from '../types.js';

/** The work_items key-space for the franchise-gap "already-notified / ignored" ledger. */
export const NOTIFY_JOB = 'movie-gaps-notify';

/** Ledger key for one franchise gap: the missing film's tmdb id, as a string. */
export function gapKey(tmdbId: number): string {
  return String(tmdbId);
}

/**
 * Build the single combined digest push. The franchise-gaps and recommendations
 * are SEPARATE concerns but share ONE monthly digest. When there are no new recs
 * the title is unchanged from the gaps-only digest (back-compatible).
 */
export function buildDigest(
  newGaps: FranchiseGap[],
  newRecs: Recommendation[] = [],
): { count: number; title: string; body: string } {
  const g = newGaps.length;
  const r = newRecs.length;
  const gapNames = newGaps.map((x) => x.title).slice(0, 10);
  const recNames = newRecs.map((x) => x.title).slice(0, 8);
  const gapBody = gapNames.join(', ') + (newGaps.length > gapNames.length ? `, +${newGaps.length - gapNames.length} more` : '');
  const recBody = recNames.join(', ') + (newRecs.length > recNames.length ? `, +${newRecs.length - recNames.length} more` : '');

  let title: string;
  if (r === 0) title = `🎬 ${g} franchise gap${g === 1 ? '' : 's'} detected`;
  else if (g === 0) title = `🍿 ${r} film recommendation${r === 1 ? '' : 's'}`;
  else title = `🎬 ${g} franchise gap${g === 1 ? '' : 's'} · 🍿 ${r} recommendation${r === 1 ? '' : 's'}`;

  const parts: string[] = [];
  if (g > 0) parts.push(`Gaps: ${gapBody}`);
  if (r > 0) parts.push(`Recommendations: ${recBody}`);
  return { count: g + r, title, body: parts.join(' · ') };
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
  /** Override the recommendations file path (tests). */
  recsFile?: string;
  /** Override the recommended-history file path (tests). */
  historyFile?: string;
  /** Override the report output dir (tests). */
  reportDir?: string;
}

/**
 * Stage 3 — the combined monthly digest. Reads the fresh franchise gaps AND the
 * TMDB-verified recommendations, drops anything the owner has manually IGNORED,
 * finds the ones NOT already in their respective "notified" ledgers, sends ONE
 * digest covering both, then marks each notified item done so it never repeats.
 * Also (re)writes a monthly markdown report with TWO separate sections —
 * franchise gaps grouped by collection, and recommendations with lens + reason +
 * TMDB link. Newly-notified recommendations are appended to the history file,
 * which is fed back into next month's branch prompts so picks vary.
 *
 * Both ledgers are "notified" logs, NOT work-done logs. The gaps ledger is keyed
 * by the missing film's tmdb id (`movie-gaps-notify`); the recs ledger by the
 * recommended film's tmdb id (`movie-recs`) — so a film is recommended at most
 * once ever and an `ignored` rec/gap leaves BOTH the report AND notifications.
 */
export async function runNotify(ctx: JobContext, opts: NotifyOpts = {}): Promise<void> {
  ensureDirs();
  const pushFn = opts.push ?? push;
  const now = opts.now ?? new Date();
  const gapsFile = opts.gapsFile ?? moviesConfig.gapsOut;
  const recsFile = opts.recsFile ?? moviesConfig.recsOut;
  const historyFile = opts.historyFile ?? moviesConfig.recsHistoryOut;
  const reportDir = opts.reportDir ?? moviesConfig.reportDir;

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

  // ── Recommendations (optional — the merge stage may have produced none) ──
  const allRecs: Recommendation[] = existsSync(recsFile)
    ? ((JSON.parse(readFileSync(recsFile, 'utf8')) as RecommendationsFile).recommendations ?? [])
    : [];
  const ignoredRecs = ignoredItemKeys(RECS_JOB);
  const recs = allRecs.filter((r) => !ignoredRecs.has(recKey(r.tmdbId)));
  const ignoredRecCount = allRecs.length - recs.length;
  ctx.log(`Loaded ${allRecs.length} recommendation(s); ${ignoredRecCount} owner-ignored excluded → ${recs.length} active.`);
  if (ignoredRecCount > 0) {
    const excludedRecs = allRecs.filter((r) => ignoredRecs.has(recKey(r.tmdbId)));
    for (const r of excludedRecs) ctx.log(`  ✕ ignored rec: "${r.title}"${r.year ? ` (${r.year})` : ''} tmdb=${r.tmdbId}`);
  }

  // Newly-detected (not yet in the respective ledger).
  const newGaps = gaps.filter((g) => !isWorkItemDone(NOTIFY_JOB, gapKey(g.tmdbId), 1));
  const newRecs = recs.filter((r) => !isWorkItemDone(RECS_JOB, recKey(r.tmdbId), 1));
  ctx.log(`Newly-detected: ${newGaps.length} gap(s) (already notified: ${gaps.length - newGaps.length}), ${newRecs.length} recommendation(s) (already notified: ${recs.length - newRecs.length}).`);
  const alreadyNotifiedGaps = gaps.filter((g) => isWorkItemDone(NOTIFY_JOB, gapKey(g.tmdbId), 1));
  for (const g of alreadyNotifiedGaps) ctx.log(`  ↩ already notified gap: "${g.collectionName}: ${g.title}"${g.year ? ` (${g.year})` : ''}`);
  const alreadyNotifiedRecs = recs.filter((r) => isWorkItemDone(RECS_JOB, recKey(r.tmdbId), 1));
  for (const r of alreadyNotifiedRecs) ctx.log(`  ↩ already notified rec: "${r.title}"${r.year ? ` (${r.year})` : ''}`);

  // Always (re)write the combined markdown report of the current active backlog.
  const collectionExamples = file.collectionExamples ?? {};
  const reportPath = writeReport(gaps, newGaps, recs, newRecs, now, reportDir, collectionExamples);
  ctx.log(`Wrote report ${reportPath}`);

  if (newGaps.length === 0 && newRecs.length === 0) {
    ctx.progress(100, 'nothing new to notify');
    ctx.log('Nothing new — no digest sent. ✓');
    return;
  }

  // Send ONE combined digest, then record each notified item so it never repeats.
  const digest = buildDigest(newGaps, newRecs);
  ctx.log(`Digest: ${digest.title} — ${digest.body}`);
  const res = await pushFn(digest.title, digest.body, { job: 'movies', tags: 'movie_camera', priority: 'default' });
  ctx.log(res.ok ? `digest push sent — ${digest.title}` : `digest push FAILED (${res.error})`, res.ok ? 'info' : 'error');

  for (const g of newGaps) {
    markWorkItem(NOTIFY_JOB, gapKey(g.tmdbId), 'success', {
      detail: { name: `${g.collectionName}: ${g.title}`, markdown: reportPath },
    });
  }
  for (const r of newRecs) {
    markWorkItem(RECS_JOB, recKey(r.tmdbId), 'success', {
      detail: { name: `${r.title} (${r.lens})`, markdown: reportPath, title: r.title, year: r.year },
    });
  }
  if (newRecs.length) appendHistory(historyFile, newRecs, now);

  ctx.progress(100, `${newGaps.length} gap(s) + ${newRecs.length} rec(s) notified`);
  ctx.log(`Marked ${newGaps.length} gap(s) + ${newRecs.length} recommendation(s) notified.`);
}

/** A TMDB movie link for the report. */
function tmdbLink(tmdbId: number): string {
  return `https://www.themoviedb.org/movie/${tmdbId}`;
}

/**
 * Write the combined monthly markdown report: a franchise-gaps section grouped by
 * collection, then a SEPARATE recommendations section (each rec with its lens,
 * reason, and TMDB link). Returns its absolute path. Newly-detected items are
 * flagged 🆕.
 */
function writeReport(
  gaps: FranchiseGap[],
  newGaps: FranchiseGap[],
  recs: Recommendation[],
  newRecs: Recommendation[],
  now: Date,
  reportDir: string,
  collectionExamples: Record<string, { title: string; year: number | null }> = {},
): string {
  const newGapKeys = new Set(newGaps.map((g) => gapKey(g.tmdbId)));
  const newRecKeys = new Set(newRecs.map((r) => recKey(r.tmdbId)));

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
    `recommendations: ${recs.length}`,
    `newlyDetectedGaps: ${newGaps.length}`,
    `newRecommendations: ${newRecs.length}`,
    '---',
    '',
    '# Plex movie audit',
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

  // ── Recommendations section (separate from the franchise gaps) ──
  lines.push('## Recommendations', '');
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

  const path = join(reportDir, 'franchise-gaps.md');
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
