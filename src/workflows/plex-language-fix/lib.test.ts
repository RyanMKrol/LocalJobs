import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluatePart } from './lib.js';
import type { PlexPart } from './types.js';

test('evaluatePart resolves a genuine channel-count tie to change/skip, never a 3rd status', () => {
  const part: PlexPart = {
    id: 1,
    file: '/movies/example/example.mkv',
    Stream: [
      { id: 10, streamType: 2, index: 0, languageTag: 'ja', channels: 6, codec: 'dca', title: 'DTS-HD MA 5.1', selected: false, default: false },
      { id: 11, streamType: 2, index: 1, languageTag: 'ja', channels: 6, codec: 'dca', title: 'DTS-HD MA 5.1', selected: false, default: false },
    ],
  };

  const entry = evaluatePart('123', 'Example Movie', undefined, part, ['ja']);

  // Only the 2 real statuses may ever be produced — 'already-correct'/'no-match' collapsed (T453).
  assert.ok(entry.status === 'change' || entry.status === 'skip');
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

  assert.ok(entry.status === 'change' || entry.status === 'skip');
  assert.equal(entry.proposedAudio?.streamId, 21);
});

test('evaluatePart reports skip (no-match) when no track exists in any candidate language', () => {
  const part: PlexPart = {
    id: 3,
    Stream: [{ id: 31, streamType: 2, index: 0, languageTag: 'en', channels: 2, codec: 'ac3' }],
  };

  const entry = evaluatePart('789', 'Example Movie 2', undefined, part, ['fr']);

  assert.equal(entry.status, 'skip');
  assert.equal(entry.proposedAudio, undefined);
  assert.match(entry.note ?? '', /no audio track found/);
});

test('evaluatePart reports skip when the current selection already matches (no change needed)', () => {
  const part: PlexPart = {
    id: 4,
    Stream: [{ id: 41, streamType: 2, index: 0, languageTag: 'en', channels: 2, codec: 'ac3', selected: true }],
  };

  const entry = evaluatePart('999', 'Example Movie 3', undefined, part, ['en']);

  assert.equal(entry.status, 'skip');
  assert.equal(entry.proposedAudio?.streamId, 41);
});
