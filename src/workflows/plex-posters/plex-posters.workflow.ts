import type { WorkflowDefinition } from '../../core/types.js';

/**
 * plex-poster-backup: a weekly backup of the poster every film, show and season
 * in Plex currently shows.
 *
 *   plex-posters-list ──▶ plex-posters-fetch ──▶ plex-posters-record ──▶ plex-posters-alert
 *
 * Posters chosen or uploaded by hand are the one part of a Plex library that a
 * metadata refresh, a re-match or a rebuilt database can silently replace. This
 * keeps every one of them, with a dated record of which title had which image, so
 * they can be put back (scripts/plex-posters-restore.ts, run by hand).
 *
 * The images and the snapshots live in an archive folder outside this repo
 * (PLEX_POSTER_ARCHIVE_DIR, a NAS share on the owner's machine), named by the hash
 * of their contents, so a week in which nothing changed adds one small snapshot
 * file and no images.
 *
 * Sundays at 04:00: after the nightly Plex-heavy runs have finished, and fifteen
 * minutes after mount-keeper's 03:45 check that the share is mounted.
 */
const workflow: WorkflowDefinition = {
  name: 'plex-poster-backup',
  category: 'regular-maintenance',
  description:
    'Backs up the poster every film, show and season in Plex currently shows, once a week. Each run ' +
    'lists every title in every film and TV library, downloads only the posters that are new since ' +
    'the last run into an archive folder (on a NAS share), and writes a dated snapshot recording ' +
    'which title had which image. Images are stored once each, named by their contents, so the ' +
    'archive grows only when posters actually change. It sends one alert if a large share of ' +
    'posters changed in a week, which usually means a metadata refresh replaced chosen artwork. ' +
    'Putting posters back is a separate script run by hand.',
  idempotencyNote:
    'Every run looks at every title again; nothing is skipped by a ledger. What makes a run cheap is ' +
    'the archive itself: a poster whose path Plex has not changed, and whose image is already ' +
    'archived, is not downloaded again, and an image is only ever stored once. Running it twice in a ' +
    'row writes a second small snapshot file and downloads nothing.',
  schedule: '0 4 * * 0',
  maxConcurrency: 1,
  jobs: [
    { job: 'plex-posters-list' },
    { job: 'plex-posters-fetch', dependsOn: ['plex-posters-list'] },
    { job: 'plex-posters-record', dependsOn: ['plex-posters-fetch'] },
    { job: 'plex-posters-alert', dependsOn: ['plex-posters-record'] },
  ],
};

export default workflow;
