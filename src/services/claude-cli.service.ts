import type { ServiceDefinition } from '../core/types.js';

/** Claude Code CLI worker (`claude -p`). No LOCAL rate/quota cap is set here — NOT because
 *  usage is unlimited, but because the cap is enforced UPSTREAM by the Claude plan: when you
 *  hit the plan's usage limit the CLI fails out, and that surfaces gracefully (the harness's
 *  rate-limit detection backs off + resumes; jobs catch QuotaExceededError / the failure and
 *  soft-fail). So a local cap would be redundant — the upstream limit governs, gracefully.
 *  Sequential use only (linear DAG, one-active-run-per-workflow, long per-call durations);
 *  no marginal per-call charge under the plan. */
const service: ServiceDefinition = {
  name: 'claude-cli',
  category: 'cli-tool',
  description: 'Claude Code CLI (`claude -p`). No local cap: usage is capped UPSTREAM by the Claude plan and fails out gracefully when hit (the loop backs off; jobs soft-fail). Sequential use.',
  paid: false,
};

export default service;
