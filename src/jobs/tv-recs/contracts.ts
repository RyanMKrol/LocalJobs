// Typed-artifact contracts for the TV recommendations workflow stage boundaries.
//
//   tv-snapshot ──tv-snapshot──▶ (8 branch jobs) ──tv-recs:<branchId>──▶ tv-rec-merge
//               ──tv-recs-recommendations──▶ tv-recs-notify
//
// Each factory returns an ArtifactContract whose `check()` inspects the REAL JSON
// artifact left on disk and reports SHAPE + NON-EMPTY drift — enough to catch a
// Plex/TMDB/branch response-shape change or an empty hand-off without brittle
// full-schema validation. They take an optional path so unit tests can point at
// fixtures.
//
// Branch contracts are EMPTY-TOLERANT: a gracefully-failed branch still writes
// { branchId, suggestions: [] } so `ok=true` for a missing array but a file that
// is missing entirely (branch crashed before writing) is a real gate failure.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ArtifactContract, ExpectationResult, GateResult } from '../../core/types.js';
import { tvRecsConfig } from './config.js';
import type { BranchOutputFile, RecommendationsFile, TvSnapshotFile } from './types.js';

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
  shows: 'Contains the shows array',
  tmdb: 'At least one show carries a tmdbId',
};

/** tv-snapshot → branch boundary: the Plex TV library snapshot. */
export function tvSnapshotContract(file: string = tvRecsConfig.snapshotOut): ArtifactContract {
  return {
    key: 'tv-snapshot',
    description: 'tv-snapshot output: { shows: [{ title, tmdbId, ratingKey, genres, roles }] } — readable, with GUID-matched shows.',
    shape: {
      summary: 'The fresh Plex TV snapshot: each show with its TMDB id and taste metadata.',
      format: 'JSON object { generatedAt, section, shows[] }',
      expectations: [
        { label: SNAP_EXP.json, detail: 'The hand-off file exists and parses as a JSON object.' },
        { label: SNAP_EXP.shows, detail: 'It has a `shows` array (the library may legitimately be empty).' },
        { label: SNAP_EXP.tmdb, detail: 'At least one show matched a tmdb:// GUID — a Plex shape change that drops GUIDs is caught here.' },
      ],
    },
    check(): GateResult {
      const checks: ExpectationResult[] = [];
      if (!existsSync(file)) {
        checks.push({ label: SNAP_EXP.json, ok: false, actual: `snapshot missing: ${file}` });
        return fromChecks(checks);
      }
      let parsed: TvSnapshotFile;
      try {
        parsed = JSON.parse(readFileSync(file, 'utf8')) as TvSnapshotFile;
      } catch (e) {
        checks.push({ label: SNAP_EXP.json, ok: false, actual: `not valid JSON — ${errMsg(e)}` });
        return fromChecks(checks);
      }
      checks.push({ label: SNAP_EXP.json, ok: true, actual: 'valid JSON object' });
      const shows = Array.isArray(parsed.shows) ? parsed.shows : null;
      checks.push({ label: SNAP_EXP.shows, ok: !!shows, actual: shows ? `${shows.length} show(s)` : 'no shows array' });
      if (!shows) return fromChecks(checks);
      const withTmdb = shows.filter((s) => typeof s.tmdbId === 'number').length;
      checks.push({
        label: SNAP_EXP.tmdb,
        // An empty library is acceptable; only a NON-empty snapshot with ZERO
        // tmdbIds signals a GUID-extraction drift.
        ok: shows.length === 0 || withTmdb > 0,
        actual: `${withTmdb}/${shows.length} with tmdbId`,
      });
      return fromChecks(checks, `${shows.length} show(s) · ${withTmdb} with tmdbId`);
    },
  };
}

const BRANCH_EXP = {
  json: 'A readable branch JSON object',
  suggestions: 'Contains the suggestions array',
};

/**
 * branch → tv-rec-merge boundary: one branch's raw suggestions file.
 * EMPTY-TOLERANT: `suggestions: []` is valid (a gracefully-failed branch still
 * writes the file with an error field and an empty list so the merge can continue).
 * A missing file (crash before write) is a true gate failure.
 */
export function tvBranchSuggestionsContract(
  branchId: string,
  file: string = join(tvRecsConfig.recsDir, `${branchId}.json`),
): ArtifactContract {
  return {
    key: `tv-recs:${branchId}`,
    description: `${branchId} branch output: { branchId, lens, suggestions: [{ title, year?, reason? }] } — readable; the suggestions list may legitimately be empty (a gracefully-failed branch still writes the file).`,
    shape: {
      summary: `Raw TV show suggestions from the ${branchId} recommender branch (pooled + TMDB-verified by tv-rec-merge).`,
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

const RECS_EXP = {
  json: 'A readable recommendations JSON object',
  recs: 'Contains the recommendations array',
};

/**
 * tv-rec-merge → tv-recs-notify boundary: the TMDB-verified, deduped, balanced
 * recommendation list. EMPTY-TOLERANT: the recommendations array may be empty
 * (e.g. all suggestions failed the quality bar) — an empty list is not a
 * format failure, just nothing to notify about.
 */
export function tvRecommendationsContract(file: string = tvRecsConfig.recsOut): ArtifactContract {
  return {
    key: 'tv-recs-recommendations',
    description: 'tv-rec-merge output: { recommendations: [{ tmdbId, title, year, reason, genre }] } — readable; may be empty when nothing passed the quality bar.',
    shape: {
      summary: 'The TMDB-verified, deduped, balanced TV recommendation list.',
      format: 'JSON object { generatedAt, pooled, recommendations[] }',
      expectations: [
        { label: RECS_EXP.json, detail: 'The hand-off file exists and parses as a JSON object.' },
        { label: RECS_EXP.recs, detail: 'It has a `recommendations` array (may be empty when nothing passed the quality bar).' },
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
      checks.push({
        label: RECS_EXP.recs,
        ok: !!recs,
        actual: recs ? `${recs.length} recommendation(s)` : 'no recommendations array',
      });
      return fromChecks(checks, recs ? `${recs.length} recommendation(s) (pooled ${parsed.pooled ?? '?'})` : undefined);
    },
  };
}
