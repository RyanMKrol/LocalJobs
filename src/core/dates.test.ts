import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { dayKey, weekKey } from './dates.js';

describe('weekKey', () => {
  it('maps a Monday and a Friday in the same ISO week to the same key', () => {
    assert.equal(weekKey(new Date('2026-07-06T00:00:00Z')), '2026-W28', 'a Monday');
    assert.equal(weekKey(new Date('2026-07-10T00:00:00Z')), '2026-W28', 'a Friday in the same week');
  });

  it('2025-01-01 (a Wednesday) belongs to ISO week 2025-W01', () => {
    // 2025-01-01 is a Wednesday; its Thursday (2025-01-02) is still in 2025,
    // so it belongs to week 1 of 2025, not a trailing week of 2024.
    assert.equal(weekKey(new Date('2025-01-01T00:00:00Z')), '2025-W01');
  });

  it('a late-December date can belong to next year\'s week 1', () => {
    // 2025-12-29 is a Monday; its Thursday (2026-01-01) falls in 2026, so this
    // date's ISO week-numbering year is 2026, not 2025 — the year-boundary case
    // where the calendar year and the ISO week-numbering year diverge.
    assert.equal(weekKey(new Date('2025-12-29T00:00:00Z')), '2026-W01');
  });

  it('an early-January date can belong to the previous year\'s final week', () => {
    // 2027-01-01 is a Friday; its Thursday (2026-12-31) falls in 2026, so this
    // date belongs to week 53 of 2026, not week 1 of 2027.
    assert.equal(weekKey(new Date('2027-01-01T00:00:00Z')), '2026-W53');
  });
});

describe('dayKey', () => {
  it('renders the UTC calendar day, ignoring the time-of-day', () => {
    assert.equal(dayKey(new Date('2026-07-04T23:59:59.000Z')), '2026-07-04');
    assert.equal(dayKey(new Date('2026-01-01T00:00:00.000Z')), '2026-01-01');
  });

  it('two different UTC days produce different keys', () => {
    assert.notEqual(
      dayKey(new Date('2026-07-04T00:00:00.000Z')),
      dayKey(new Date('2026-07-05T00:00:00.000Z')),
    );
  });
});
