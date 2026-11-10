import { defineStage } from '../../../engine/index.js';
import { perfumesConfig } from '../config.js';
import { fragranticaPages, fragranticaUrls } from '../contracts.js';
import { rowFields } from '../lib.js';
import { runFetch } from './fetch.js';

export default defineStage({
  name: 'perfumes-fetch',
  description:
    'Stage 2 of the perfumes workflow. For each perfume with a resolved Fragrantica URL from ' +
    'stage 1, launches a real (non-bundled) Chrome via the shared launchPersistentBrowser helper ' +
    'against the framework\'s shared persistent profile, so Cloudflare clearance cookies carry ' +
    'over across items and across runs. It waits out any Cloudflare challenge, scrolls the page ' +
    'to trigger lazy-loaded content, and saves the result: a successful capture saves the page\'s ' +
    'plain text to data/out/pages/<id>.txt (and the raw page to <id>.html beside it), while a ' +
    'page diagnosed as blocked or too short is saved to data/out/pages-failed/ for debugging and ' +
    'the perfume is recorded as failed with what came back. Requests are paced through the ' +
    'fragrantica service (roughly a 12 second minimum interval plus jitter), since the site\'s ' +
    'blocking is reputation/rate based rather than per-request fingerprinting.',
  timeoutMs: 0,
  maxRetries: 3,
  inputs: { urls: { artifact: fragranticaUrls } },
  outputs: {
    pages: { artifact: fragranticaPages, location: () => perfumesConfig.pagesDir, cumulative: true },
  },
  describeItem: (d) => ({
    title: String(d.name ?? ''),
    fields: rowFields(d, [['Captured', d.textLength != null && !d.error ? `${d.textLength} chars` : undefined], ['HTTP', d.httpStatus], ['Page title', d.pageTitle]]),
  }),
  async run(ctx) {
    await runFetch(ctx, { urls: ctx.input('urls').read() });
  },
});
