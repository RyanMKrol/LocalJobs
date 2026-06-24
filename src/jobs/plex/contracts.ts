// Typed-artifact contracts for the Plex new-seasons audit stage boundaries.
//
//   plex-tv-snapshot ──plex-snapshot──▶ tmdb-season-check ──tmdb-missing-seasons──▶ plex-seasons-notify
//
// Each factory returns an ArtifactContract whose `check()` inspects the REAL JSON
// artifact left on disk and reports SHAPE + NON-EMPTY drift — enough to catch a
// Plex/TMDB response-shape change or an empty hand-off without brittle full-schema
// validation. They take an optional path so unit tests can point at fixtures.
import { existsSync, readFileSync } from 'node:fs';
import type { ArtifactContract, ExpectationResult, GateResult } from '../../core/types.js';
import { plexConfig } from './config.js';
import type { MissingSeasonsFile, SnapshotFile } from './types.js';

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

/** snapshot → season-check boundary: the Plex library snapshot. */
export function plexSnapshotContract(file: string = plexConfig.snapshotOut): ArtifactContract {
  return {
    key: 'plex-snapshot',
    description: 'snapshot output: { shows: [{ title, tmdbId, ratingKey, highestOwnedSeason }] } — readable, with GUID-matched shows.',
    shape: {
      summary: 'The fresh Plex TV snapshot: each show with its TMDB id and highest owned season.',
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
      let parsed: SnapshotFile;
      try {
        parsed = JSON.parse(readFileSync(file, 'utf8')) as SnapshotFile;
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

const MISS_EXP = {
  json: 'A readable missing-seasons JSON object',
  shows: 'Contains the actionable shows array',
  seasons: 'Each actionable show lists ≥1 complete missing season',
};

/** season-check → notify boundary: the actionable missing-seasons list. */
export function missingSeasonsContract(file: string = plexConfig.missingOut): ArtifactContract {
  return {
    key: 'tmdb-missing-seasons',
    description: 'season-check output: { shows: [{ tmdbId, completeMissingSeasons[] }], unverifiable[] } — readable, each actionable show has complete seasons.',
    shape: {
      summary: 'The TMDB completeness check: shows with complete season(s) the owner is missing.',
      format: 'JSON object { generatedAt, shows[], unverifiable[] }',
      expectations: [
        { label: MISS_EXP.json, detail: 'The hand-off file exists and parses as a JSON object.' },
        { label: MISS_EXP.shows, detail: 'It has a `shows` array (may be empty when nothing is missing).' },
        { label: MISS_EXP.seasons, detail: 'Every listed show carries a non-empty completeMissingSeasons array.' },
      ],
    },
    check(): GateResult {
      const checks: ExpectationResult[] = [];
      if (!existsSync(file)) {
        checks.push({ label: MISS_EXP.json, ok: false, actual: `missing-seasons file missing: ${file}` });
        return fromChecks(checks);
      }
      let parsed: MissingSeasonsFile;
      try {
        parsed = JSON.parse(readFileSync(file, 'utf8')) as MissingSeasonsFile;
      } catch (e) {
        checks.push({ label: MISS_EXP.json, ok: false, actual: `not valid JSON — ${errMsg(e)}` });
        return fromChecks(checks);
      }
      checks.push({ label: MISS_EXP.json, ok: true, actual: 'valid JSON object' });
      const shows = Array.isArray(parsed.shows) ? parsed.shows : null;
      checks.push({ label: MISS_EXP.shows, ok: !!shows, actual: shows ? `${shows.length} actionable show(s)` : 'no shows array' });
      if (!shows) return fromChecks(checks);
      const bad = shows.find((s) => !Array.isArray(s.completeMissingSeasons) || s.completeMissingSeasons.length === 0);
      checks.push({
        label: MISS_EXP.seasons,
        ok: !bad,
        actual: bad ? `show "${bad.title}" has no complete missing seasons` : 'all have complete seasons',
      });
      return fromChecks(checks, `${shows.length} actionable show(s)`);
    },
  };
}
