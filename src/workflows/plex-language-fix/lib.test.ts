import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { evaluatePart, fetchAllLeaves, fetchItemDetail, fetchSectionItems, fetchSections } from './lib.js';
import { plexLanguageEvaluateContract } from './contracts.js';
import { markWorkItem } from '../../db/store.js';
import { registerService } from '../../core/services.js';
import type { EvaluateDetail } from './types.js';
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

test('plexLanguageEvaluateContract passes on an empty ledger', async () => {
  // Nothing has been recorded for this job name in this run, so the gate has
  // no "change" rows to violate — must not fail on the empty case.
  const result = await plexLanguageEvaluateContract().check();
  assert.equal(result.ok, true);
});

test('plexLanguageEvaluateContract passes when every row is a valid "change" or "skip"', async () => {
  const validChange: EvaluateDetail = {
    name: 'Valid Change Movie',
    status: 'change',
    currentAudio: { streamId: 1, label: 'English', isExplicit: true },
    currentSubtitle: { streamId: null, label: 'None', isExplicit: false },
    proposedAudio: { streamId: 2, label: 'Japanese', isExplicit: false },
  };
  const skipRow: EvaluateDetail = {
    name: 'Skip Movie',
    status: 'skip',
    currentAudio: { streamId: 3, label: 'English', isExplicit: true },
    currentSubtitle: { streamId: null, label: 'None', isExplicit: false },
  };

  markWorkItem('plex-language-evaluate', `T574-valid-change-${randomUUID()}`, 'success', { detail: validChange });
  markWorkItem('plex-language-evaluate', `T574-skip-${randomUUID()}`, 'success', { detail: skipRow });

  const result = await plexLanguageEvaluateContract().check();
  assert.equal(result.ok, true);
});

test('plexLanguageEvaluateContract fails and names the offending itemKey when a "change" row is missing a numeric proposedAudio.streamId', async () => {
  const badKey = `T574-bad-streamid-${randomUUID()}`;
  const malformed: EvaluateDetail = {
    name: 'Malformed Movie (no streamId)',
    status: 'change',
    currentAudio: { streamId: 1, label: 'English', isExplicit: true },
    currentSubtitle: { streamId: null, label: 'None', isExplicit: false },
    // proposedAudio deliberately omitted — mirrors apply.ts's runtime skip condition.
  };
  markWorkItem('plex-language-evaluate', badKey, 'success', { detail: malformed });

  const result = await plexLanguageEvaluateContract().check();
  assert.equal(result.ok, false);
  assert.ok(result.violations?.some((v: string) => v.includes(badKey)));
  assert.ok(result.checks?.some((c) => !c.ok && c.actual?.includes(badKey)));
});

test('plexLanguageEvaluateContract fails and names the offending itemKey when a "change" row has a null currentAudio', async () => {
  const badKey = `T574-bad-currentaudio-${randomUUID()}`;
  const malformed = {
    name: 'Malformed Movie (no currentAudio)',
    status: 'change',
    currentAudio: null,
    proposedAudio: { streamId: 5, label: 'Japanese', isExplicit: false },
  } as unknown as EvaluateDetail;
  markWorkItem('plex-language-evaluate', badKey, 'success', { detail: malformed });

  const result = await plexLanguageEvaluateContract().check();
  assert.equal(result.ok, false);
  assert.ok(result.violations?.some((v: string) => v.includes(badKey)));
});

// ── T477: Plex reads pass a cacheKey and reuse the 3-hour service_cache ──
registerService({ name: 'plex', category: 'api' });

function fakePlexFetch(): { fn: <T>(path: string) => Promise<T>; callsByPath: Map<string, number> } {
  const callsByPath = new Map<string, number>();
  const fn = async <T,>(path: string): Promise<T> => {
    callsByPath.set(path, (callsByPath.get(path) ?? 0) + 1);
    return { MediaContainer: { Directory: [], Metadata: [] } } as T;
  };
  return { fn, callsByPath };
}

test('fetchSections dedups a second call sharing a cacheKey within the TTL', async () => {
  const { fn, callsByPath } = fakePlexFetch();
  await fetchSections(fn);
  await fetchSections(fn);
  assert.equal(callsByPath.size, 1);
  assert.equal(callsByPath.get('/library/sections'), 1, 'the underlying Plex GET was invoked only once across two calls');
});

test('fetchSectionItems dedups a second call sharing a cacheKey within the TTL', async () => {
  const { fn, callsByPath } = fakePlexFetch();
  await fetchSectionItems('5', 'show', fn);
  await fetchSectionItems('5', 'show', fn);
  assert.equal(callsByPath.size, 1);
  for (const count of callsByPath.values()) {
    assert.equal(count, 1, 'the underlying Plex GET was invoked only once across two calls');
  }
});

test('fetchItemDetail dedups a second call sharing a cacheKey within the TTL', async () => {
  const { fn, callsByPath } = fakePlexFetch();
  await fetchItemDetail('rk-1', fn);
  await fetchItemDetail('rk-1', fn);
  assert.equal(callsByPath.size, 1);
  for (const count of callsByPath.values()) {
    assert.equal(count, 1, 'the underlying Plex GET was invoked only once across two calls');
  }
});

test('fetchAllLeaves dedups a second call sharing a cacheKey within the TTL', async () => {
  const { fn, callsByPath } = fakePlexFetch();
  await fetchAllLeaves('show-1', fn);
  await fetchAllLeaves('show-1', fn);
  assert.equal(callsByPath.size, 1);
  for (const count of callsByPath.values()) {
    assert.equal(count, 1, 'the underlying Plex GET was invoked only once across two calls');
  }
});
