import type { JobDefinition } from '../../../core/types.js';
import { plexLanguageScanContract } from '../contracts.js';
import { runNoTrackFlag } from './no-track-flag.js';

const job: JobDefinition = {
  name: 'plex-language-no-track-flag',
  description:
    'Reads the language-scan changeset (never re-scans the library itself, so it never doubles the ' +
    'TMDB service\'s rate/quota spend) and picks out every file the scan already marked status="no-match" ' +
    '— meaning it found ZERO audio track in that title\'s true original language at all. That is a ' +
    'distinct problem from plex-language-apply\'s job of switching which EXISTING track plays by default: ' +
    'a file with no matching track at all is probably the wrong rip/release entirely (e.g. an ' +
    'English-dub-only Western release of a Japanese show) and should be re-acquired, not re-configured. ' +
    'Tracking is per FILE/EPISODE, not per show, since a show can be inconsistent across its own run ' +
    '(some seasons ripped with the original-language track, others without). It uses the same ' +
    '"have I already flagged this?" ledger pattern as the missing-tv-seasons workflow\'s notify stage: a ' +
    'work_items row keyed by "<itemRatingKey>::part<partId>" records whether a file has already been ' +
    'announced, not whether work is done, so a file with the expected track never gets a row at all. Any ' +
    'not-yet-flagged file is newly-detected; all of them are bundled into a single push notification ' +
    '(grouped by show/movie, with an episode count for shows with many flagged episodes) rather than one ' +
    'push per file, then marked flagged so they are never announced again. It also writes a human-readable ' +
    'markdown report to data/out/reports/no-track.md. On a brand-new install the very first run announces ' +
    'the entire current backlog in one digest. The owner can permanently silence a title they know is ' +
    'dub-only by design via the ignore-to-suppress mechanism (ignoreSurfacedItem/unignoreSurfacedItem) ' +
    'exposed on this job\'s ledger.',
  timeoutMs: 120_000,
  maxRetries: 3,
  consumes: [plexLanguageScanContract()],
  async run(ctx) {
    await runNoTrackFlag(ctx);
  },
};

export default job;
