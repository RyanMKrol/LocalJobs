import type { JobContext } from '../../../core/types.js';
import { weekKey } from '../../../core/dates.js';
import { markWorkItem } from '../../../db/store.js';
import { fetchSectionMetadata } from '../../../core/plex-client.js';
import { plexSpaceSaverConfig } from '../config.js';
import { buildBreakdown, buildMovieRows, buildShowRows, ensureDirs, writeJsonFile } from '../lib.js';
import type { PlexEpisodeMeta, PlexMovieMeta, PlexShowMeta } from '../types.js';

export const JOB_NAME = 'plex-space-saver-scan';

export { weekKey };

export interface ScanOpts {
  /** Override "now" (tests). Defaults to a fresh Date. */
  now?: Date;
  /**
   * Injectable low-level Plex GET (tests) — swaps in for the real `plexGet`,
   * still routed through `callService('plex', ...)` so the 3-hour response-cache
   * dedup (T477) can be exercised without a live Plex call. Defaults to the real
   * `plexGet`.
   */
  plexFetch?: <T>(path: string) => Promise<T>;
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
 * — this NEVER flags or suggests deletions, purely a size breakdown. (The old
 * T519 shrink guard was removed when the plex-library-guard workflow took over
 * the library-shrank signal with a daily, per-file, zero-threshold check.)
 */
export async function runScan(ctx: JobContext, opts: ScanOpts = {}): Promise<void> {
  ensureDirs();
  const now = opts.now ?? new Date();
  const { movieSection, tvSection } = plexSpaceSaverConfig;

  ctx.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ctx.log(`plex-space-saver-scan starting — movie section ${movieSection}, TV section ${tvSection}`);

  ctx.progress(10, 'fetching movies');
  const movies = await fetchSectionMetadata<PlexMovieMeta>(movieSection, { fetch: opts.plexFetch });
  ctx.log(`Fetched ${movies.length} movie(s) from section ${movieSection}.`);

  ctx.progress(35, 'fetching shows');
  const shows = await fetchSectionMetadata<PlexShowMeta>(tvSection, { fetch: opts.plexFetch });
  ctx.log(`Fetched ${shows.length} show(s) from section ${tvSection}.`);

  ctx.progress(55, 'fetching episodes');
  const episodes = await fetchSectionMetadata<PlexEpisodeMeta>(tvSection, { query: '?type=4', fetch: opts.plexFetch });
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
