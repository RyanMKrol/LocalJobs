import type { JobDefinition } from '../../../core/types.js';
import { fragranticaPagesContract, fragranticaUrlsContract } from '../contracts.js';
import { runFetch } from './fetch.js';
import type { StageResult } from '../types.js';

/** A rate-limited pause with no genuine per-item failures is a soft defer, not a
 *  failure — only a real `failed > 0` tally marks the run failed (T420). */
export function assertNoFailures(result: StageResult): void {
  if (result.failed > 0) {
    throw new Error(`${result.failed}/${result.ok + result.failed} page(s) failed to fetch this run — see logs above`);
  }
}

const job: JobDefinition = {
  name: 'perfumes-fetch',
  description:
    'Stage 2 of the perfumes workflow. For each perfume with a resolved Fragrantica URL from ' +
    'stage 1, launches a real (non-bundled) Chrome via the shared launchPersistentBrowser helper ' +
    'against the framework\'s shared persistent profile, so Cloudflare clearance cookies carry ' +
    'over across items and across runs. It waits out any Cloudflare challenge, scrolls the page ' +
    'to trigger lazy-loaded content, and saves the result: a successful capture saves the page\'s ' +
    'plain text to data/out/pages/<id>.txt, while a page diagnosed as blocked or too short is ' +
    'saved as raw HTML to data/out/pages-failed/<id>.html for debugging. Requests are paced ' +
    'through the fragrantica service (roughly a 12 second minimum interval plus jitter), since ' +
    'the site\'s blocking is reputation/rate based rather than per-request fingerprinting, not ' +
    'a hard call-count quota. Gated by the fragrantica-pages artifact contract.',
  timeoutMs: 0,
  maxRetries: 3,
  consumes: [fragranticaUrlsContract()],
  produces: [fragranticaPagesContract()],
  async run(ctx) {
    const result = await runFetch(ctx);
    assertNoFailures(result);
  },
};

export default job;
