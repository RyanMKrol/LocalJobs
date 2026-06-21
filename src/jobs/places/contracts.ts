// Typed-artifact contracts for the places pipeline stage boundaries.
//
// Each factory returns an ArtifactContract whose `check()` inspects the REAL
// artifact left on disk and reports SHAPE + NON-EMPTY drift — enough to catch a
// Takeout/Places/Resolver format change or an empty hand-off without brittle
// full-schema validation. The factories take an optional path so they can be
// unit-tested against synthetic fixtures (the jobs use the default data paths).
//
// Keys are shared across the producing job's `produces` and the consuming job's
// `consumes` so the pipeline executor derives a gate at each edge:
//   ingest ──places-normalized──▶ resolve ──resolved-place-ids──▶ enrich
//          ──enriched-places──▶ enrich-with-llm
import { existsSync, readFileSync } from 'node:fs';
import type { ArtifactContract, GateResult } from '../../core/types.js';
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
 * ingest → resolve boundary: the normalized places.json. Must parse, declare
 * `source: "google-takeout"`, and carry a non-empty `places[]` whose records
 * have a `name` (a Takeout CSV layout change that breaks normalization fails
 * here instead of feeding empty/garbage downstream).
 */
export function normalizedPlacesContract(file: string = placesConfig.placesOut): ArtifactContract {
  return {
    key: 'places-normalized',
    description: 'ingest output: places.json — source google-takeout, non-empty places[] with names.',
    check(): GateResult {
      const { obj, violation } = readJson(file);
      if (violation) return { ok: false, violations: [violation] };
      const rec = obj as Record<string, unknown>;
      if (!rec || typeof rec !== 'object') return { ok: false, violations: ['places.json is not an object'] };
      if (rec.source !== 'google-takeout') {
        return { ok: false, violations: [`unexpected source: ${JSON.stringify(rec.source)} (want "google-takeout")`] };
      }
      const places = rec.places;
      if (!Array.isArray(places)) return { ok: false, violations: ['missing "places" array'] };
      if (places.length === 0) return { ok: false, violations: ['"places" array is empty — nothing to resolve'] };
      const bad = places.find((p) => !p || typeof (p as Record<string, unknown>).name !== 'string');
      if (bad) return { ok: false, violations: ['a place record is missing a string "name"'] };
      return { ok: true, detail: `${places.length} normalized place(s)` };
    },
  };
}

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
    check(): GateResult {
      const { obj, violation } = readJson(file);
      if (violation) return { ok: false, violations: [violation] };
      const resolved = (obj as Record<string, unknown>)?.resolved;
      if (!resolved || typeof resolved !== 'object' || Array.isArray(resolved)) {
        return { ok: false, violations: ['missing "resolved" map'] };
      }
      const entries = Object.values(resolved as Record<string, unknown>);
      if (entries.length === 0) return { ok: false, violations: ['"resolved" map is empty — nothing resolved'] };
      const withPlaceId = entries.filter(
        (e) => e && typeof (e as Record<string, unknown>).placeId === 'string' && (e as Record<string, unknown>).placeId,
      );
      if (withPlaceId.length === 0) return { ok: false, violations: ['no resolved entry has a place_id'] };
      return { ok: true, detail: `${withPlaceId.length}/${entries.length} entry(ies) with a place_id` };
    },
  };
}

/**
 * enrich → enrich-with-llm boundary: enriched.json. Must parse, carry a
 * non-empty `enriched` map, and have at least one entry with a `placeId` (the
 * LLM stage keys its research by place_id).
 */
export function enrichedPlacesContract(file: string = placesConfig.enrichedOut): ArtifactContract {
  return {
    key: 'enriched-places',
    description: 'enrich output: enriched.json — non-empty map, at least one entry with a place_id.',
    check(): GateResult {
      const { obj, violation } = readJson(file);
      if (violation) return { ok: false, violations: [violation] };
      const enriched = (obj as Record<string, unknown>)?.enriched;
      if (!enriched || typeof enriched !== 'object' || Array.isArray(enriched)) {
        return { ok: false, violations: ['missing "enriched" map'] };
      }
      const entries = Object.values(enriched as Record<string, unknown>);
      if (entries.length === 0) return { ok: false, violations: ['"enriched" map is empty — nothing enriched'] };
      const withPlaceId = entries.filter(
        (e) => e && typeof (e as Record<string, unknown>).placeId === 'string' && (e as Record<string, unknown>).placeId,
      );
      if (withPlaceId.length === 0) return { ok: false, violations: ['no enriched entry has a place_id'] };
      return { ok: true, detail: `${withPlaceId.length}/${entries.length} enriched place(s)` };
    },
  };
}
