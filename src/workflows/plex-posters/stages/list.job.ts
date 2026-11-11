import { defineStage } from '../../../engine/index.js';
import { plexPostersConfig } from '../config.js';
import { posterList } from '../contracts.js';
import { runList } from './list.js';

export default defineStage({
  name: 'plex-posters-list',
  description:
    'First stage of the weekly Plex poster backup. Asks Plex for its libraries and, for every film ' +
    'and TV library it finds, lists every film, show and season with the path of the poster it ' +
    'currently shows. It reads live every time (never from the response cache) and makes one ' +
    'request per library per kind of item, so it is a handful of calls however large the library ' +
    'is. The libraries are discovered from Plex, so one added later is covered without any setup. ' +
    'It writes the list to data/out/poster-list.json and fails, writing nothing, if Plex lists no ' +
    'titles at all, since an empty read would make the next snapshot look as if every poster had ' +
    'been removed. Read-only: it changes nothing in Plex.',
  timeoutMs: 300_000,
  maxRetries: 3,
  outputs: { list: { artifact: posterList, location: () => plexPostersConfig.listOut } },
  async run(ctx) {
    ctx.output('list').write(await runList(ctx));
  },
});
