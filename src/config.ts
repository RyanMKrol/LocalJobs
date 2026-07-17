import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Project root (one level up from src/). */
export const ROOT = resolve(__dirname, '..');

/** The real production database path (used as the guard's reference point). */
const PROD_DB = resolve(ROOT, 'data', 'jobs.db');

/**
 * Whether this process is running the unit tests. Load-bearing for one reason:
 * a test must NEVER open the real production DB. `npm test` already points
 * `LOCALJOBS_DB` at a scratch file, but a DIRECT run — `tsx --test src/x.test.ts`
 * or `tsx src/x.test.ts` — sets no such env, so without a guard it falls back to
 * `data/jobs.db` and pollutes production (this once leaked test-fixture workflows
 * into the live dashboard). Detection ORs several robust signals so every test
 * invocation path is covered. Pure (env/argv injectable) for unit testing.
 */
export function isTestEnv(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): boolean {
  if (env.LOCALJOBS_TEST === '1') return true;        // explicit — set by scripts/run-tests.ts
  if (env.NODE_TEST_CONTEXT) return true;             // node --test / tsx --test worker processes
  if (argv.includes('--test')) return true;           // tsx --test …
  // npm-test runner entry, or any test file passed directly (tsx src/x.test.ts).
  return argv.some((a) => /(?:^|[\\/])run-tests\.[tj]s$|\.test\.[tj]s$/.test(a));
}

/**
 * Resolve the DB path with a production-safety guard. In a test context, if the
 * path would be the real production DB (no `LOCALJOBS_DB` override, or one that
 * explicitly points AT the prod file), redirect to a unique per-process scratch
 * DB so a test can never write to `data/jobs.db`. Outside tests, use the explicit
 * override or the production default unchanged (the daemon path). Pure for tests.
 */
export function resolveDbPath(opts: {
  explicit?: string;
  prodDefault?: string;
  isTest?: boolean;
  pid?: number;
  tmp?: string;
  warn?: boolean;
} = {}): string {
  const prodDefault = opts.prodDefault ?? PROD_DB;
  const path = opts.explicit ?? prodDefault;
  const isTest = opts.isTest ?? isTestEnv();
  if (isTest && path === prodDefault) {
    const scratch = join(opts.tmp ?? tmpdir(), `lj-test-guard-${opts.pid ?? process.pid}.db`);
    if (opts.warn ?? true) {
      console.warn(
        `[config] test context detected with no scratch LOCALJOBS_DB — refusing the production DB; using ${scratch}`,
      );
    }
    return scratch;
  }
  return path;
}

/**
 * Per-process cache of test scratch data dirs, keyed by the real data dir a config
 * asked to redirect — so every module that imports the SAME workflow config sees the
 * SAME redirected dir within one test process (a config computes its dir once at
 * import, but this keeps the mapping stable even if called again).
 */
const testDataDirs = new Map<string, string>();

/**
 * Workflow on-disk output guard — the file-artifact analogue of `resolveDbPath`.
 * A workflow config computes `const dataDir = resolveWorkflowDataDir(resolve(here,
 * 'data'))`; every output path (snapshot.json, missing-seasons.json, profiles, …)
 * derives from that. OUTSIDE tests this returns the real dir unchanged (the daemon
 * path — production behaviour is identical). INSIDE a test it redirects to a unique
 * per-process temp dir, so running the suite can NEVER overwrite the owner's live
 * gitignored `data/out` with test fixtures. This was a real, repeated incident: a
 * stage test that calls its `run*()` function writes real output files, and every
 * `npm test` was wiping the owner's Plex snapshot / missing-seasons / profiles output
 * — surfacing as a mysteriously-empty dashboard Output section after a test run. Pure
 * for tests (isTest injectable). No `data/raw` read in any test goes through a config
 * data dir, so redirecting the whole dir is safe.
 */
export function resolveWorkflowDataDir(defaultDir: string, isTest: boolean = isTestEnv()): string {
  if (!isTest) return defaultDir;
  let dir = testDataDirs.get(defaultDir);
  if (!dir) {
    dir = mkdtempSync(join(tmpdir(), 'lj-wf-data-'));
    testDataDirs.set(defaultDir, dir);
  }
  return dir;
}

export const config = {
  /** Path to the SQLite database file (guarded so tests never hit production). */
  dbPath: resolveDbPath({ explicit: process.env.LOCALJOBS_DB }),

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

  /**
   * ntfy exponential-backoff base delay (ms) after the first 429.
   * Each consecutive 429 doubles the cooldown until ntfyBackoffCapMs is reached.
   * A successful send resets the backoff entirely.
   */
  ntfyBackoffBaseMs: Number(process.env.LOCALJOBS_NTFY_BACKOFF_BASE_MS ?? 30_000),

  /**
   * ntfy exponential-backoff hard cap (ms) — the maximum cooldown that can
   * ever be applied between ntfy sends regardless of how many consecutive 429s occur.
   */
  ntfyBackoffCapMs: Number(process.env.LOCALJOBS_NTFY_BACKOFF_CAP_MS ?? 600_000),

  /** Absolute path to the child job-runner entrypoint. */
  runJobScript: resolve(__dirname, 'runJob.ts'),
};
