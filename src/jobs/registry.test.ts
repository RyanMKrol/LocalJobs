// Smoke test: importing the registry must not hang or throw. This is the
// regression guard for import cycles — e.g. a job importing core/services.ts
// while services.ts imported the registry back deadlocked the daemon at boot.
// (Counts aren't asserted: they depend on private, gitignored job files.)
import assert from 'node:assert/strict';
import { getJobDefinition, jobs, pipelines, services } from './registry.js';

assert.ok(Array.isArray(jobs) && jobs.length >= 1, 'jobs should load');
assert.ok(Array.isArray(services), 'services should load');
assert.ok(Array.isArray(pipelines), 'pipelines should load');

// The places + perfumes pipelines are tracked/public, so a representative member
// job must load on a clean public checkout. Assert by name rather than by count —
// exact counts depend on any private, gitignored jobs that may also be present.
assert.ok(getJobDefinition('perfumes-fetch'), 'perfumes-fetch job should be discovered + loaded');

console.log(`  ✓ registry loads cleanly (${jobs.length} jobs, ${services.length} services, ${pipelines.length} pipelines)`);
