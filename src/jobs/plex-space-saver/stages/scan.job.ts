import type { JobDefinition } from '../../../core/types.js';
import { runScan } from './scan.js';

const job: JobDefinition = {
  name: 'plex-space-saver-scan',
  description: 'Scans the Plex movie + TV library and writes a biggest-first disk-size breakdown (report only, no deletion suggestions).',
  timeoutMs: 300_000,
  maxRetries: 3,
  async run(ctx) {
    await runScan(ctx);
  },
};

export default job;
