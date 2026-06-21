// Smoke test: importing the registry must not hang or throw. This is the
// regression guard for import cycles — e.g. a job importing core/services.ts
// while services.ts imported the registry back deadlocked the daemon at boot.
// (Counts aren't asserted: they depend on private, gitignored job files.)
import assert from 'node:assert/strict';
import { jobs, pipelines, services } from './registry.js';

assert.ok(Array.isArray(jobs) && jobs.length >= 1, 'jobs should load (at least demo)');
assert.ok(Array.isArray(services), 'services should load');
assert.ok(Array.isArray(pipelines), 'pipelines should load');

console.log(`  ✓ registry loads cleanly (${jobs.length} jobs, ${services.length} services, ${pipelines.length} pipelines)`);
