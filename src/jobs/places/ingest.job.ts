import type { JobDefinition } from '../../core/types.js';
import { normalizedPlacesContract } from './contracts.js';
import { runIngest } from './ingest.js';

/**
 * Normalize the Google Takeout saved-place CSVs into a single deduped
 * places.json (+ validation report). The foundation step of the places
 * workflow — later jobs resolve CIDs to place_ids and enrich via the Places API.
 */
const job: JobDefinition = {
  name: 'places-ingest',
  description: 'Normalize Takeout saved-place CSVs into places.json + validation report.',
  instructions: [
    'Before running:',
    '1. Export a fresh Google Takeout of your Maps data (Saved lists).',
    '2. Copy the export’s "Saved" folder into:',
    '     src/jobs/places/data/raw/Saved/',
    '   (replace the existing contents).',
    '3. Click ▶ Run now — or just wait for the monthly schedule.',
    '',
    'Output is written to src/jobs/places/data/out/:',
    '  • places.json            (normalized, deduped places)',
    '  • validation-report.json (counts + any issues)',
  ].join('\n'),
  schedule: '0 0 1 * *', // 00:00 on the 1st of every month
  timeoutMs: 120_000,
  maxRetries: 0,
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
