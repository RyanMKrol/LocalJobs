import { defineStage } from '../../../engine/index.js';
import { plexPostersConfig } from '../config.js';
import { posterList, posterSet } from '../contracts.js';
import { runFetch } from './fetch.js';

export default defineStage({
  name: 'plex-posters-fetch',
  description:
    'Makes sure the archive holds the current poster of every listed title. A poster is downloaded ' +
    'from Plex only when its path has not been seen before: Plex puts a version number in the path ' +
    'and changes it whenever the poster or the title\'s metadata changes, so an unchanged path whose ' +
    'image is still in the archive needs nothing. Each downloaded image is stored in the archive ' +
    'under the SHA-1 of its bytes, so the same picture is only ever kept once however many titles ' +
    'or snapshots use it. The archive folder comes from PLEX_POSTER_ARCHIVE_DIR and must already ' +
    'exist and hold its marker file; if it does not (an unmounted network share, usually) the stage ' +
    'fails without writing anything, and it never creates the folder itself. It keeps a small local ' +
    'index of what it has downloaded and saves it as it goes, so a retry does not download the same ' +
    'posters again. A few failed downloads are recorded and reported by the last stage; too many ' +
    'fail this stage. Read-only towards Plex.',
  // A first run with an empty archive downloads every poster (several gigabytes).
  timeoutMs: 7_200_000,
  maxRetries: 2,
  inputs: { list: { artifact: posterList } },
  outputs: { set: { artifact: posterSet, location: () => plexPostersConfig.setOut } },
  async run(ctx) {
    const set = await runFetch(ctx, ctx.input('list').read(), {
      archiveDir: plexPostersConfig.archiveDir(),
      indexFile: plexPostersConfig.indexFile,
      concurrency: plexPostersConfig.fetchConcurrency(),
    });
    ctx.output('set').write(set);
  },
});
