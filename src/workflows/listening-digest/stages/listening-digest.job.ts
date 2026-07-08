import type { JobDefinition } from '../../../core/types.js';
import { runListeningDigest } from './listening-digest.js';

const job: JobDefinition = {
  name: 'lastfm-digest',
  description:
    'Once a month, calls the Last.fm API for the two aggregated endpoints user.getTopAlbums and ' +
    'user.getTopTracks TWICE — once with period=1month and once with period=3month — and writes ' +
    'TWO markdown digests to data/out/: the current-month digest (listening-digest-<YYYY-MM>.md) ' +
    'and a trailing-3-month digest (listening-digest-<YYYY-MM>-3month.md). Before writing either ' +
    'digest, it filters out any album where a single track accounts for 70% or more of that ' +
    'album\'s total plays in that pass\'s period, since that pattern almost always means one song ' +
    'was left on repeat rather than the whole album genuinely being a top listen (the same ' +
    'heuristic the owner\'s ryankrol.co.uk /listening page already applies). There is deliberately ' +
    'no DynamoDB or other persistence step here: the owner\'s website reads Last.fm\'s own ' +
    'period-based aggregation directly, so this job has nothing further to store beyond the ' +
    'digest files themselves. Idempotency is keyed by calendar month in the work_items ledger — ' +
    'the 1-month digest under key YYYY-MM and the 3-month digest under key YYYY-MM-3month — so a ' +
    'manual re-run within the same month regenerates both digests in place rather than creating ' +
    'duplicates.',
  timeoutMs: 60_000,
  maxRetries: 3,
  async run(ctx) {
    await runListeningDigest(ctx);
  },
};

export default job;
