// Smoke test: importing the registry must not hang or throw. This is the
// regression guard for import cycles — e.g. a job importing core/services.ts
// while services.ts imported the registry back deadlocked the daemon at boot.
// (Counts aren't asserted: they depend on private, gitignored job files.)
import assert from 'node:assert/strict';
import { getJobDefinition, jobs, workflows, services } from './registry.js';

assert.ok(Array.isArray(jobs) && jobs.length >= 1, 'jobs should load');
assert.ok(Array.isArray(services), 'services should load');
assert.ok(Array.isArray(workflows), 'workflows should load');

// The places + perfumes workflows are tracked/public, so a representative member
// job must load on a clean public checkout. Assert by name rather than by count —
// exact counts depend on any private, gitignored jobs that may also be present.
assert.ok(getJobDefinition('perfumes-fetch'), 'perfumes-fetch job should be discovered + loaded');

console.log(`  ✓ registry loads cleanly (${jobs.length} jobs, ${services.length} services, ${workflows.length} workflows)`);

// The registry is where this application plugs into the workflow engine: loading
// it installs the engine's host (job lookup + notifier). The engine imports
// neither, so if this wiring were lost every stage would be "unknown" at run time.
{
  const { engineHost } = await import('../engine/host.js');
  const { jobs: registryJobs } = await import('./registry.js');
  const host = engineHost();
  const known = registryJobs[0]?.name;
  if (known && host.getJob(known)?.name !== known) {
    console.error(`  ✗ the registry did not install the engine host (job "${known}" is not resolvable through it)`);
    process.exitCode = 1;
  } else if (typeof host.notify !== 'function') {
    console.error('  ✗ the registry installed an engine host with no notifier');
    process.exitCode = 1;
  } else {
    console.log('  ✓ loading the registry installs the engine host (job lookup + notifier)');
  }
}
