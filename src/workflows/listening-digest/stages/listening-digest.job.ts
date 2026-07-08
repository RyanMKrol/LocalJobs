import type { JobDefinition } from '../../../core/types.js';
import { runListeningDigest } from './listening-digest.js';

const job: JobDefinition = {
  name: 'lastfm-digest',
  description:
    'Once a month, calls the Last.fm API for the two aggregated endpoints user.getTopAlbums and ' +
    'user.getTopTracks with period=1month, then writes a markdown digest of the results to ' +
    'data/out/. Before writing, it filters out any album where a single track accounts for 70% ' +
    'or more of that album\'s total plays this period, since that pattern almost always means ' +
    'one song was left on repeat rather than the whole album genuinely being a top listen ' +
    '(the same heuristic the owner\'s ryankrol.co.uk /listening page already applies). There is ' +
    'deliberately no DynamoDB or other persistence step here: the owner\'s website reads ' +
    'Last.fm\'s own period-based aggregation directly, so this job has nothing further to store ' +
    'beyond the digest file itself. Idempotency is keyed by calendar month (YYYY-MM) in the ' +
    'work_items ledger, so a manual re-run within the same month regenerates that month\'s ' +
    'digest in place rather than creating a duplicate.',
  timeoutMs: 60_000,
  maxRetries: 3,
  async run(ctx) {
    await runListeningDigest(ctx);
  },
};

export default job;
