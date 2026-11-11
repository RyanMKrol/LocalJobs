import { defineStage, fromChecks, inlineArtifact } from '../../engine/index.js';
import { runClaude } from '../../services/claude.js';
import { QuotaExceededError } from '../../core/services.js';

const WARM_MODEL = 'claude-haiku-4-5-20251001';
const WARM_PROMPT = 'hi';

/** What one warm attempt did. */
export interface WarmResult {
  /** `warmed`: the call went through. `already-active`: a limit was hit, so the window is open anyway. `failed`: the call errored (not fatal). */
  outcome: 'warmed' | 'already-active' | 'failed';
  model: string;
  detail?: string;
  at: string;
}

const OUTCOMES = ['warmed', 'already-active', 'failed'];

/** The stage has no file to write: its product is the fact that it tried, and how that went. */
export const warmResult = inlineArtifact<WarmResult>({
  key: 'claude-warm-result',
  description: 'How this warm attempt went: warmed, already active (a limit was hit), or failed.',
  check: (v) => fromChecks([{ label: 'a known outcome', ok: OUTCOMES.includes(v?.outcome), actual: String(v?.outcome) }]),
  summary: (v) => `${v.outcome} (${v.model})`,
});

export default defineStage({
  name: 'claude-warm',
  description:
    'Sends one minimal "hi" prompt to a small, cheap Claude model purely to start the ' +
    'account\'s 5-hour rolling usage window. Claude plans meter usage in rolling windows, so ' +
    'because this workflow runs at 08:00 and 16:00 every day, a window is already a couple of ' +
    'hours old by the time intensive work starts, and it resets sooner than one opened by that ' +
    'work itself would. This job enforces no local quota or spend cap of its own: the upstream ' +
    'Claude plan is the only limit. A rate limit or quota ceiling is an expected, non-fatal ' +
    'outcome: it is logged as a warning and the run ends cleanly, since a limit being hit means ' +
    'the usage window is already active, which is all this job is for. Any other error from the ' +
    'call is also logged and does not fail the run. What happened (warmed, already active, or ' +
    'failed) is recorded as the stage\'s output.',
  timeoutMs: 60_000,
  maxRetries: 0,
  outputs: { result: { artifact: warmResult } },
  async run(ctx) {
    const done = (outcome: WarmResult['outcome'], detail?: string) =>
      ctx.output('result').write({ outcome, model: WARM_MODEL, ...(detail ? { detail } : {}), at: new Date().toISOString() });

    ctx.log(`Sending warm prompt to Claude (model: ${WARM_MODEL}): "${WARM_PROMPT}"`);
    try {
      const result = await runClaude(WARM_PROMPT, WARM_MODEL);
      if (result.rateLimited) {
        ctx.log(`Claude usage/rate limit reached (model: ${WARM_MODEL}) — window already active (${result.error ?? ''})`, 'warn');
        return done('already-active', result.error);
      }
      if (!result.ok) {
        ctx.log(`Claude warm call failed (model: ${WARM_MODEL}, non-fatal): ${result.error ?? 'unknown error'}`, 'warn');
        return done('failed', result.error ?? 'unknown error');
      }
      ctx.log(`Warm call succeeded (model: ${WARM_MODEL}) — usage window is active.`);
      done('warmed');
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        ctx.log(`claude-cli service quota exceeded (model: ${WARM_MODEL}, upstream plan limit) — window already active: ${err.message}`, 'warn');
        return done('already-active', err.message);
      }
      ctx.log(`Unexpected error during warm call (model: ${WARM_MODEL}, non-fatal): ${String(err)}`, 'warn');
      done('failed', String(err));
    }
  },
});
