import type { JobContext } from '../../../core/types.js';
import { weekKey } from '../../../core/dates.js';
import { isWorkItemDone, markWorkItem } from '../../../db/store.js';
import { callService } from '../../../core/services.js';
import { plexGet } from '../../../core/plex-client.js';
import { push } from '../../../core/notifier.js';
import { plexSpaceSaverConfig } from '../config.js';
import {
  buildBreakdown,
  buildMovieRows,
  buildShowRows,
  checkDrop,
  ensureDirs,
  formatBytes,
  readBaseline,
  writeBaseline,
  writeJsonFile,
} from '../lib.js';
import type { PlexEpisodeMeta, PlexMovieMeta, PlexShowMeta } from '../types.js';

export const JOB_NAME = 'plex-space-saver-scan';

/** The work_items key-space for the "already-alerted" shrink-guard ledger. */
export const SHRINK_ALERT_JOB = 'plex-space-saver-shrink-alert';

/** A push function shaped like core/notifier `push` (injectable for tests). */
export type PushFn = typeof push;

interface PlexAllResponse<T> {
  MediaContainer?: { Metadata?: T[] };
}

export { weekKey };

export interface ScanOpts {
  /** Override "now" (tests). Defaults to a fresh Date. */
  now?: Date;
  /** Override the shrink-guard alert push (tests). Defaults to the real `push`. */
  push?: PushFn;
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
 *
 * Shrink guard (T519): after computing this run's total, diffs it against the
 * PRIOR run's persisted baseline (`size-baseline.json`) and fires exactly ONE
 * critical push if the library shrank by more than `PLEX_SIZE_DROP_GB` (default
 * 1 GB — an absolute threshold, not a percentage, since the library should
 * essentially never shrink). No prior baseline (first run) or a stable/growing
 * library sends nothing. Re-alerting for the SAME already-alerted baseline is
 * suppressed via the notify-once `work_items` ledger, keyed by the baseline's
 * `at` timestamp (mirrors missing-tv-seasons/stages/notify.ts). The baseline is
 * written at the end of every successful scan, alert or not.
 */
export async function runScan(ctx: JobContext, opts: ScanOpts = {}): Promise<void> {
  ensureDirs();
  const now = opts.now ?? new Date();
  const pushFn = opts.push ?? push;
  const { movieSection, tvSection } = plexSpaceSaverConfig;

  ctx.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ctx.log(`plex-space-saver-scan starting — movie section ${movieSection}, TV section ${tvSection}`);

  ctx.progress(10, 'fetching movies');
  const moviesResp = await callService('plex', () =>
    plexGet<PlexAllResponse<PlexMovieMeta>>(`/library/sections/${movieSection}/all`),
  );
  const movies = moviesResp?.MediaContainer?.Metadata ?? [];
  ctx.log(`Fetched ${movies.length} movie(s) from section ${movieSection}.`);

  ctx.progress(35, 'fetching shows');
  const showsResp = await callService('plex', () =>
    plexGet<PlexAllResponse<PlexShowMeta>>(`/library/sections/${tvSection}/all`),
  );
  const shows = showsResp?.MediaContainer?.Metadata ?? [];
  ctx.log(`Fetched ${shows.length} show(s) from section ${tvSection}.`);

  ctx.progress(55, 'fetching episodes');
  const epsResp = await callService('plex', () =>
    plexGet<PlexAllResponse<PlexEpisodeMeta>>(`/library/sections/${tvSection}/all?type=4`),
  );
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

  // Shrink guard (T519): diff this run's total against the PRIOR baseline before
  // overwriting it with this run's own total.
  const { baselineOut, dropThresholdGb } = plexSpaceSaverConfig;
  const prior = readBaseline(baselineOut);
  if (!prior) {
    ctx.log(`No prior size baseline found — seeding baseline at ${breakdown.totalHuman}, no shrink check this run.`);
  } else {
    const drop = checkDrop(prior, breakdown.totalBytes, dropThresholdGb);
    const dropHuman = formatBytes(Math.max(drop.dropBytes, 0));
    const pct = prior.totalBytes > 0 ? ((drop.dropBytes / prior.totalBytes) * 100).toFixed(1) : '0.0';
    ctx.log(
      `Shrink check: prior=${formatBytes(prior.totalBytes)} (as of ${prior.at}), current=${breakdown.totalHuman}, ` +
        `drop=${dropHuman} (${pct}%), threshold=${dropThresholdGb} GB.`,
    );
    if (!drop.exceeds) {
      ctx.log(
        drop.dropBytes <= 0
          ? 'Library is stable or growing — no alert.'
          : 'Drop is under the threshold — no alert.',
      );
    } else {
      const alertKey = prior.at;
      if (isWorkItemDone(SHRINK_ALERT_JOB, alertKey, 1)) {
        ctx.log(`Drop exceeds threshold, but this baseline (${alertKey}) was already alerted — skipping re-send.`);
      } else {
        ctx.log(`Drop EXCEEDS threshold — sending critical shrink-guard alert.`);
        const title = '🚨 Plex library shrank';
        const body =
          `${formatBytes(prior.totalBytes)} → ${breakdown.totalHuman} ` +
          `(-${dropHuman}, -${pct}%) since ${prior.at}. Threshold: ${dropThresholdGb} GB.`;
        const res = await pushFn(title, body, { priority: 'urgent', tags: 'rotating_light,warning', job: JOB_NAME });
        ctx.log(`Shrink alert push: ${res.ok ? 'sent' : `failed (${res.error ?? 'unknown error'})`}`);
        markWorkItem(SHRINK_ALERT_JOB, alertKey, 'success', {
          detail: { name: `Shrink alert — ${alertKey}`, priorBytes: prior.totalBytes, currentBytes: breakdown.totalBytes, dropBytes: drop.dropBytes },
        });
      }
    }
  }
  writeBaseline(baselineOut, breakdown.totalBytes, now.toISOString());
  ctx.log(`Wrote baseline ${baselineOut} (${breakdown.totalHuman}).`);

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
