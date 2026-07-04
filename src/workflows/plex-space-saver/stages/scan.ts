import type { JobContext } from '../../../core/types.js';
import { markWorkItem } from '../../../db/store.js';
import { plexGet } from '../../../core/plex-client.js';
import { plexSpaceSaverConfig } from '../config.js';
import { buildBreakdown, buildMovieRows, buildShowRows, ensureDirs, writeJsonFile } from '../lib.js';
import type { PlexEpisodeMeta, PlexMovieMeta, PlexShowMeta } from '../types.js';

export const JOB_NAME = 'plex-space-saver-scan';

interface PlexAllResponse<T> {
  MediaContainer?: { Metadata?: T[] };
}

/** "2026-W27" — the ISO-8601 week key, used as the ledger key. Mirrors stock-digest's weekKey. */
export function weekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7; // Mon=1..Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

export interface ScanOpts {
  /** Override "now" (tests). Defaults to a fresh Date. */
  now?: Date;
}

/**
 * Single-stage workflow: scan the Plex movie + TV library sections via the API
 * (no filesystem walk — Plex reports each media Part's `size` in bytes), compute
 * a biggest-first size breakdown — ONE row per movie, ONE row per TV show
 * (summing every episode across every season) — and write it as a structured
 * JSON artifact. RE-SCANS FRESH every run (report-only audit, like
 * missing-tv-seasons) — no per-item skip-if-done.
 *
 * Idempotent per ISO calendar week via the work_items ledger: a manual re-run
 * the same week regenerates that week's breakdown rather than duplicating it
 * (mirrors stock-digest/listening-digest's weekly/monthly cadence). Report only
 * — this NEVER flags or suggests deletions, purely a size breakdown.
 */
export async function runScan(ctx: JobContext, opts: ScanOpts = {}): Promise<void> {
  ensureDirs();
  const now = opts.now ?? new Date();
  const { movieSection, tvSection } = plexSpaceSaverConfig;

  ctx.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ctx.log(`plex-space-saver-scan starting — movie section ${movieSection}, TV section ${tvSection}`);

  ctx.progress(10, 'fetching movies');
  const moviesResp = await plexGet<PlexAllResponse<PlexMovieMeta>>(`/library/sections/${movieSection}/all`);
  const movies = moviesResp?.MediaContainer?.Metadata ?? [];
  ctx.log(`Fetched ${movies.length} movie(s) from section ${movieSection}.`);

  ctx.progress(35, 'fetching shows');
  const showsResp = await plexGet<PlexAllResponse<PlexShowMeta>>(`/library/sections/${tvSection}/all`);
  const shows = showsResp?.MediaContainer?.Metadata ?? [];
  ctx.log(`Fetched ${shows.length} show(s) from section ${tvSection}.`);

  ctx.progress(55, 'fetching episodes');
  const epsResp = await plexGet<PlexAllResponse<PlexEpisodeMeta>>(`/library/sections/${tvSection}/all?type=4`);
  const episodes = epsResp?.MediaContainer?.Metadata ?? [];
  ctx.log(`Fetched ${episodes.length} episode(s) (flat read, type=4).`);

  ctx.progress(80, 'computing size breakdown');
  const movieRows = buildMovieRows(movies);
  const showRows = buildShowRows(shows, episodes);
  const breakdown = buildBreakdown(movieRows, showRows, movieSection, tvSection, now);

  ctx.log(`Computed breakdown: ${breakdown.movieCount} movie(s) + ${breakdown.showCount} show(s), total ${breakdown.totalHuman}.`);
  for (const item of breakdown.items.slice(0, 10)) {
    ctx.log(`  ${item.human.padStart(9)}  ${item.type === 'movie' ? '🎬' : '📺'} ${item.title}${item.year ? ` (${item.year})` : ''}`);
  }

  writeJsonFile(plexSpaceSaverConfig.breakdownOut, breakdown);
  ctx.log(`Wrote ${plexSpaceSaverConfig.breakdownOut}`);

  // Idempotent per ISO week (report-only; a re-run the same week regenerates it).
  // Declared output form (T262/T282): 'size-table', served from detail.path via
  // safeOutputFile — a structured breakdown, not markdown prose. `detail.markdown`
  // is ALSO set (to the same path) so the generic Output section's list query
  // (`workflowTerminalItems`, which only flags `hasMarkdown` truthy — out of this
  // task's scope to change) still surfaces a "View" button; the fetch endpoint
  // reads `detail.format`/`detail.path`, so the button opens the real size table.
  const key = weekKey(now);
  markWorkItem(JOB_NAME, key, 'success', {
    detail: {
      name: `Size breakdown — ${key}`,
      format: 'size-table',
      path: plexSpaceSaverConfig.breakdownOut,
      markdown: plexSpaceSaverConfig.breakdownOut,
    },
  });

  ctx.progress(100, `${breakdown.items.length} item(s), ${breakdown.totalHuman} total`);
}
