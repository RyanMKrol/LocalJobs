import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Project root (one level up from src/). */
export const ROOT = resolve(__dirname, '..');

export const config = {
  /** Path to the SQLite database file. */
  dbPath: process.env.LOCALJOBS_DB ?? resolve(ROOT, 'data', 'jobs.db'),

  /**
   * Shared persistent Chrome profile used by all headless-browser scrape jobs.
   * Keeping a single on-disk profile across runs lets Cloudflare clearance cookies
   * survive, so any job that calls `launchPersistentBrowser` stays trusted.
   * Override to an absolute path on machines where the default location won't work.
   */
  chromeProfileDir: process.env.LOCALJOBS_CHROME_PROFILE ?? resolve(ROOT, 'data', 'chrome-profile'),

  /** Port the orchestrator's HTTP API listens on (localhost only). */
  apiPort: Number(process.env.LOCALJOBS_PORT ?? 4789),

  /**
   * Address the HTTP API binds to. Defaults to loopback (`127.0.0.1`) so the
   * API is NOT reachable off the machine. Override (e.g. to a Tailscale
   * interface address or `0.0.0.0`) only when you intend remote access — and
   * then set `LOCALJOBS_TOKEN` so mutating endpoints require it.
   */
  apiHost: process.env.LOCALJOBS_HOST ?? '127.0.0.1',

  /**
   * Browser origins allowed to call the API (CORS allowlist). Comma-separated.
   * Defaults to the local dashboard on both loopback spellings. A request whose
   * `Origin` is not in this list gets no `Access-Control-Allow-Origin`, so a
   * browser blocks the cross-origin response. Non-browser callers (no `Origin`)
   * are unaffected.
   */
  allowedOrigins: (process.env.LOCALJOBS_ALLOWED_ORIGINS ??
    'http://localhost:4788,http://127.0.0.1:4788')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  /**
   * Shared secret guarding mutating endpoints (run/toggle/prune/…) for NON-loopback
   * callers. Empty = no token: mutations are then accepted ONLY from loopback
   * (the local dashboard). When set, a remote caller must send it as
   * `X-LocalJobs-Token: <token>` or `Authorization: Bearer <token>`. Required
   * once the API is exposed over Tailscale.
   */
  authToken: process.env.LOCALJOBS_TOKEN ?? '',

  /**
   * ntfy.sh topic for failure alerts. Leave unset to disable push alerts
   * (runs are still always recorded in the dashboard either way).
   */
  ntfyTopic: process.env.LOCALJOBS_NTFY_TOPIC ?? '',

  /** Base URL of the ntfy server (default the public ntfy.sh). */
  ntfyServer: process.env.LOCALJOBS_NTFY_SERVER ?? 'https://ntfy.sh',

  /** Absolute path to the child job-runner entrypoint. */
  runJobScript: resolve(__dirname, 'runJob.ts'),
};
