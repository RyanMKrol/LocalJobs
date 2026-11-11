import { resolve } from 'node:path';
import { defineStage } from '../../../engine/index.js';
import { listeningDigestConfig } from '../config.js';
import { listeningDigests } from '../contracts.js';
import { runListeningDigest } from './listening-digest.js';

export default defineStage({
  name: 'lastfm-digest',
  description:
    'Once a month, calls the Last.fm API for the two aggregated endpoints user.getTopAlbums and ' +
    'user.getTopTracks twice, once with period=1month and once with period=3month, and writes ' +
    'two markdown digests to data/out/: the one-month digest (listening-digest-<YYYY-MM>.md) ' +
    'and a trailing three-month digest (listening-digest-<YYYY-MM>-3month.md), both named for the ' +
    'month the run happens in. Before writing either digest, it drops any album whose tracks in ' +
    'that pass\'s top-tracks list add up to 70% or more of the album\'s plays, a check meant to ' +
    'catch one song left on repeat being counted as an album (the same ' +
    'heuristic the owner\'s ryankrol.co.uk /listening page already applies). There is deliberately ' +
    'no DynamoDB or other persistence step here: the owner\'s website reads Last.fm\'s own ' +
    'period-based aggregation directly, so this job has nothing further to store beyond the ' +
    'digest files themselves. The folder of digests is the stage\'s declared output, and each ' +
    'digest written is one item in the ledger, keyed by calendar month (YYYY-MM, and ' +
    'YYYY-MM-3month for the trailing one), so a manual re-run within the same month rewrites both ' +
    'digests in place rather than creating duplicates. Those ledger rows are what vault-sync ' +
    'reads to copy the digests into the vault.',
  timeoutMs: 60_000,
  maxRetries: 3,
  // The digests accumulate month by month, but every run writes this month's two.
  outputs: {
    digests: { artifact: listeningDigests, location: () => resolve(listeningDigestConfig.dataDir, 'out') },
  },
  async run(ctx) {
    await runListeningDigest(ctx);
  },
});
