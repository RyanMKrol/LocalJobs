import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluatePart } from '../lib.js';
import type { PlexPart } from '../types.js';
import { weekKey } from './scan.js';

test('weekKey formats an ISO calendar week', () => {
  // 2026-07-06 is a Monday in ISO week 28.
  assert.equal(weekKey(new Date('2026-07-06T00:00:00Z')), '2026-W28');
});

test('evaluatePart resolves a genuine channel-count tie to change/already-correct, never a 4th status', () => {
  const part: PlexPart = {
    id: 1,
    file: '/movies/example/example.mkv',
    Stream: [
      { id: 10, streamType: 2, index: 0, languageTag: 'ja', channels: 6, codec: 'dca', title: 'DTS-HD MA 5.1', selected: false, default: false },
      { id: 11, streamType: 2, index: 1, languageTag: 'ja', channels: 6, codec: 'dca', title: 'DTS-HD MA 5.1', selected: false, default: false },
    ],
  };

  const entry = evaluatePart('123', 'Example Movie', undefined, part, ['ja']);

  // Only the 3 real statuses may ever be produced — no 'ambiguous' carve-out.
  assert.ok(entry.status === 'change' || entry.status === 'already-correct');
  // The tie resolves deterministically to the lowest-index candidate.
  assert.equal(entry.proposedAudio?.streamId, 10);
});

test('evaluatePart still resolves a tie deterministically when the two candidates have different labels', () => {
  const part: PlexPart = {
    id: 2,
    Stream: [
      { id: 21, streamType: 2, index: 0, languageTag: 'ko', channels: 2, codec: 'ac3', title: 'Korean Stereo' },
      { id: 22, streamType: 2, index: 1, languageTag: 'ko', channels: 2, codec: 'ac3', title: 'Korean 2.0 Alt' },
    ],
  };

  const entry = evaluatePart('456', 'Example Show', 'S01E01', part, ['ko']);

  assert.ok(entry.status === 'change' || entry.status === 'already-correct');
  assert.equal(entry.proposedAudio?.streamId, 21);
});

test('evaluatePart reports no-match when no track exists in any candidate language', () => {
  const part: PlexPart = {
    id: 3,
    Stream: [{ id: 31, streamType: 2, index: 0, languageTag: 'en', channels: 2, codec: 'ac3' }],
  };

  const entry = evaluatePart('789', 'Example Movie 2', undefined, part, ['fr']);

  assert.equal(entry.status, 'no-match');
  assert.equal(entry.proposedAudio, undefined);
});
