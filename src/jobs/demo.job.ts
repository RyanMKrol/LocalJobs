import type { JobDefinition } from '../core/types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A harmless demo job: ticks progress 0 -> 100 over ~10s, logs as it goes,
 * and randomly fails ~25% of the time so you can see both outcomes and the
 * failure alert path in the dashboard.
 */
const demoJob: JobDefinition = {
  name: 'demo',
  description: 'Demo job — ticks progress over ~10s and randomly succeeds or fails.',
  schedule: null, // manual-only; trigger it from the dashboard
  timeoutMs: 30_000,
  maxRetries: 0,
  async run(ctx) {
    ctx.log('Starting demo job');
    const steps = 10;
    for (let i = 1; i <= steps; i++) {
      await sleep(1000);
      const pct = (i / steps) * 100;
      ctx.progress(pct, `Step ${i}/${steps}`);
      ctx.log(`Completed step ${i}`);
    }
    if (Math.random() < 0.25) {
      throw new Error('Random demo failure (this happens ~25% of the time)');
    }
    ctx.log('Demo job finished successfully');
  },
};

export default demoJob;
