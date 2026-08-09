import type { JobDefinition } from '../../../core/types.js';
import { CATEGORY_SPECS, runReviewBuild } from './build.js';

const job: JobDefinition = {
  name: 'media-reviews-books',
  description:
    'Scans the owner\'s BookRatingsV4 DynamoDB table — the live store behind ryankrol.co.uk/reviews/books — ' +
    'via the shared read-only dynamodb service (one paginated full-table Scan per run, response-cached for ' +
    '22 hours) and writes one markdown file per book review to data/out/books/: YAML frontmatter with the ' +
    'title, author, rating, review dates, and whatever enrichment the site recorded (ISBN, publisher, page ' +
    'count, series, subjects, cover URL, Hardcover rating), then the review text verbatim under ## Review ' +
    'plus an optional ## Synopsis. It is idempotent per review via a content-hash marker stored in the ' +
    'work_items ledger: an item whose sha256 hash of the whole raw Dynamo row is unchanged since its last ' +
    'successful write is skipped entirely, so re-runs only rewrite reviews that were added or edited — and ' +
    'because the hash covers the whole row, metadata backfills that do not stamp editedDate still trigger a ' +
    'rewrite. Legacy rows with no usable id and rows missing required fields are logged and skipped without ' +
    'failing the run; a genuine per-item write failure marks that item failed and fails the run at the end ' +
    'so it retries.',
  timeoutMs: 600_000,
  maxRetries: 2,
  async run(ctx) {
    await runReviewBuild(ctx, CATEGORY_SPECS.books);
  },
};

export default job;
