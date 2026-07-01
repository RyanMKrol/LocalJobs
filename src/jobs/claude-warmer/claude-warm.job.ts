import type { JobDefinition } from '../../core/types.js';
import { runClaude } from '../../services/claude.js';
import { QuotaExceededError } from '../../core/services.js';

const WARM_MODEL = 'claude-haiku-4-5-20251001';

const job: JobDefinition = {
  name: 'claude-warm',
  description:
    'Issue one minimal Claude CLI prompt to start/maintain the 5-hour usage window. ' +
    'Handles upstream rate-limit / quota errors defensively (logs + exits cleanly).',
  timeoutMs: 60_000,
  maxRetries: 0,
  async run(ctx) {
    ctx.log('Sending warm prompt to Claude to tick the usage window...');
    try {
      const result = await runClaude('hi', WARM_MODEL);
      if (result.rateLimited) {
        ctx.log(`Claude usage/rate limit reached — window already active (${result.error ?? ''})`, 'warn');
        return;
      }
      if (!result.ok) {
        ctx.log(`Claude warm call failed (non-fatal): ${result.error ?? 'unknown error'}`, 'warn');
        return;
      }
      ctx.log('Warm call succeeded — usage window is active.');
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        ctx.log(`claude-cli service quota exceeded (upstream plan limit) — window already active: ${err.message}`, 'warn');
        return;
      }
      ctx.log(`Unexpected error during warm call (non-fatal): ${String(err)}`, 'warn');
    }
  },
};

export default job;
