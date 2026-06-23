// Regression guard for T012: the places workflow runs on a DAILY cron (not
// manual-only). The paid-stage spend-cap math (daily = monthly/30) used to live
// here too, but as of T044 the caps moved onto the self-contained top-level
// services — those assertions now live in `src/services/caps.test.ts`.
import assert from 'node:assert/strict';
import workflow from './places.workflow.js';

// The workflow is no longer manual-only — it runs daily at 03:00.
assert.equal(workflow.schedule, '0 3 * * *', 'places workflow must run on a daily cron, not manual-only');

console.log('  ✓ places workflow runs on a daily cron (03:00)');
