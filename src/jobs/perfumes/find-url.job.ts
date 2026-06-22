import type { JobDefinition } from '../../core/types.js';
import { fragranticaUrlsContract } from './contracts.js';
import { runFindUrl } from './find-url.js';
import { loadPerfumes } from './lib.js';

const job: JobDefinition = {
  name: 'perfumes-find-url',
  description: 'Stage 1: find each perfume\'s Fragrantica URL via Claude Code (web search).',
  timeoutMs: 0,
  maxRetries: 3,
  produces: [fragranticaUrlsContract()],
  // Root stage (T094): each perfume id is an originating input. A manual run-limit
  // selects the first N of these; the same id keys every downstream stage (1:1),
  // so root_key propagates for free (markWorkItem rule 3). Guarded so a missing
  // input file never breaks run-start selection in the daemon.
  inputKeys() {
    try { return loadPerfumes().map((p) => p.id); } catch { return []; }
  },
  async run(ctx) { await runFindUrl(ctx); },
};

export default job;
