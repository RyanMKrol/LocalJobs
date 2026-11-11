import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTestEnv, resolveWorkflowDataDir } from '../../config.js';

// The data folder goes through resolveWorkflowDataDir: the real `data/` in production,
// a scratch folder under test, so a test can never write into real output.
const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolveWorkflowDataDir(resolve(here, 'data'));
const outDir = resolve(dataDir, 'out');

const positive = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * Paths and settings for the weekly Plex poster backup.
 *
 * Only small working files live in this workflow's own `data/out`: the list of
 * items, the fetch result, an index of what has been downloaded, and the report.
 * The ARCHIVE (the images and the dated snapshots, several gigabytes) lives
 * wherever `PLEX_POSTER_ARCHIVE_DIR` points, which on the owner's machine is a
 * folder on a NAS share. It is deliberately not under `data/out`: the dashboard's
 * "Clear output data" button empties that folder, and an archive must not be one
 * click from gone. The share's name is kept out of this public repo, hence the
 * env var with no default.
 */
export const plexPostersConfig = {
  dataDir,
  outDir,
  listOut: resolve(outDir, 'poster-list.json'),
  setOut: resolve(outDir, 'poster-set.json'),
  indexFile: resolve(outDir, 'poster-index.json'),
  reportOut: resolve(outDir, 'backup-report.json'),

  /**
   * Where the archive is. Read at call time. Empty under test, whatever the
   * environment says, so a test that forgets to pass its own folder fails with
   * "not set" instead of writing to the real archive.
   */
  archiveDir: (): string => (isTestEnv() ? '' : (process.env.PLEX_POSTER_ARCHIVE_DIR ?? '').trim()),

  /** How many posters to download at once. Default 4. */
  fetchConcurrency: (): number => Math.floor(positive(process.env.PLEX_POSTER_FETCH_CONCURRENCY, 4)),
  /** Alert when at least this share of posters changed since the last snapshot. Default 20 (%). */
  alertPct: (): number => positive(process.env.PLEX_POSTER_ALERT_PCT, 20),
  /** ...and at least this many did, so a tiny library cannot trip it. Default 25. */
  alertMinChanged: (): number => Math.floor(positive(process.env.PLEX_POSTER_ALERT_MIN, 25)),
};
