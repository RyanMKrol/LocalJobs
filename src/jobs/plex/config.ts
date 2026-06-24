import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resources live alongside the job itself (src/jobs/plex/data), never in a
// far-off top-level folder. Paths are resolved relative to this file.
const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, 'data');

/**
 * Connectivity + paths for the Plex new-seasons audit. Tokens/host come from the
 * environment (gitignored `.env`); only the env var NAMES are published (see
 * `.env.example`). The library data lives in the gitignored `data/` folder.
 */
export const plexConfig = {
  dataDir,
  outDir: resolve(dataDir, 'out'),
  snapshotOut: resolve(dataDir, 'out', 'snapshot.json'),
  missingOut: resolve(dataDir, 'out', 'missing-seasons.json'),
  reportDir: resolve(dataDir, 'out', 'reports'),

  // ── Plex connectivity ──
  /** e.g. https://192.168.1.x:32400 — Plex uses a self-signed cert (see client). */
  host: process.env.PLEX_HOST ?? '',
  token: process.env.PLEX_API_TOKEN ?? '',
  /**
   * Optional Plex server machine identifier. When set, the client's host
   * resolution (PLEX_HOST check + LAN scan, see client.ts) only accepts a server
   * with THIS identifier — so a DHCP IP change is self-healed without ever
   * latching onto a different Plex on the network.
   */
  machineId: process.env.PLEX_MACHINE_ID ?? '',
  /** The TV library section to audit. Default 5 (the owner's "TV shows"). */
  tvSection: process.env.PLEX_TV_SECTION ?? '5',
  requestTimeoutMs: Number(process.env.PLEX_REQUEST_TIMEOUT_MS ?? 30_000),

  // ── TMDB connectivity ──
  /** Bearer token. Accept the legacy TVDB_API_TOKEN name as a fallback. */
  tmdbToken: process.env.TMDB_API_TOKEN ?? process.env.TVDB_API_TOKEN ?? '',
};
