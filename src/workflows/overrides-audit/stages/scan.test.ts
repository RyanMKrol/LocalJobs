// Pure-logic tests for the overrides-audit scan stage — no live daemon/dashboard.
import assert from 'node:assert/strict';
import { formatAge, weekKey } from './scan.js';

// ── weekKey: ISO-8601 calendar week ──
assert.equal(weekKey(new Date('2026-07-06T00:00:00Z')), '2026-W28', 'a Monday');
assert.equal(weekKey(new Date('2026-07-10T00:00:00Z')), '2026-W28', 'a Friday in the same week');
console.log('  ✓ weekKey renders the ISO-8601 calendar week');

// ── formatAge ──
assert.equal(formatAge(null), 'unknown (since before this feature existed)');
assert.equal(formatAge(0), '0 day(s)');
assert.equal(formatAge(24 * 60 * 60 * 1000), '1 day(s)');
assert.equal(formatAge(20 * 24 * 60 * 60 * 1000), '20 day(s)');
console.log('  ✓ formatAge renders a null age as "unknown", else a whole-day count');
