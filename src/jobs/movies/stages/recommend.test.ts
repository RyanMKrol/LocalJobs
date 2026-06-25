// Branch-runner tests — hermetic: NO live Claude (an injected runClaude),
// synthetic snapshot + taste profile, temp recs dir. Covers: a valid reply parses
// into suggestions; a junk/no-JSON reply is handled WITHOUT failing the run (empty
// file + error); a Claude error is handled the same; a branch with nothing to
// target (auteur with no qualifying directors) skips gracefully.
// T183: also covers per-branch lens-targeted owned subsets + alreadySuggested context.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JobContext } from '../../../core/types.js';
import type { ClaudeResult } from '../../../services/claude.js';
import {
  ANGLOPHONE_COUNTRIES,
  BRANCHES,
  branchById,
  ownedByDirectors,
  ownedInGenres,
  ownedNonAnglophone,
  ownedPreYear,
} from './branches.js';
import type { BranchContext } from './branches.js';
import { allHistoryTitles, parseSuggestions, runBranch } from './recommend.js';
import type { BranchOutputFile, MovieSnapshotFile, RecsHistoryFile, TasteProfileFile } from '../types.js';

function fakeCtx(): JobContext {
  return { log() {}, progress() {}, selectedRoots: () => null, rootAllowed: () => true };
}
const NOW = new Date('2026-06-24T00:00:00Z');
const ok = (text: string): (() => Promise<ClaudeResult>) => async () => ({ ok: true, text, rateLimited: false });

// ── parseSuggestions: valid object → suggestions; junk → throws ──
{
  const parsed = parseSuggestions('{"recommendations":[{"title":"Akira","year":1988,"reason":"anime landmark"},{"title":"Blank"}]}', 'world-cinema');
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].title, 'Akira');
  assert.equal(parsed[0].year, 1988);
  assert.equal(parsed[0].lens, 'world-cinema');
  assert.equal(parsed[1].year, null, 'a missing year → null');
  assert.throws(() => parseSuggestions('I cannot help with that.', 'x'), 'no JSON → throws');
  console.log('  ✓ parseSuggestions parses a valid object and rejects junk');
}

// Shared fixtures: a snapshot + taste profile on disk.
const dir = mkdtempSync(join(tmpdir(), 'movies-branch-'));
const snapshotFile = join(dir, 'snapshot.json');
const tasteFile = join(dir, 'taste.json');
const historyFile = join(dir, 'history.json');
const recsDir = dir;

const snap: MovieSnapshotFile = {
  generatedAt: NOW.toISOString(), section: '4',
  movies: [
    { title: 'The Matrix', year: 1999, tmdbId: 603, ratingKey: '1', genres: ['Action', 'Sci-Fi'], directors: ['Lana Wachowski'], countries: ['United States'], audienceRating: 8, rating: 8 },
    { title: 'Heat', year: 1995, tmdbId: 949, ratingKey: '2', genres: ['Crime'], directors: ['Michael Mann'], countries: ['United States'], audienceRating: 8, rating: 8 },
  ],
};
writeFileSync(snapshotFile, JSON.stringify(snap));

const tasteWithAuteur: TasteProfileFile = {
  generatedAt: NOW.toISOString(),
  profile: {
    totalMovies: 2, withTmdbId: 2,
    genres: { Action: 1, 'Sci-Fi': 1, Crime: 1 },
    directors: { 'Christopher Nolan': 4 }, // qualifies auteur (≥3)
    decades: { '1990s': 2 }, countries: { 'United States': 2 },
  },
};
writeFileSync(tasteFile, JSON.stringify(tasteWithAuteur));

const readBranch = (id: string): BranchOutputFile =>
  JSON.parse(readFileSync(join(recsDir, `${id}.json`), 'utf8')) as BranchOutputFile;

// ── valid reply → suggestions written ──
{
  const spec = branchById('rec-random-1');
  await runBranch(fakeCtx(), spec, {
    runClaude: ok('{"recommendations":[{"title":"Stalker","year":1979,"reason":"a meditative sci-fi"}]}'),
    snapshotFile, tasteFile, historyFile, recsDir, now: NOW,
  });
  const file = readBranch('rec-random-1');
  assert.equal(file.suggestions.length, 1);
  assert.equal(file.suggestions[0].title, 'Stalker');
  assert.equal(file.suggestions[0].lens, 'serendipity');
  assert.ok(!file.error);
  console.log('  ✓ runBranch writes parsed suggestions on a valid reply');
}

// ── junk reply → empty + error, NO throw ──
{
  const spec = branchById('rec-random-2');
  await assert.doesNotReject(runBranch(fakeCtx(), spec, {
    runClaude: ok('Sorry, I really cannot produce that JSON.'),
    snapshotFile, tasteFile, historyFile, recsDir, now: NOW,
  }));
  const file = readBranch('rec-random-2');
  assert.equal(file.suggestions.length, 0, 'junk → no suggestions');
  assert.match(file.error ?? '', /unparseable/);
  console.log('  ✓ runBranch handles junk/no-JSON output without failing the run');
}

// ── Claude error (ok:false) → empty + error, NO throw ──
{
  const spec = branchById('rec-random-3');
  await assert.doesNotReject(runBranch(fakeCtx(), spec, {
    runClaude: async () => ({ ok: false, text: '', rateLimited: true, error: 'usage limit' }),
    snapshotFile, tasteFile, historyFile, recsDir, now: NOW,
  }));
  const file = readBranch('rec-random-3');
  assert.equal(file.suggestions.length, 0);
  assert.match(file.error ?? '', /rate\/usage limit/);
  console.log('  ✓ runBranch handles a Claude error/rate-limit gracefully');
}

// ── no-target branch (auteur with no qualifying directors) → skip ──
{
  const noAuteur: TasteProfileFile = {
    generatedAt: NOW.toISOString(),
    profile: { totalMovies: 2, withTmdbId: 2, genres: { Action: 2 }, directors: { Someone: 1 }, decades: { '1990s': 2 }, countries: { 'United States': 2 } },
  };
  const tf = join(dir, 'taste-no-auteur.json');
  writeFileSync(tf, JSON.stringify(noAuteur));
  let claudeCalled = false;
  const spec = branchById('rec-auteur');
  await runBranch(fakeCtx(), spec, {
    runClaude: async () => { claudeCalled = true; return { ok: true, text: '{}', rateLimited: false }; },
    snapshotFile, tasteFile: tf, historyFile, recsDir, now: NOW,
  });
  const file = readBranch('rec-auteur');
  assert.equal(file.suggestions.length, 0);
  assert.match(file.error ?? '', /no targets/);
  assert.equal(claudeCalled, false, 'a no-target branch never calls Claude');
  console.log('  ✓ runBranch skips a branch with nothing to target (no Claude call)');
}

// ── T183: alreadySuggested context is passed to branch prompts ──
{
  // Write a history file with known titles.
  const historyWithRecs: RecsHistoryFile = {
    recommended: [
      { tmdbId: 1, title: 'OldFilm', year: 2000, at: '2026-01-01T00:00:00Z' },
      { tmdbId: 2, title: 'OtherFilm', year: 2001, at: '2026-02-01T00:00:00Z' },
    ],
  };
  const hf = join(dir, 'history-with-recs.json');
  writeFileSync(hf, JSON.stringify(historyWithRecs));

  let capturedPrompt = '';
  const capturingRun = async (prompt: string): Promise<ClaudeResult> => {
    capturedPrompt = prompt;
    return { ok: true, text: '{"recommendations":[]}', rateLimited: false };
  };

  const spec = branchById('rec-random-1');
  await runBranch(fakeCtx(), spec, {
    runClaude: capturingRun,
    snapshotFile, tasteFile, historyFile: hf, recsDir, now: NOW,
  });

  assert.ok(capturedPrompt.includes('OldFilm'), 'history title OldFilm appears in prompt');
  assert.ok(capturedPrompt.includes('OtherFilm'), 'history title OtherFilm appears in prompt');
  // Must NOT contain "prefer obscure" type phrasing — only "avoid re-suggesting" specific titles
  assert.ok(!capturedPrompt.toLowerCase().includes('prefer obscure'), 'no "prefer obscure" bias wording in prompt');
  assert.ok(!capturedPrompt.toLowerCase().includes('deeper cuts'), 'no "deeper cuts" obscurity bias wording');
  console.log('  ✓ runBranch passes alreadySuggested history titles to the branch prompt');
}

// ── T183: allHistoryTitles loads all titles up to the cap ──
{
  const hf = join(dir, 'history-cap-test.json');
  const recs = Array.from({ length: 300 }, (_, i) => ({ tmdbId: i, title: `Film${i}`, year: 2000 + i, at: '2026-01-01T00:00:00Z' }));
  writeFileSync(hf, JSON.stringify({ recommended: recs }));

  const titles100 = allHistoryTitles(hf, 100);
  assert.equal(titles100.length, 100, 'cap=100 returns 100 titles');

  const titles200 = allHistoryTitles(hf, 200);
  assert.equal(titles200.length, 200, 'cap=200 returns 200 from 300');

  // Should be the LAST cap items (most recent)
  assert.ok(titles100[0].includes('Film200'), 'returns the most recent cap titles');

  const titlesNone = allHistoryTitles(join(dir, 'no-such-file.json'), 200);
  assert.equal(titlesNone.length, 0, 'missing file → empty');

  console.log('  ✓ allHistoryTitles loads titles up to cap (bounded, not full library)');
}

// ── T183: ownedByDirectors — lens-targeted owned subset helper ──
{
  const movies = [
    { title: 'Inception', year: 2010, tmdbId: 27205, ratingKey: '1', genres: ['Action'], directors: ['Christopher Nolan'], countries: ['United States'], audienceRating: 9, rating: 9 },
    { title: 'Heat', year: 1995, tmdbId: 949, ratingKey: '2', genres: ['Crime'], directors: ['Michael Mann'], countries: ['United States'], audienceRating: 8, rating: 8 },
    { title: 'Goodfellas', year: 1990, tmdbId: 769, ratingKey: '3', genres: ['Crime'], directors: ['Martin Scorsese'], countries: ['United States'], audienceRating: 9, rating: 9 },
  ];
  const byNolan = ownedByDirectors(movies, ['Christopher Nolan'], 50);
  assert.equal(byNolan.length, 1);
  assert.equal(byNolan[0].title, 'Inception');

  const byCrimeDir = ownedByDirectors(movies, ['Michael Mann', 'Martin Scorsese'], 50);
  assert.equal(byCrimeDir.length, 2);

  // Cap is respected
  const capped = ownedByDirectors(movies, ['Christopher Nolan', 'Michael Mann', 'Martin Scorsese'], 2);
  assert.equal(capped.length, 2, 'cap=2 returns at most 2');

  console.log('  ✓ ownedByDirectors returns lens-targeted owned subset (bounded at cap)');
}

// ── T183: ownedInGenres — lens-targeted genre subset ──
{
  const movies = [
    { title: 'A', year: 2000, tmdbId: 1, ratingKey: '1', genres: ['Drama'], directors: [], countries: [], audienceRating: null, rating: null },
    { title: 'B', year: 2001, tmdbId: 2, ratingKey: '2', genres: ['Comedy'], directors: [], countries: [], audienceRating: null, rating: null },
    { title: 'C', year: 2002, tmdbId: 3, ratingKey: '3', genres: ['Action'], directors: [], countries: [], audienceRating: null, rating: null },
  ];
  const dramas = ownedInGenres(movies, ['Drama'], 50);
  assert.equal(dramas.length, 1);
  assert.equal(dramas[0].title, 'A');

  const mixed = ownedInGenres(movies, ['Drama', 'Comedy'], 50);
  assert.equal(mixed.length, 2);

  // Cap
  const cappedAll = ownedInGenres(movies, ['Drama', 'Comedy', 'Action'], 2);
  assert.equal(cappedAll.length, 2);

  console.log('  ✓ ownedInGenres returns lens-targeted genre subset (bounded at cap)');
}

// ── T183: ownedPreYear — older-era owned subset ──
{
  const movies = [
    { title: 'OldFilm', year: 1955, tmdbId: 1, ratingKey: '1', genres: [], directors: [], countries: [], audienceRating: null, rating: null },
    { title: 'NearOld', year: 1979, tmdbId: 2, ratingKey: '2', genres: [], directors: [], countries: [], audienceRating: null, rating: null },
    { title: 'New', year: 1985, tmdbId: 3, ratingKey: '3', genres: [], directors: [], countries: [], audienceRating: null, rating: null },
    { title: 'NoYear', year: null, tmdbId: 4, ratingKey: '4', genres: [], directors: [], countries: [], audienceRating: null, rating: null },
  ];
  const pre1980 = ownedPreYear(movies, 1980, 50);
  assert.equal(pre1980.length, 2, 'only the two pre-1980 films');
  assert.ok(pre1980.every((m) => m.year != null && m.year < 1980));

  console.log('  ✓ ownedPreYear returns pre-era owned subset (null years excluded)');
}

// ── T183: ownedNonAnglophone — world-cinema owned subset ──
{
  const movies = [
    { title: 'UsFilm', year: 2000, tmdbId: 1, ratingKey: '1', genres: [], directors: [], countries: ['United States'], audienceRating: null, rating: null },
    { title: 'FrenchFilm', year: 2001, tmdbId: 2, ratingKey: '2', genres: [], directors: [], countries: ['France'], audienceRating: null, rating: null },
    { title: 'UkFilm', year: 2002, tmdbId: 3, ratingKey: '3', genres: [], directors: [], countries: ['United Kingdom'], audienceRating: null, rating: null },
    { title: 'ItalianFilm', year: 2003, tmdbId: 4, ratingKey: '4', genres: [], directors: [], countries: ['Italy'], audienceRating: null, rating: null },
  ];
  const nonAnglophone = ownedNonAnglophone(movies, 50);
  assert.equal(nonAnglophone.length, 2, 'France + Italy; US + UK excluded');
  assert.ok(nonAnglophone.every((m) => !m.countries.every((c) => ANGLOPHONE_COUNTRIES.has(c))));

  console.log('  ✓ ownedNonAnglophone returns non-Anglophone owned subset (bounded at cap)');
}

// ── T183: auteur branch prompt includes director-specific owned films ──
{
  const auteurMovies = [
    { title: 'Inception', year: 2010, tmdbId: 27205, ratingKey: '1', genres: ['Action'], directors: ['Christopher Nolan'], countries: ['United States'], audienceRating: 9, rating: 9 },
    { title: 'Dunkirk', year: 2017, tmdbId: 374720, ratingKey: '2', genres: ['Drama', 'War'], directors: ['Christopher Nolan'], countries: ['United States'], audienceRating: 8, rating: 8 },
    { title: 'Heat', year: 1995, tmdbId: 949, ratingKey: '3', genres: ['Crime'], directors: ['Michael Mann'], countries: ['United States'], audienceRating: 8, rating: 8 },
  ];
  const auteurProfile: TasteProfileFile = {
    generatedAt: NOW.toISOString(),
    profile: {
      totalMovies: 3, withTmdbId: 3,
      genres: { Action: 1, Drama: 1, War: 1, Crime: 1 },
      directors: { 'Christopher Nolan': 4, 'Michael Mann': 1 },
      decades: { '1990s': 1, '2010s': 2 }, countries: { 'United States': 3 },
    },
  };
  const snapWithAuteur: MovieSnapshotFile = { generatedAt: NOW.toISOString(), section: '4', movies: auteurMovies };
  const sfAuteur = join(dir, 'snapshot-auteur.json');
  const tfAuteur = join(dir, 'taste-auteur2.json');
  writeFileSync(sfAuteur, JSON.stringify(snapWithAuteur));
  writeFileSync(tfAuteur, JSON.stringify(auteurProfile));

  let capturedPrompt = '';
  await runBranch(fakeCtx(), branchById('rec-auteur'), {
    runClaude: async (p) => { capturedPrompt = p; return { ok: true, text: '{"recommendations":[]}', rateLimited: false }; },
    snapshotFile: sfAuteur, tasteFile: tfAuteur, historyFile, recsDir, now: NOW,
  });

  // Director-specific owned films must appear in the prompt
  assert.ok(capturedPrompt.includes('Inception'), 'Inception (Nolan) in auteur prompt');
  assert.ok(capturedPrompt.includes('Dunkirk'), 'Dunkirk (Nolan) in auteur prompt');
  // Non-qualifying director's film should NOT appear in lens-targeted subset
  // (Heat is by Michael Mann who owns only 1 film — doesn't qualify auteur ≥3)
  // Note: Heat could appear in the avoidBlock if in history, but not in lens-owned block
  assert.ok(capturedPrompt.includes('Christopher Nolan'), 'director name in prompt');
  // No obscurity bias ("prefer obscure" / "deeper cuts" type phrasing must not appear)
  assert.ok(!capturedPrompt.toLowerCase().includes('prefer obscure'), 'no obscurity bias wording');
  console.log('  ✓ auteur branch prompt contains director-specific owned films (lens-targeted)');
}

// ── T183: alreadySuggested + exclude merged into avoid block ──
{
  const ctx: BranchContext = {
    profile: { totalMovies: 2, withTmdbId: 2, genres: { Action: 2 }, directors: {}, decades: {}, countries: {} },
    movies: snap.movies,
    recent: ['Recent Film (2020)'],
    sampleSize: 50,
    ask: 9,
    alreadySuggested: ['History Film (2010)', 'Another History Film (2015)'],
    exclude: ['RunExclude (2022)'],
  };
  const spec = branchById('rec-random-1');
  const prompt = spec.build(ctx);
  assert.ok(prompt != null);
  assert.ok(prompt.includes('History Film (2010)'), 'alreadySuggested title in avoid block');
  assert.ok(prompt.includes('Another History Film (2015)'), 'alreadySuggested title in avoid block');
  assert.ok(prompt.includes('RunExclude (2022)'), 'exclude (top-up) title in avoid block');
  // When alreadySuggested is provided, it replaces recent (avoidBlock prefers alreadySuggested)
  // — "Recent Film" should NOT appear unless it's ALSO in alreadySuggested
  assert.ok(!prompt.includes('Recent Film (2020)'), 'recent is superseded by alreadySuggested');
  console.log('  ✓ branch prompt merges alreadySuggested + exclude into avoid block (recent superseded)');
}

// ── T183: all 8 branches accept alreadySuggested without error ──
{
  const fullProfile: TasteProfileFile = {
    generatedAt: NOW.toISOString(),
    profile: {
      totalMovies: 5, withTmdbId: 5,
      genres: { Action: 3, Drama: 2, Comedy: 1, Horror: 1 },
      directors: { 'Christopher Nolan': 4 },
      decades: { '1970s': 1, '1990s': 2, '2000s': 2 },
      countries: { 'United States': 3, 'France': 1, 'Japan': 1 },
    },
  };
  const fullMovies = [
    { title: 'A', year: 1975, tmdbId: 1, ratingKey: '1', genres: ['Action'], directors: ['Christopher Nolan'], countries: ['United States'], audienceRating: 8, rating: 8 },
    { title: 'B', year: 1995, tmdbId: 2, ratingKey: '2', genres: ['Drama'], directors: ['Christopher Nolan'], countries: ['France'], audienceRating: 8, rating: 8 },
    { title: 'C', year: 1998, tmdbId: 3, ratingKey: '3', genres: ['Comedy'], directors: ['Christopher Nolan'], countries: ['Japan'], audienceRating: 7, rating: 7 },
    { title: 'D', year: 2005, tmdbId: 4, ratingKey: '4', genres: ['Horror'], directors: ['Christopher Nolan'], countries: ['United States'], audienceRating: 7, rating: 7 },
    { title: 'E', year: 2010, tmdbId: 5, ratingKey: '5', genres: ['Action'], directors: ['Christopher Nolan'], countries: ['United States'], audienceRating: 9, rating: 9 },
  ];
  const ctx: BranchContext = {
    profile: fullProfile.profile,
    movies: fullMovies,
    recent: [],
    sampleSize: 10,
    ask: 5,
    alreadySuggested: ['SuggestedFilm1 (2005)', 'SuggestedFilm2 (2006)'],
    exclude: ['ExcludedThisRun (2007)'],
  };
  let errored = false;
  for (const spec of BRANCHES) {
    try {
      const prompt = spec.build(ctx);
      // If build returns a prompt (not null), it must include the avoid block content
      if (prompt != null) {
        assert.ok(
          prompt.includes('SuggestedFilm1') || prompt.includes('ExcludedThisRun') || prompt.includes('SuggestedFilm2'),
          `${spec.id}: avoid block content present in prompt`,
        );
      }
    } catch (err) {
      errored = true;
      console.error(`  ✗ ${spec.id} threw: ${err}`);
    }
  }
  assert.ok(!errored, 'all branches build without throwing');
  console.log('  ✓ all 8 branches accept alreadySuggested + exclude context without error');
}

console.log('  ✓ movies branch-runner tests passed');
