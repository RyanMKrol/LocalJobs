import type { JobDefinition } from '../../../core/types.js';
import { normalizedPlacesContract } from '../contracts.js';
import { runIngest } from './ingest.js';

/**
 * Normalize the Google Takeout saved-place CSVs into a single deduped
 * places.json (+ validation report). The foundation step of the places
 * workflow — later jobs resolve CIDs to place_ids and enrich via the Places API.
 */
const job: JobDefinition = {
  name: 'places-ingest',
  description:
    'The first stage of the places workflow. It reads every Google Takeout saved-place CSV under data/raw/Saved/ (the ' +
    "Maps/Maps (your places) exports are intentionally ignored), parses and dedupes them, and writes a single normalized " +
    'data/out/places.json plus a data/out/validation-report.json describing any parsing issues found. Only CID-bearing ' +
    'places are carried forward into the pipeline; name-only entries with no CID are dropped since nothing downstream can ' +
    'resolve them. This stage owns the workflow per-item ledger: it records one work_items row per CID, re-recording the ' +
    'full current list on every run (an idempotent upsert, never a skip), which anchors the Input to Output mapping shown ' +
    'on the dashboard for every later stage. If validation finds any error-level issue the job throws, failing the run and ' +
    'blocking cid-to-place-id-resolver from starting.',
  timeoutMs: 120_000,
  maxRetries: 3,
  produces: [normalizedPlacesContract()],
  async run(ctx) {
    const report = await runIngest(ctx);
    if (!report.ok) {
      throw new Error(
        `Ingest validation failed: ${report.issues.filter((i) => i.level === 'error').length} error(s). ` +
          `See places-data/out/validation-report.json`,
      );
    }
  },
};

export default job;
