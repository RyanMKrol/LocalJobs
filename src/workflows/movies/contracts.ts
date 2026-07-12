// Typed-artifact contracts for the movie recommendation layer's stage boundaries.
//
//   movie-snapshot ──movie-snapshot──▶ rec-* branches ──recs:<branch>──▶ rec-merge ──recommendations──▶ movie-recs-notify
//
// (The deterministic franchise-gap audit's contracts moved to the separate
// `missing-movies` workflow's own contracts.ts — T468.)
//
// Each factory returns an ArtifactContract whose `check()` inspects the REAL JSON
// artifact left on disk and reports SHAPE + NON-EMPTY drift — enough to catch a
// Plex/TMDB response-shape change or an empty hand-off without brittle full-schema
// validation. They take an optional path so unit tests can point at fixtures.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ArtifactContract, ExpectationResult, GateResult } from '../../core/types.js';
import { moviesConfig } from './config.js';
import type { BranchOutputFile, MovieSnapshotFile, RecommendationsFile } from './types.js';

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

/** snapshot → franchise-gaps boundary: the Plex movie library snapshot. */
export function movieSnapshotContract(file: string = moviesConfig.snapshotOut): ArtifactContract {
  return {
    key: 'movie-snapshot',
    description: 'snapshot output: { movies: [{ title, tmdbId, ratingKey, genres, directors }] } — readable, with GUID-matched movies.',
    shape: {
      summary: 'The fresh Plex movie snapshot: each movie with its TMDB id and taste metadata.',
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

const RECS_EXP = {
  json: 'A readable recommendations JSON object',
  recs: 'Contains the recommendations array',
  fields: 'Each recommendation carries a numeric tmdbId and a title',
};

/**
 * rec-merge → notify boundary: the TMDB-verified recommendation list. The list
 * may legitimately be EMPTY (every branch may have failed / all picks already
 * owned), so the gate checks SHAPE only — never non-empty — so an empty recs run
 * still lets the notify stage fire its franchise-gap digest.
 */
export function recommendationsContract(file: string = moviesConfig.recsOut): ArtifactContract {
  return {
    key: 'recommendations',
    description: 'recommendation output: { recommendations: [{ tmdbId, title, year, reason, lens, genre }] } — readable; TMDB-verified, deduped, balanced (may be empty).',
    shape: {
      summary: 'The merge stage\'s verified/deduped/balanced film recommendations.',
      format: 'JSON object { generatedAt, pooled, recommendations[] }',
      expectations: [
        { label: RECS_EXP.json, detail: 'The hand-off file exists and parses as a JSON object.' },
        { label: RECS_EXP.recs, detail: 'It has a `recommendations` array (may be empty when nothing survived verification).' },
        { label: RECS_EXP.fields, detail: 'Every recommendation carries a numeric tmdbId and a title.' },
      ],
    },
    check(): GateResult {
      const checks: ExpectationResult[] = [];
      if (!existsSync(file)) {
        checks.push({ label: RECS_EXP.json, ok: false, actual: `recommendations file missing: ${file}` });
        return fromChecks(checks);
      }
      let parsed: RecommendationsFile;
      try {
        parsed = JSON.parse(readFileSync(file, 'utf8')) as RecommendationsFile;
      } catch (e) {
        checks.push({ label: RECS_EXP.json, ok: false, actual: `not valid JSON — ${errMsg(e)}` });
        return fromChecks(checks);
      }
      checks.push({ label: RECS_EXP.json, ok: true, actual: 'valid JSON object' });
      const recs = Array.isArray(parsed.recommendations) ? parsed.recommendations : null;
      checks.push({ label: RECS_EXP.recs, ok: !!recs, actual: recs ? `${recs.length} recommendation(s)` : 'no recommendations array' });
      if (!recs) return fromChecks(checks);
      const bad = recs.find((r) => typeof r.tmdbId !== 'number' || !r.title);
      checks.push({
        label: RECS_EXP.fields,
        ok: !bad,
        actual: bad ? 'a recommendation is missing tmdbId/title' : 'all recommendations well-formed',
      });
      return fromChecks(checks, `${recs.length} recommendation(s)`);
    },
  };
}

const BRANCH_EXP = {
  json: 'A readable branch-output JSON object',
  suggestions: 'Contains the suggestions array',
};

/**
 * snapshot/branch → rec-merge boundary, ONE per recommender branch (keyed `recs:<branchId>`).
 * Each branch writes data/out/recs/<branchId>.json before rec-merge pools them. SHAPE-only and
 * empty-tolerant: a branch that fails gracefully (Claude error, junk reply, no targets) still
 * writes an EMPTY suggestions file with an `error` field — that's a valid hand-off, NOT a gate
 * violation — so a single flaky branch never blocks the merge. Only a missing/garbage file (a hard
 * crash that wrote nothing, or a shape drift) trips it.
 */
export function branchSuggestionsContract(
  branchId: string,
  file: string = join(moviesConfig.recsDir, `${branchId}.json`),
): ArtifactContract {
  return {
    key: `recs:${branchId}`,
    description: `${branchId} branch output: { branchId, lens, suggestions: [{ title, year?, reason? }] } — readable; the suggestions list may legitimately be empty (a gracefully-failed branch still writes the file).`,
    shape: {
      summary: `Raw film suggestions from the ${branchId} recommender branch (pooled + TMDB-verified by rec-merge).`,
      format: 'JSON object { branchId, lens, generatedAt, suggestions[], error? }',
      expectations: [
        { label: BRANCH_EXP.json, detail: 'The branch wrote its hand-off file and it parses as a JSON object.' },
        { label: BRANCH_EXP.suggestions, detail: 'It has a `suggestions` array (may be empty — a gracefully-failed branch still writes one).' },
      ],
    },
    check(): GateResult {
      const checks: ExpectationResult[] = [];
      if (!existsSync(file)) {
        checks.push({ label: BRANCH_EXP.json, ok: false, actual: `branch output missing: ${file}` });
        return fromChecks(checks);
      }
      let parsed: BranchOutputFile;
      try {
        parsed = JSON.parse(readFileSync(file, 'utf8')) as BranchOutputFile;
      } catch (e) {
        checks.push({ label: BRANCH_EXP.json, ok: false, actual: `not valid JSON — ${errMsg(e)}` });
        return fromChecks(checks);
      }
      checks.push({ label: BRANCH_EXP.json, ok: true, actual: 'valid JSON object' });
      const sugg = Array.isArray(parsed.suggestions) ? parsed.suggestions : null;
      checks.push({
        label: BRANCH_EXP.suggestions,
        ok: !!sugg,
        actual: sugg ? `${sugg.length} suggestion(s)${parsed.error ? ` [${parsed.error}]` : ''}` : 'no suggestions array',
      });
      return fromChecks(checks, sugg ? `${sugg.length} suggestion(s)${parsed.error ? ` [${parsed.error}]` : ''}` : undefined);
    },
  };
}
