import type { JobDefinition } from '../../../core/types.js';
import { CATEGORY_SPECS, runReviewBuild } from './build.js';

const job: JobDefinition = {
  name: 'media-reviews-tv',
  description:
    'Scans the owner\'s TelevisionRatingsV4 DynamoDB table — the live store behind ryankrol.co.uk/reviews/tv, ' +
    'byte-identical in shape to the movies table — via the shared read-only dynamodb service (one paginated ' +
    'full-table Scan per run, response-cached for 22 hours) and writes one markdown file per TV review to ' +
    'data/out/tv/: YAML frontmatter with the title, first-air year (from the TMDB release date when the site ' +
    'recorded one), rating, review dates, TMDB id, and a full poster URL built from the stored relative ' +
    'posterPath, then the review text verbatim under ## Review plus an optional ## Overview carrying the ' +
    'TMDB synopsis. It is idempotent per review via a content-hash marker stored in the work_items ledger: ' +
    'an item whose sha256 hash of the whole raw Dynamo row is unchanged since its last successful write is ' +
    'skipped entirely, so re-runs only rewrite reviews that were added or edited — and because the hash ' +
    'covers the whole row, metadata backfills that do not stamp editedDate still trigger a rewrite. Legacy ' +
    'rows with no usable id and rows missing required fields are logged and skipped without failing the run; ' +
    'a genuine per-item write failure marks that item failed and fails the run at the end so it retries.',
  timeoutMs: 600_000,
  maxRetries: 2,
  async run(ctx) {
    await runReviewBuild(ctx, CATEGORY_SPECS.tv);
  },
};

export default job;
