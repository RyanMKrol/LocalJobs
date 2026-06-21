import type { ServiceDefinition } from '../../core/types.js';

/** The Claude Code CLI worker — $0 under the user's plan. No hard quota; a gentle
 *  per-minute rate just avoids bursting many concurrent `claude -p` processes. */
const service: ServiceDefinition = {
  name: 'claude-cli',
  description: 'Claude Code CLI (claude -p). Free under the plan; rate-gated to avoid bursts.',
  ratePerMinute: 20,
  paid: false,
};

export default service;
