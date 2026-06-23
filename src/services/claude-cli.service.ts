import type { ServiceDefinition } from '../core/types.js';

/** The Claude Code CLI worker — $0 under the user's plan. Sequential use only
 *  (linear DAG, one-active-run-per-workflow, long per-call durations); no rate cap. */
const service: ServiceDefinition = {
  name: 'claude-cli',
  description: 'Claude Code CLI (`claude -p`). Free under the plan; sequential use, no rate cap.',
  paid: false,
};

export default service;
