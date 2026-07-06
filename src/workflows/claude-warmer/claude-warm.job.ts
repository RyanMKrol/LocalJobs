import type { JobDefinition } from '../../core/types.js';
import { runClaude } from '../../services/claude.js';
import { QuotaExceededError } from '../../core/services.js';

const WARM_MODEL = 'claude-haiku-4-5-20251001';
const WARM_PROMPT = 'hi';

const job: JobDefinition = {
  name: 'claude-warm',
  description:
    'Fires one minimal "hi" prompt at the cheapest available Claude model purely to keep the ' +
    'account\'s 5-hour rolling usage window warm. Claude plans meter usage in rolling windows, ' +
    'so if this workflow runs proactively every 30 minutes through off-hours, the window is ' +
    'already running (or freshly reset) by the time a real, more expensive job actually needs ' +
    'Claude, instead of that job paying the cost of opening a fresh window itself. This job ' +
    'enforces no local quota or spend cap of its own — the upstream Claude plan is the sole ' +
    'limiter. A hit rate limit or quota ceiling is treated as an expected, non-fatal outcome: ' +
    'it is logged as a warning and the run exits cleanly rather than failing, since a limit ' +
    'being hit simply means the usage window is already active, which is this job\'s entire goal.',
  timeoutMs: 60_000,
  maxRetries: 0,
  async run(ctx) {
    ctx.log(`Sending warm prompt to Claude (model: ${WARM_MODEL}): "${WARM_PROMPT}"`);
    try {
      const result = await runClaude(WARM_PROMPT, WARM_MODEL);
      if (result.rateLimited) {
        ctx.log(`Claude usage/rate limit reached (model: ${WARM_MODEL}) — window already active (${result.error ?? ''})`, 'warn');
        return;
      }
      if (!result.ok) {
        ctx.log(`Claude warm call failed (model: ${WARM_MODEL}, non-fatal): ${result.error ?? 'unknown error'}`, 'warn');
        return;
      }
      ctx.log(`Warm call succeeded (model: ${WARM_MODEL}) — usage window is active.`);
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        ctx.log(`claude-cli service quota exceeded (model: ${WARM_MODEL}, upstream plan limit) — window already active: ${err.message}`, 'warn');
        return;
      }
      ctx.log(`Unexpected error during warm call (model: ${WARM_MODEL}, non-fatal): ${String(err)}`, 'warn');
    }
  },
};

export default job;
