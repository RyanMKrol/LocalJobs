import type { JobContext } from '../../../core/types.js';
import { dayKey } from '../../../core/dates.js';
import { isWorkItemDone, markWorkItem } from '../../../db/store.js';
import { fetchSectionMetadata } from '../../../core/plex-client.js';
import { push } from '../../../core/notifier.js';
import { plexLibraryGuardConfig } from '../config.js';
import {
  buildAlertPush,
  buildReport,
  buildSnapshot,
  diffSnapshots,
  ensureDirs,
  formatBytes,
  isSuspectRead,
  readSnapshot,
  SUSPECT_MISSING_RATIO,
  writeJsonFile,
} from '../lib.js';
import type { GuardEpisodeMeta, GuardMovieMeta } from '../types.js';

export const JOB_NAME = 'plex-library-guard-scan';

/** The work_items key-space for the "already-alerted" ledger (keyed by the previous snapshot's generatedAt). */
export const ALERT_JOB = 'plex-library-guard-alert';

/** A push function shaped like core/notifier `push` (injectable for tests). */
export type PushFn = typeof push;

export interface ScanOpts {
  /** Override "now" (tests). Defaults to a fresh Date. */
  now?: Date;
  /** Override the guard alert push (tests). Defaults to the real `push`. */
  push?: PushFn;
  /**
   * Injectable low-level Plex GET (tests), standing in for the real `plexGet`,
   * still routed through `callService('plex', ...)`. Defaults to the real `plexGet`.
   */
  plexFetch?: <T>(path: string) => Promise<T>;
}

/**
 * Single-stage safeguard workflow: scan the Plex movie + TV library sections
 * LIVE (cacheKey: null, never the 3-hour response cache: a guard must not diff
 * a stale cached listing), build a full per-file inventory (one entry per
 * media Part), diff it against the previous run's persisted snapshot, and send
 * ONE urgent push if the total library size dropped beyond PLEX_GUARD_DROP_GB
 * (default 0, any decrease) or if any previously-seen file is missing (named
 * in the push, up to 20; all of them in guard-report.json).
 *
 * The core invariant is the write ORDERING: the baseline snapshot is only
 * overwritten AFTER the alert path settles. A failed push throws before the
 * snapshot write, so the run fails with the old baseline intact and the retry
 * re-diffs and re-attempts. The already-alerted ledger (job
 * `plex-library-guard-alert`, keyed by the previous snapshot's generatedAt)
 * only exists for that retry path: it stops a crash between push and snapshot
 * write from re-pushing the same alert.
 *
 * Two bad-read guards: (1) a 0-movie or 0-episode listing throws before any
 * write (a populated library never legitimately reads empty; missing-tv-seasons
 * precedent); (2) a suspected partial read (more than half the previous
 * inventory missing at once) still alerts loudly but preserves the baseline
 * and throws, so a Plex misread self-heals next run while a real mass deletion
 * keeps failing loudly until the owner intervenes.
 */
export async function runScan(ctx: JobContext, opts: ScanOpts = {}): Promise<void> {
  ensureDirs();
  const now = opts.now ?? new Date();
  const pushFn = opts.push ?? push;
  const { movieSection, tvSection, snapshotOut, reportOut, dropThresholdGb } = plexLibraryGuardConfig;

  ctx.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ctx.log(`plex-library-guard-scan starting — movie section ${movieSection}, TV section ${tvSection}, drop threshold ${dropThresholdGb} GB`);
  ctx.log('Reads are LIVE (cache opt-out): the guard never diffs a cached listing.');

  ctx.progress(10, 'fetching movies');
  const movies = await fetchSectionMetadata<GuardMovieMeta>(movieSection, { cacheKey: null, fetch: opts.plexFetch });
  ctx.log(`Fetched ${movies.length} movie(s) from section ${movieSection}.`);

  ctx.progress(30, 'fetching episodes');
  const episodes = await fetchSectionMetadata<GuardEpisodeMeta>(tvSection, { query: '?type=4', cacheKey: null, fetch: opts.plexFetch });
  ctx.log(`Fetched ${episodes.length} episode(s) from section ${tvSection} (flat read, type=4).`);

  // Empty-read guard: throw BEFORE any write, preserving the last-good snapshot.
  if (movies.length === 0 || episodes.length === 0) {
    throw new Error(
      `Empty Plex read (${movies.length} movies, ${episodes.length} episodes) — a populated library never ` +
        'legitimately reads empty, so this is treated as a transient Plex anomaly. Nothing written; the ' +
        'last-good snapshot is preserved.',
    );
  }

  ctx.progress(50, 'building snapshot');
  const current = buildSnapshot(movies, episodes, movieSection, tvSection, now);
  ctx.log(`Current inventory: ${current.fileCount} file(s), ${current.totalHuman} total.`);
  const noFileCount = current.files.filter((f) => f.file === null).length;
  if (noFileCount > 0) {
    ctx.log(`${noFileCount} part(s) carry no 'file' path in the section listing — keyed by part id instead.`, 'warn');
  }

  const prev = readSnapshot(snapshotOut);
  if (!prev) {
    ctx.log('No previous snapshot found — seeding the baseline, no checks this run.');
    writeJsonFile(reportOut, buildReport(current, null, null, dropThresholdGb, false, false));
    writeJsonFile(snapshotOut, current);
    ctx.log(`Wrote ${reportOut}`);
    ctx.log(`Seeded baseline ${snapshotOut} (${current.fileCount} files, ${current.totalHuman}).`);
    recordLedger(now, current.fileCount, current.totalHuman, null);
    recordSnapshotLedger(current.fileCount, current.totalHuman);
    ctx.progress(100, `baseline seeded: ${current.fileCount} file(s), ${current.totalHuman}`);
    return;
  }

  ctx.progress(65, 'diffing against previous snapshot');
  const diff = diffSnapshots(prev, current, dropThresholdGb);
  const suspect = isSuspectRead(prev.fileCount, diff.missing.length);
  const alert = buildAlertPush(diff, prev, current);
  const alreadyAlerted = alert !== null && isWorkItemDone(ALERT_JOB, prev.generatedAt, 1);

  ctx.log(
    `Diff vs ${prev.generatedAt}: total ${formatBytes(prev.totalBytes)} → ${current.totalHuman} ` +
      `(drop ${formatBytes(Math.max(diff.dropBytes, 0))}), missing ${diff.missing.length}, added ${diff.addedCount}.`,
  );
  for (const f of diff.missing) {
    ctx.log(`  MISSING: ${f.title}${f.file ? ` (${f.file})` : ''} — ${formatBytes(f.bytes)}`, 'error');
  }

  // The report is written BEFORE the alert push, so even a failed-push run
  // leaves a full record of what was found.
  const report = buildReport(current, prev, diff, dropThresholdGb, suspect, alert !== null && !alreadyAlerted);
  writeJsonFile(reportOut, report);
  ctx.log(`Wrote ${reportOut}`);

  if (alert === null) {
    ctx.log('Library is stable or growing, nothing missing — no alert. ✓');
  } else if (alreadyAlerted) {
    ctx.log(`Alert warranted, but this baseline (${prev.generatedAt}) was already alerted — skipping re-send.`);
  } else {
    ctx.log(`Sending guard alert: ${alert.title}`);
    const res = await pushFn(alert.title, alert.body, { priority: 'urgent', tags: 'rotating_light,warning', job: JOB_NAME });
    if (!res.ok) {
      ctx.log(`Alert push FAILED (${res.error ?? 'unknown error'}) — failing the run WITHOUT overwriting the baseline, so the retry re-diffs and re-alerts.`, 'error');
      throw new Error(`Guard alert push failed — ${res.error ?? 'unknown error'}`);
    }
    ctx.log('Alert push sent.');
    markWorkItem(ALERT_JOB, prev.generatedAt, 'success', {
      detail: {
        name: `Guard alert — baseline ${prev.generatedAt}`,
        missingCount: diff.missing.length,
        dropBytes: diff.dropBytes,
        prevBytes: prev.totalBytes,
        currentBytes: current.totalBytes,
      },
    });
  }

  // Suspected partial read: alert already went out above (loud is correct
  // either way), but the baseline must survive so a misread self-heals.
  if (suspect) {
    ctx.log(
      `SUSPECTED PARTIAL READ: ${diff.missing.length}/${prev.fileCount} file(s) missing at once (> ${SUSPECT_MISSING_RATIO * 100}%). ` +
        'Baseline NOT overwritten. If this was a transient Plex misread the next run diffs clean; if the ' +
        'deletion is real, runs keep failing loudly until you intervene.',
      'error',
    );
    throw new Error(
      `Suspected partial Plex read: ${diff.missing.length} of ${prev.fileCount} previously-seen file(s) missing at once. Baseline preserved.`,
    );
  }

  writeJsonFile(snapshotOut, current);
  ctx.log(`Baseline updated: ${snapshotOut} (${current.fileCount} files, ${current.totalHuman}).`);

  recordLedger(now, current.fileCount, current.totalHuman, report.alerted ? diff : null);
  recordSnapshotLedger(current.fileCount, current.totalHuman);
  ctx.progress(100, `${current.fileCount} file(s), ${current.totalHuman}${alert ? ' — ALERTED' : ''}`);
}

/** One ledger row per calendar day (a same-day re-run updates it in place). */
function recordLedger(now: Date, fileCount: number, totalHuman: string, alertedDiff: { missing: unknown[]; dropBytes: number } | null): void {
  const day = dayKey(now);
  const summary = alertedDiff
    ? `ALERT: ${alertedDiff.missing.length} missing, -${formatBytes(Math.max(alertedDiff.dropBytes, 0))}`
    : `OK (${fileCount} files, ${totalHuman})`;
  // detail.markdown is set to the same path as detail.path purely so the
  // generic Output section's list query (which only flags hasMarkdown truthy)
  // still surfaces a "View" button; the fetch endpoint reads
  // detail.format/detail.path, so the button opens the JSON report.
  markWorkItem(JOB_NAME, day, 'success', {
    detail: {
      name: `Library guard — ${day} — ${summary}`,
      format: 'json',
      path: plexLibraryGuardConfig.reportOut,
      markdown: plexLibraryGuardConfig.reportOut,
    },
  });
}

/**
 * One STABLE ledger row (key 'snapshot', updated in place each run) exposing
 * the full per-file baseline inventory on the dashboard's Output section, via
 * the dedicated 'library-snapshot' renderer (a searchable file list; see
 * dashboard/app/components/OutputRenderer.tsx). Recorded only right after a
 * successful baseline write, so what the dashboard shows is always exactly the
 * inventory the next run will diff against.
 */
function recordSnapshotLedger(fileCount: number, totalHuman: string): void {
  markWorkItem(JOB_NAME, 'snapshot', 'success', {
    detail: {
      name: `Full library snapshot — ${fileCount} files, ${totalHuman}`,
      format: 'library-snapshot',
      path: plexLibraryGuardConfig.snapshotOut,
      markdown: plexLibraryGuardConfig.snapshotOut,
    },
  });
}
