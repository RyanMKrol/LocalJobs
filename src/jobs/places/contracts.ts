// Typed-artifact contracts for the places workflow stage boundaries.
//
// Each factory returns an ArtifactContract whose `check()` inspects the REAL
// artifact left on disk and reports SHAPE + NON-EMPTY drift — enough to catch a
// Takeout/Places/Resolver format change or an empty hand-off without brittle
// full-schema validation. The factories take an optional path so they can be
// unit-tested against synthetic fixtures (the jobs use the default data paths).
//
// Each contract ALSO declares a machine-readable `shape` (plain-English
// expectations for a non-expert reader) and its `check()` reports per-expectation
// pass/fail in `checks` plus a small `sample` of what actually flowed, so the
// dashboard gate page can show expected-vs-actual without anyone reading code.
//
// Keys are shared across the producing job's `produces` and the consuming job's
// `consumes` so the workflow executor derives a gate at each edge:
//   ingest ──places-normalized──▶ resolve ──resolved-place-ids──▶ enrich
//          ──enriched-places──▶ enrich-with-llm
import { existsSync, readFileSync } from 'node:fs';
import type { ArtifactContract, ExpectationResult, GateResult } from '../../core/types.js';
import { placesConfig } from './config.js';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function readJson(file: string): { obj?: unknown; violation?: string } {
  if (!existsSync(file)) return { violation: `file missing: ${file}` };
  try {
    return { obj: JSON.parse(readFileSync(file, 'utf8')) };
  } catch (e) {
    return { violation: `not valid JSON — ${errMsg(e)}` };
  }
}

/**
 * Build a GateResult from per-expectation results: `ok` iff every expectation
 * passed, with `violations` derived from the failures so the executor's gate
 * enforcement (which reads `ok`/`violations`) is unchanged.
 */
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

const NORMALIZED_EXP = {
  json: 'A readable JSON file',
  source: 'Sourced from Google Takeout',
  nonEmpty: 'Contains at least one place',
  names: 'Every place has a name',
};

/**
 * ingest → resolve boundary: the normalized places.json. Must parse, declare
 * `source: "google-takeout"`, and carry a non-empty `places[]` whose records
 * have a `name` (a Takeout CSV layout change that breaks normalization fails
 * here instead of feeding empty/garbage downstream).
 */
export function normalizedPlacesContract(file: string = placesConfig.placesOut): ArtifactContract {
  return {
    key: 'places-normalized',
    description: 'ingest output: places.json — source google-takeout, non-empty places[] with names.',
    shape: {
      summary: 'The normalized list of your places to look up, read from Google Takeout.',
      format: 'JSON file (places.json)',
      expectations: [
        { label: NORMALIZED_EXP.json, detail: 'The hand-off file exists and parses as JSON.' },
        { label: NORMALIZED_EXP.source, detail: 'Marked source = "google-takeout", proving it came from the right export.' },
        { label: NORMALIZED_EXP.nonEmpty, detail: 'A non-empty "places" list — otherwise there is nothing to resolve.' },
        { label: NORMALIZED_EXP.names, detail: 'Each place record carries a text name.' },
      ],
    },
    check(): GateResult {
      const checks: ExpectationResult[] = [];
      const { obj, violation } = readJson(file);
      if (violation) {
        checks.push({ label: NORMALIZED_EXP.json, ok: false, actual: violation });
        return fromChecks(checks);
      }
      checks.push({ label: NORMALIZED_EXP.json, ok: true, actual: 'valid JSON' });
      const rec = (obj ?? {}) as Record<string, unknown>;
      checks.push({
        label: NORMALIZED_EXP.source,
        ok: rec.source === 'google-takeout',
        actual: `source = ${JSON.stringify(rec.source)}`,
      });
      const places = rec.places;
      const isArr = Array.isArray(places);
      const nonEmpty = isArr && (places as unknown[]).length > 0;
      checks.push({
        label: NORMALIZED_EXP.nonEmpty,
        ok: nonEmpty,
        actual: isArr ? `${(places as unknown[]).length} place(s)` : 'no "places" array',
      });
      let sample: string | undefined;
      if (nonEmpty) {
        const arr = places as Record<string, unknown>[];
        const bad = arr.find((p) => !p || typeof p.name !== 'string');
        checks.push({
          label: NORMALIZED_EXP.names,
          ok: !bad,
          actual: bad ? 'a place is missing a text name' : 'all places named',
        });
        const names = arr.slice(0, 3).map((p) => JSON.stringify(p?.name)).join(', ');
        sample = `${arr.length} place(s)${names ? ` · e.g. ${names}` : ''}`;
      }
      return fromChecks(checks, sample);
    },
  };
}

const RESOLVED_EXP = {
  json: 'A readable JSON file',
  map: 'Has a "resolved" lookup map',
  nonEmpty: 'The map is not empty',
  placeId: 'At least one place resolved to a place_id',
};

/**
 * resolve → enrich boundary: resolved.json. Must parse, carry a non-empty
 * `resolved` map, and have at least one entry that actually resolved to a
 * `placeId` (the Places API needs a place_id; a run that resolved nothing has
 * nothing to enrich).
 */
export function resolvedPlacesContract(file: string = placesConfig.resolvedOut): ArtifactContract {
  return {
    key: 'resolved-place-ids',
    description: 'resolve output: resolved.json — non-empty map, at least one entry with a place_id.',
    shape: {
      summary: 'The result of looking up each place\'s Google place_id by its CID.',
      format: 'JSON file (resolved.json)',
      expectations: [
        { label: RESOLVED_EXP.json, detail: 'The hand-off file exists and parses as JSON.' },
        { label: RESOLVED_EXP.map, detail: 'A "resolved" object keyed by CID.' },
        { label: RESOLVED_EXP.nonEmpty, detail: 'At least one entry — otherwise nothing resolved.' },
        { label: RESOLVED_EXP.placeId, detail: 'At least one entry has a real place_id, which the enrich stage needs.' },
      ],
    },
    check(): GateResult {
      const checks: ExpectationResult[] = [];
      const { obj, violation } = readJson(file);
      if (violation) {
        checks.push({ label: RESOLVED_EXP.json, ok: false, actual: violation });
        return fromChecks(checks);
      }
      checks.push({ label: RESOLVED_EXP.json, ok: true, actual: 'valid JSON' });
      const resolved = (obj as Record<string, unknown>)?.resolved;
      const isMap = !!resolved && typeof resolved === 'object' && !Array.isArray(resolved);
      checks.push({ label: RESOLVED_EXP.map, ok: isMap, actual: isMap ? 'present' : 'missing "resolved" map' });
      if (!isMap) return fromChecks(checks);
      const entries = Object.values(resolved as Record<string, unknown>);
      checks.push({ label: RESOLVED_EXP.nonEmpty, ok: entries.length > 0, actual: `${entries.length} entry(ies)` });
      const withPlaceId = entries.filter(
        (e) => e && typeof (e as Record<string, unknown>).placeId === 'string' && (e as Record<string, unknown>).placeId,
      );
      checks.push({
        label: RESOLVED_EXP.placeId,
        ok: withPlaceId.length > 0,
        actual: `${withPlaceId.length}/${entries.length} with a place_id`,
      });
      return fromChecks(checks, `${withPlaceId.length}/${entries.length} entry(ies) resolved to a place_id`);
    },
  };
}

const ENRICHED_EXP = {
  json: 'A readable JSON file',
  map: 'Has an "enriched" lookup map',
  nonEmpty: 'The map is not empty',
  placeId: 'At least one enriched place has a place_id',
};

/**
 * enrich → enrich-with-llm boundary: enriched.json. Must parse, carry a
 * non-empty `enriched` map, and have at least one entry with a `placeId` (the
 * LLM stage keys its research by place_id).
 */
export function enrichedPlacesContract(file: string = placesConfig.enrichedOut): ArtifactContract {
  return {
    key: 'enriched-places',
    description: 'enrich output: enriched.json — non-empty map, at least one entry with a place_id.',
    shape: {
      summary: 'Places enriched with Google Places API details, ready for LLM summaries.',
      format: 'JSON file (enriched.json)',
      expectations: [
        { label: ENRICHED_EXP.json, detail: 'The hand-off file exists and parses as JSON.' },
        { label: ENRICHED_EXP.map, detail: 'An "enriched" object keyed by CID.' },
        { label: ENRICHED_EXP.nonEmpty, detail: 'At least one entry — otherwise nothing was enriched.' },
        { label: ENRICHED_EXP.placeId, detail: 'At least one entry has a place_id, which the LLM stage keys research by.' },
      ],
    },
    check(): GateResult {
      const checks: ExpectationResult[] = [];
      const { obj, violation } = readJson(file);
      if (violation) {
        checks.push({ label: ENRICHED_EXP.json, ok: false, actual: violation });
        return fromChecks(checks);
      }
      checks.push({ label: ENRICHED_EXP.json, ok: true, actual: 'valid JSON' });
      const enriched = (obj as Record<string, unknown>)?.enriched;
      const isMap = !!enriched && typeof enriched === 'object' && !Array.isArray(enriched);
      checks.push({ label: ENRICHED_EXP.map, ok: isMap, actual: isMap ? 'present' : 'missing "enriched" map' });
      if (!isMap) return fromChecks(checks);
      const entries = Object.values(enriched as Record<string, unknown>);
      checks.push({ label: ENRICHED_EXP.nonEmpty, ok: entries.length > 0, actual: `${entries.length} entry(ies)` });
      const withPlaceId = entries.filter(
        (e) => e && typeof (e as Record<string, unknown>).placeId === 'string' && (e as Record<string, unknown>).placeId,
      );
      checks.push({
        label: ENRICHED_EXP.placeId,
        ok: withPlaceId.length > 0,
        actual: `${withPlaceId.length}/${entries.length} with a place_id`,
      });
      return fromChecks(checks, `${withPlaceId.length}/${entries.length} enriched place(s)`);
    },
  };
}
