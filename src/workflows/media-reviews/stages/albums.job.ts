import type { JobDefinition } from '../../../core/types.js';
import { CATEGORY_SPECS, runReviewBuild } from './build.js';

const job: JobDefinition = {
  name: 'media-reviews-albums',
  description:
    'Scans the owner\'s AlbumRatingsV3 DynamoDB table — the live store behind ryankrol.co.uk/reviews/albums — ' +
    'via the shared read-only dynamodb service (one paginated full-table Scan per run, response-cached for ' +
    '22 hours) and writes one markdown file per album review to data/out/albums/: YAML frontmatter with the ' +
    'title, artist, rating, review dates, cover-art URL, and the Last.fm enrichment the site recorded (page ' +
    'URL, MusicBrainz id, release date, tags, track count, listener/playcount figures — the latter kept as ' +
    'the strings Last.fm returns), then the review text verbatim under ## Highlights (the albums table\'s ' +
    'name for its review field) plus an optional ## About carrying the Last.fm album summary. It is ' +
    'idempotent per review via a content-hash marker stored in the work_items ledger: an item whose sha256 ' +
    'hash of the whole raw Dynamo row is unchanged since its last successful write is skipped entirely, so ' +
    're-runs only rewrite reviews that were added or edited — and because the hash covers the whole row, ' +
    'metadata backfills that do not stamp editedDate still trigger a rewrite. Legacy rows with no usable id ' +
    'and rows missing required fields are logged and skipped without failing the run; a genuine per-item ' +
    'write failure marks that item failed and fails the run at the end so it retries.',
  timeoutMs: 600_000,
  maxRetries: 2,
  async run(ctx) {
    await runReviewBuild(ctx, CATEGORY_SPECS.albums);
  },
};

export default job;
