import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveWorkflowDataDir } from '../../config.js';
import type { PathMapPair } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolveWorkflowDataDir(resolve(here, 'data'));

/**
 * Parse the `PLEX_RENAME_PATH_MAP` env var — `plexPrefix=localPrefix` pairs
 * joined by `;` (library paths contain spaces and dashes but never `;`/`=`).
 * The map is DELIBERATELY env-only with no committed default: this repo is
 * public and the share names describe the owner's machine topology. An
 * empty/missing map is not an error at load — the verify stage marks every
 * item `unmapped-path` loudly and nothing can mutate.
 */
export function parsePathMap(raw: string | undefined): PathMapPair[] {
  if (!raw) return [];
  const pairs: PathMapPair[] = [];
  for (const chunk of raw.split(';')) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0 || eq === trimmed.length - 1) continue; // malformed chunk — skipped, verify surfaces the gap
    pairs.push({
      plex: trimmed.slice(0, eq).trim().replace(/\/+$/, ''),
      local: trimmed.slice(eq + 1).trim().replace(/\/+$/, ''),
    });
  }
  return pairs;
}

/**
 * Config for the plex-rename workflow. Plex connectivity itself lives in the
 * shared `src/core/plex-client.ts`; the movie/TV sections reuse the SAME
 * `PLEX_MOVIE_SECTION`/`PLEX_TV_SECTION` env vars every other Plex-touching
 * workflow reads. Everything here is read at module load except where noted.
 */
export const plexRenameConfig = {
  dataDir,
  outDir: resolve(dataDir, 'out'),
  journalDir: resolve(dataDir, 'out', 'journal'),
  reportDir: resolve(dataDir, 'out', 'reports'),

  /** The movie library section to scan. Default 4 (the owner's "Movies"). */
  movieSection: process.env.PLEX_MOVIE_SECTION ?? '4',
  /** The TV library section to scan. Default 5 (the owner's "TV shows"). */
  tvSection: process.env.PLEX_TV_SECTION ?? '5',

  /** Plex-side ↔ local-side share prefix map (env-only, see parsePathMap). */
  pathMap: parsePathMap(process.env.PLEX_RENAME_PATH_MAP),

  /**
   * The still-downloading guard: a file whose mtime is within this many days
   * is NOT eligible to move (downloads land directly in the library folders,
   * so recency is the only in-flight signal). Owner-chosen default: 7.
   */
  minAgeDays: Number(process.env.PLEX_RENAME_MIN_AGE_DAYS ?? '7'),

  /**
   * Daily move quota (media files; sidecars ride along uncounted), enforced
   * via the job_usage meter. Deliberately small to start — the owner raises
   * it in .env as confidence grows.
   */
  maxPerDay: Number(process.env.PLEX_RENAME_MAX_PER_DAY ?? '30'),

  /**
   * Volume-overburden guard: a move is skipped when the TARGET volume's
   * projected utilization AFTER the copy would exceed this percentage.
   * Especially load-bearing for cross-share consolidation moves, which add
   * data to the target volume permanently. Owner-chosen default: 92.
   */
  maxVolumeUtilizationPct: Number(process.env.PLEX_RENAME_MAX_VOLUME_UTILIZATION ?? '92'),

  /**
   * Per-RUN batch cap (0 = no per-run cap, daily quota only). The owner's
   * manual-batch workflow: each trigger applies at most this many, so "run a
   * batch of 1000" needs no cap juggling; the daily cap above stays the
   * overall blast-radius ceiling.
   */
  maxPerRun: Number(process.env.PLEX_RENAME_MAX_PER_RUN ?? '0'),

  /**
   * The probation gate: unset/0 = rehearsal mode (apply logs what it WOULD do,
   * writes the report, journals nothing, mutates nothing). Flipping to 1 is a
   * deliberate .env edit + daemon restart — never a dashboard misclick.
   */
  applyEnabled: process.env.PLEX_RENAME_APPLY_ENABLED === '1',

  /**
   * Plex health-probe budget (ms): apply probes a DATABASE-backed Plex
   * endpoint before the batch and every 25 items; a probe blowing this budget
   * means the server is saturated and the batch stops gracefully (2026-08-11
   * incident: a wedged Plex answered /identity instantly while every
   * DB-backed endpoint hung and clients showed the server unavailable).
   */
  healthProbeTimeoutMs: Number(process.env.PLEX_RENAME_HEALTH_TIMEOUT_MS ?? '15000'),

  /** How long confirm waits for Plex to re-associate a renamed file before failing loud. */
  confirmGraceDays: Number(process.env.PLEX_RENAME_CONFIRM_GRACE_DAYS ?? '14'),
};
