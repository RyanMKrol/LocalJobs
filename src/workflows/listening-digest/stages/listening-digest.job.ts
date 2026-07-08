import type { JobDefinition } from '../../../core/types.js';
import { runListeningDigest } from './listening-digest.js';

const job: JobDefinition = {
  name: 'lastfm-digest',
  description:
    'Once a month, calls the Last.fm API for the two aggregated endpoints user.getTopAlbums and ' +
    'user.getTopTracks TWICE — once with period=1month and once with period=3month — and writes ' +
    'TWO markdown digest files to data/out/: a current-month digest and a trailing-3-months ' +
    'digest, both using the exact same fetch/filter/render pipeline. Before writing either file, ' +
    'it filters out any album where a single track accounts for 70% or more of that album\'s ' +
    'total plays in the relevant period, since that pattern almost always means one song was ' +
    'left on repeat rather than the whole album genuinely being a top listen (the same heuristic ' +
    'the owner\'s ryankrol.co.uk /listening page already applies). There is deliberately no ' +
    'DynamoDB or other persistence step here: the owner\'s website reads Last.fm\'s own ' +
    'period-based aggregation directly, so this job has nothing further to store beyond the two ' +
    'digest files themselves. Idempotency is keyed by calendar month (YYYY-MM for the 1-month ' +
    'digest, YYYY-MM-3month for the trailing digest) in the work_items ledger, so a manual ' +
    're-run within the same month regenerates both digests in place rather than creating ' +
    'duplicates.',
  timeoutMs: 60_000,
  maxRetries: 3,
  async run(ctx) {
    await runListeningDigest(ctx);
  },
};

export default job;
