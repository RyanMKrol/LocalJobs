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
  description: 'Normalize Takeout saved-place CSVs into places.json + validation report.',
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
