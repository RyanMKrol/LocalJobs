import { defineStage } from '../../../engine/index.js';
import { placesConfig } from '../config.js';
import { normalizedPlaces, validationReport } from '../contracts.js';
import { runIngest } from './ingest.js';

/**
 * Normalize the Google Takeout saved-place CSVs into a single deduped
 * places.json (+ validation report). The first stage of the places workflow:
 * later stages resolve CIDs to place_ids and enrich via the Places API.
 */
export default defineStage({
  name: 'places-ingest',
  description:
    'The first stage of the places workflow. It reads every Google Takeout saved-place CSV under data/raw/Saved/ (the ' +
    "Maps/Maps (your places) exports are intentionally ignored), parses and dedupes them, and writes a single normalized " +
    'data/out/places.json plus a data/out/validation-report.json describing any parsing issues found. Both files are ' +
    'rebuilt on every run and are the stage\'s declared outputs. Name-only entries with no CID stay in places.json but ' +
    'are marked not resolvable, since nothing downstream can resolve them. The stage also records one work_items row ' +
    'per CID-bearing place, keyed by CID, and records the full current list again on every valid run (an upsert, never ' +
    'a skip). If validation finds any error-level issue the job throws, failing the run and blocking ' +
    'cid-to-place-id-resolver from starting.',
  timeoutMs: 120_000,
  maxRetries: 3,
  // Both are rebuilt from the Takeout CSVs on every run.
  outputs: {
    places: { artifact: normalizedPlaces, location: () => placesConfig.placesOut },
    report: { artifact: validationReport, location: () => placesConfig.reportOut },
  },
  async run(ctx) {
    const report = await runIngest(ctx);
    if (!report.ok) {
      throw new Error(
        `Ingest validation failed: ${report.issues.filter((i) => i.level === 'error').length} error(s). ` +
          `See places-data/out/validation-report.json`,
      );
    }
  },
});
