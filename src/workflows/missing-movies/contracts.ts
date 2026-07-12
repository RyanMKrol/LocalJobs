// Typed-artifact contracts for the missing-movies franchise-gap audit stage boundaries.
//
//   plex-movie-snapshot ──movie-snapshot──▶ franchise-gaps ──franchise-gaps──▶ movie-gaps-notify
//
// Each factory returns an ArtifactContract whose `check()` inspects the REAL JSON
// artifact left on disk and reports SHAPE + NON-EMPTY drift — enough to catch a
// Plex/TMDB response-shape change or an empty hand-off without brittle full-schema
// validation. They take an optional path so unit tests can point at fixtures.
// Types are shared with `movie-recommendations` (its `types.ts`) rather than
// duplicated — both workflows' snapshot/gaps artifacts have the identical shape.
import { existsSync, readFileSync } from 'node:fs';
import type { ArtifactContract, ExpectationResult, GateResult } from '../../core/types.js';
import type { FranchiseGapsFile, MovieSnapshotFile } from '../movies/types.js';
import { missingMoviesConfig } from './config.js';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function fromChecks(checks: ExpectationResult[], sample?: string): GateResult {
  const failed = checks.filter((c) => !c.ok);
  const ok = failed.length === 0;
  return {
    ok,
    violations: ok ? undefined : failed.map((c) => `${c.label}: ${c.actual ?? 'failed'}`),
    checks,
    sample,
    detail: sample,
  };
}

const SNAP_EXP = {
  json: 'A readable snapshot JSON object',
  movies: 'Contains the movies array',
  tmdb: 'At least one movie carries a tmdbId',
};

/** plex-movie-snapshot → franchise-gaps boundary: the Plex movie library snapshot. */
export function missingMoviesSnapshotContract(file: string = missingMoviesConfig.snapshotOut): ArtifactContract {
  return {
    key: 'movie-snapshot',
    description: 'snapshot output: { movies: [{ title, tmdbId, ratingKey, genres, directors }] } — readable, with GUID-matched movies.',
    shape: {
      summary: 'The fresh Plex movie snapshot: each movie with its TMDB id.',
      format: 'JSON object { generatedAt, section, movies[] }',
      expectations: [
        { label: SNAP_EXP.json, detail: 'The hand-off file exists and parses as a JSON object.' },
        { label: SNAP_EXP.movies, detail: 'It has a `movies` array (the library may legitimately be empty).' },
        { label: SNAP_EXP.tmdb, detail: 'At least one movie matched a tmdb:// GUID — a Plex shape change that drops GUIDs is caught here.' },
      ],
    },
    check(): GateResult {
      const checks: ExpectationResult[] = [];
      if (!existsSync(file)) {
        checks.push({ label: SNAP_EXP.json, ok: false, actual: `snapshot missing: ${file}` });
        return fromChecks(checks);
      }
      let parsed: MovieSnapshotFile;
      try {
        parsed = JSON.parse(readFileSync(file, 'utf8')) as MovieSnapshotFile;
      } catch (e) {
        checks.push({ label: SNAP_EXP.json, ok: false, actual: `not valid JSON — ${errMsg(e)}` });
        return fromChecks(checks);
      }
      checks.push({ label: SNAP_EXP.json, ok: true, actual: 'valid JSON object' });
      const movies = Array.isArray(parsed.movies) ? parsed.movies : null;
      checks.push({ label: SNAP_EXP.movies, ok: !!movies, actual: movies ? `${movies.length} movie(s)` : 'no movies array' });
      if (!movies) return fromChecks(checks);
      const withTmdb = movies.filter((m) => typeof m.tmdbId === 'number').length;
      checks.push({
        label: SNAP_EXP.tmdb,
        // An empty library is acceptable; only a NON-empty snapshot with ZERO
        // tmdbIds signals a GUID-extraction drift.
        ok: movies.length === 0 || withTmdb > 0,
        actual: `${withTmdb}/${movies.length} with tmdbId`,
      });
      return fromChecks(checks, `${movies.length} movie(s) · ${withTmdb} with tmdbId`);
    },
  };
}

const GAPS_EXP = {
  json: 'A readable franchise-gaps JSON object',
  gaps: 'Contains the gaps array',
  fields: 'Each gap carries a collection name and tmdbId',
};

/** franchise-gaps → movie-gaps-notify boundary: the detected franchise gaps. */
export function franchiseGapsContract(file: string = missingMoviesConfig.gapsOut): ArtifactContract {
  return {
    key: 'franchise-gaps',
    description: 'gap output: { gaps: [{ collectionName, tmdbId, title, year, tmdbRating }] } — readable; every released-not-owned franchise film.',
    shape: {
      summary: 'The deterministic franchise-gap detection: released franchise films the owner does not own.',
      format: 'JSON object { generatedAt, collectionsChecked, gaps[] }',
      expectations: [
        { label: GAPS_EXP.json, detail: 'The hand-off file exists and parses as a JSON object.' },
        { label: GAPS_EXP.gaps, detail: 'It has a `gaps` array (may be empty when nothing is missing).' },
        { label: GAPS_EXP.fields, detail: 'Every gap carries a collectionName and a numeric tmdbId.' },
      ],
    },
    check(): GateResult {
      const checks: ExpectationResult[] = [];
      if (!existsSync(file)) {
        checks.push({ label: GAPS_EXP.json, ok: false, actual: `franchise-gaps file missing: ${file}` });
        return fromChecks(checks);
      }
      let parsed: FranchiseGapsFile;
      try {
        parsed = JSON.parse(readFileSync(file, 'utf8')) as FranchiseGapsFile;
      } catch (e) {
        checks.push({ label: GAPS_EXP.json, ok: false, actual: `not valid JSON — ${errMsg(e)}` });
        return fromChecks(checks);
      }
      checks.push({ label: GAPS_EXP.json, ok: true, actual: 'valid JSON object' });
      const gaps = Array.isArray(parsed.gaps) ? parsed.gaps : null;
      checks.push({ label: GAPS_EXP.gaps, ok: !!gaps, actual: gaps ? `${gaps.length} gap(s)` : 'no gaps array' });
      if (!gaps) return fromChecks(checks);
      const bad = gaps.find((g) => !g.collectionName || typeof g.tmdbId !== 'number');
      checks.push({
        label: GAPS_EXP.fields,
        ok: !bad,
        actual: bad ? `a gap is missing collectionName/tmdbId` : 'all gaps well-formed',
      });
      return fromChecks(checks, `${gaps.length} gap(s)`);
    },
  };
}
