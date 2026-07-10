import type { WorkflowDefinition } from '../../core/types.js';

/**
 * Claude-warmer: issue one minimal Claude CLI prompt at 08:00 and 16:00 daily.
 *
 * WHY: Claude accounts have a 5-hour rolling usage window. Firing at 16:00 starts
 * a fresh window that resets around 21:00, and firing at 08:00 covers daytime
 * starts. By the time you sit down to do intensive work, the usage window is
 * already a couple of hours old (not just-started), reducing the chance of running
 * out of usage credits mid-session. One tiny "hi" prompt is all it takes to start
 * the clock.
 *
 * No local quota cap is needed — the upstream Claude plan enforces its own limit.
 * If that limit is hit, the CLI fails out and the job soft-fails gracefully.
 */
const workflow: WorkflowDefinition = {
  name: 'claude-warmer',
  category: 'regular-maintenance',
  description:
    'Issue a minimal Claude CLI prompt every 30 min to warm the 5-hour usage window. ' +
    'Soft-fails gracefully if the upstream plan limit is reached.',
  schedule: '0 8,16 * * *',
  maxConcurrency: 1,
  jobs: [{ job: 'claude-warm' }],
};

export default workflow;
