import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Project root (one level up from src/). */
export const ROOT = resolve(__dirname, '..');

export const config = {
  /** Path to the SQLite database file. */
  dbPath: process.env.LOCALJOBS_DB ?? resolve(ROOT, 'data', 'jobs.db'),

  /** Port the orchestrator's HTTP API listens on (localhost only). */
  apiPort: Number(process.env.LOCALJOBS_PORT ?? 4789),

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
