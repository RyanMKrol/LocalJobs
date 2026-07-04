import type { WorkflowDefinition } from '../../core/types.js';

/**
 * Claude-warmer: issue one minimal Claude CLI prompt every 30 minutes.
 *
 * WHY: Claude accounts have a 5-hour rolling usage window. If the first call of
 * the day happens when you sit down to work, the window resets 5 hours later —
 * right in the middle of your session. This workflow fires proactively during
 * off-hours so the window is already well underway (or reset) by the time you
 * need Claude. One tiny "hi" prompt is all it takes to start the clock.
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
  schedule: '*/30 * * * *',
  maxConcurrency: 1,
  jobs: [{ job: 'claude-warm' }],
};

export default workflow;
