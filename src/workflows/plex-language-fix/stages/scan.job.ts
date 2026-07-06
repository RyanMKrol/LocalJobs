import type { JobDefinition } from '../../../core/types.js';
import { runScan } from './scan.js';

const job: JobDefinition = {
  name: 'plex-language-scan',
  description:
    'Scans every configured Plex library section (movie + TV, and an optional third "downloadable" ' +
    'section only when explicitly enabled), resolves each show/movie\'s true original language via ' +
    'TMDB, and for every audio/subtitle track works out which one SHOULD be selected by default versus ' +
    'what is currently selected. This is entirely read-only — it never issues a mutating request to ' +
    'Plex, only reports proposed changes. A tie between equally-good audio candidates (same channel ' +
    'count, codec, and original-mix status) is resolved automatically by the existing best-judgment ' +
    'heuristic rather than being flagged for manual review. The scan re-reads the whole library fresh ' +
    'every run — it is a periodic audit of drifting real-world state, not an incremental build — with ' +
    'idempotency handled separately via the work_items ledger keyed by ISO calendar week, so a manual ' +
    're-run in the same week regenerates that week\'s scan instead of duplicating it. The full changeset ' +
    'is written to data/out/language-scan.json for a later stage (or the owner) to act on.',
  timeoutMs: 3_600_000,
  maxRetries: 3,
  async run(ctx) {
    await runScan(ctx);
  },
};

export default job;
