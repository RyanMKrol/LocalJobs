import { defineStage } from '../../../engine/index.js';
import { perfumesConfig } from '../config.js';
import { fragranticaUrls } from '../contracts.js';
import { loadPerfumes, rowFields } from '../lib.js';
import { runFindUrl } from './find-url.js';

export default defineStage({
  name: 'perfumes-find-url',
  description:
    'Stage 1 of the perfumes workflow. Root stage: reads the full perfume backlog from the ' +
    '(read-only) DynamoDB scan of the PerfumeRatings table via inputKeys(), so a manual run can ' +
    'be limited to the first N perfumes. For every perfume that has no already-known ' +
    'fragranticaUrl, it asks Claude Code (with web search enabled) to find that perfume\'s ' +
    'Fragrantica page, and adds the resolved URL to data/out/fragrantica-urls.json, the store ' +
    'the fetch and build stages are handed. Perfumes that already carry a fragranticaUrl from ' +
    'the DynamoDB row skip the Claude call entirely. Each Claude call is routed through the ' +
    'shared claude-cli service (rate/quota limited). A perfume that fails is recorded and the ' +
    'rest are still attempted, then the run fails so it is retried on the next cycle rather ' +
    'than silently dropping the item. A Claude usage limit stops the stage politely instead.',
  timeoutMs: 0,
  maxRetries: 3,
  inputKeysService: 'dynamodb',
  // Root stage (T094): each perfume id is an originating input. A manual run-limit
  // selects the first N of these; the same id keys every downstream stage (1:1),
  // so root_key propagates for free. Guarded so a transient DynamoDB read failure
  // never breaks run-start selection in the daemon.
  async inputKeys() {
    try { return (await loadPerfumes()).map((p) => p.id); } catch { return []; }
  },
  // The URL store grows over many runs: a run that resolved nothing new carries it forward.
  outputs: {
    urls: { artifact: fragranticaUrls, location: () => perfumesConfig.urlsFile, cumulative: true },
  },
  describeItem: (d) => ({
    title: String(d.name ?? ''),
    fields: rowFields(d, [['URL', d.url], ['Source', d.url ? (d.seeded ? 'PerfumeRatings' : 'web search') : undefined]]),
  }),
  async run(ctx) {
    await runFindUrl(ctx);
  },
});
