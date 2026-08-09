import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resources live alongside the job itself (src/workflows/media-reviews/data),
// never in a far-off top-level folder. Paths are resolved relative to this file.
import { resolveWorkflowDataDir } from '../../config.js';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolveWorkflowDataDir(resolve(here, 'data'));

/**
 * Table names + output paths for the media-reviews builders. The four tables
 * are the live source of truth behind the owner's website review pages
 * (ryankrol.co.uk/reviews/*), read via the shared read-only `dynamodb` service
 * — same AWS credentials the perfumes workflow already uses (T401 precedent),
 * no new connectivity config. Table names default to the site's current table
 * versions and are env-overridable so a future site-side table migration
 * (V4 → V5) is a one-line .env change here.
 */
export const mediaReviewsConfig = {
  dataDir,
  outDir: resolve(dataDir, 'out'),
  booksOutDir: resolve(dataDir, 'out', 'books'),
  moviesOutDir: resolve(dataDir, 'out', 'movies'),
  tvOutDir: resolve(dataDir, 'out', 'tv'),
  albumsOutDir: resolve(dataDir, 'out', 'albums'),

  booksTable: process.env.MEDIA_REVIEWS_BOOKS_TABLE ?? 'BookRatingsV4',
  moviesTable: process.env.MEDIA_REVIEWS_MOVIES_TABLE ?? 'MovieRatingsV4',
  tvTable: process.env.MEDIA_REVIEWS_TV_TABLE ?? 'TelevisionRatingsV4',
  albumsTable: process.env.MEDIA_REVIEWS_ALBUMS_TABLE ?? 'AlbumRatingsV3',
};
