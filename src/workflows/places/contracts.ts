// The data the places stages hand to each other.
//
//   places-ingest ──places──▶ cid-to-place-id-resolver ──resolved──▶ places-enrich ──enriched──▶ enrich-with-llm ──▶ profiles
//         └──────────────────────────places───────────────────────────────────────────────────▲
//
// The last stage reads the normalized places as well (for each place's list
// memberships and the owner's notes), so it depends on the ingest stage directly.
//
// The checks are SHAPE + NON-EMPTY: enough to catch a Takeout CSV layout change
// or an empty hand-off without brittle full-schema validation.
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { dirArtifact, fromChecks, jsonArtifact } from '../../engine/index.js';
import type { EnrichedFile, IngestOutput, ResolvedFile, ValidationReport } from './types.js';

/** ingest's output: every saved place, normalized from the Takeout CSVs. Rebuilt every run. */
export const normalizedPlaces = jsonArtifact<IngestOutput>({
  key: 'places-normalized',
  description: 'Every saved place, normalized from the Google Takeout CSVs: name, CID, the lists it is on, the owner\'s notes.',
  shape: {
    summary: 'The saved places, normalized from Google Takeout.',
    format: 'JSON object { generatedAt, source, places[] }',
    expectations: [
      { label: 'Sourced from Google Takeout', detail: 'The file declares source: "google-takeout".' },
      { label: 'Contains at least one place', detail: 'A non-empty places array. A Takeout layout change that breaks parsing shows up here as zero places.' },
      { label: 'Every place has a name', detail: 'Each place carries a text name.' },
    ],
  },
  check(v) {
    const places = Array.isArray(v?.places) ? v.places : null;
    const bad = places?.find((p) => !p || typeof p.name !== 'string');
    return fromChecks([
      { label: 'Sourced from Google Takeout', ok: v?.source === 'google-takeout', actual: `source = ${JSON.stringify(v?.source)}` },
      { label: 'Contains at least one place', ok: !!places && places.length > 0, actual: places ? `${places.length} place(s)` : 'no "places" array' },
      { label: 'Every place has a name', ok: !!places && !bad, actual: bad ? 'a place is missing a text name' : 'all places named' },
    ], places ? `${places.length} place(s)${places.length ? ` · e.g. ${places.slice(0, 3).map((p) => JSON.stringify(p?.name)).join(', ')}` : ''}` : undefined);
  },
  summary: (v) => `${v.places.length} place(s)`,
  items: (v) => v.places.map((p, i) => ({ id: p.cid ?? String(i), title: p.name, fields: p.cid ? [{ label: 'CID', value: p.cid }] : [] })),
});

/** ingest's second output: what it made of the CSVs. */
export const validationReport = jsonArtifact<ValidationReport>({
  key: 'places-validation-report',
  description: 'What the ingest made of the Takeout CSVs: counts per list, and anything it had to warn about.',
  check: (v) => fromChecks([{ label: 'lists the issues it found', ok: Array.isArray(v?.issues), actual: Array.isArray(v?.issues) ? `${v.issues.length} issue(s)` : 'no issues list' }]),
  summary: (v) => `${v.perList?.length ?? 0} list(s), ${v.issues.length} issue(s)`,
});

/** The resolver's store: CID to Google place_id. Grows as places are resolved. */
export const resolvedPlaces = jsonArtifact<ResolvedFile>({
  key: 'resolved-place-ids',
  description: 'Each place\'s CID resolved to a Google place_id (or recorded as unresolvable). Grows as places are resolved.',
  shape: {
    summary: 'CID to place_id lookup.',
    format: 'JSON object { generatedAt, resolved: { cid: {...} } }',
    expectations: [
      { label: 'Has a "resolved" lookup map', detail: 'The file carries a resolved map keyed by CID.' },
      { label: 'The map is not empty', detail: 'At least one entry.' },
      { label: 'At least one place resolved to a place_id', detail: 'At least one entry has a real place_id, which the enrich stage needs.' },
    ],
  },
  check(v) {
    const map = v?.resolved;
    const isMap = !!map && typeof map === 'object' && !Array.isArray(map);
    if (!isMap) return fromChecks([{ label: 'Has a "resolved" lookup map', ok: false, actual: 'missing "resolved" map' }]);
    const entries = Object.values(map);
    const withId = entries.filter((e) => e && typeof e.placeId === 'string' && e.placeId).length;
    return fromChecks([
      { label: 'Has a "resolved" lookup map', ok: true, actual: 'present' },
      { label: 'The map is not empty', ok: entries.length > 0, actual: `${entries.length} entry(ies)` },
      { label: 'At least one place resolved to a place_id', ok: withId > 0, actual: `${withId}/${entries.length} with a place_id` },
    ], `${withId}/${entries.length} entry(ies) resolved to a place_id`);
  },
  summary: (v) => { const e = Object.values(v.resolved); return `${e.filter((x) => x.placeId).length}/${e.length} resolved to a place_id`; },
  items: (v) => Object.values(v.resolved).map((r) => ({
    id: r.cid, title: r.name, status: r.placeId ? 'success' : 'failed',
    fields: [{ label: 'Status', value: r.status }, ...(r.placeId ? [{ label: 'place_id', value: r.placeId }] : [])],
  })),
});

/** The enrich stage's store: Google Places details per place. Grows as places are enriched. */
export const enrichedPlaces = jsonArtifact<EnrichedFile>({
  key: 'enriched-places',
  description: 'The Google Places details fetched for each resolved place. Grows as places are enriched.',
  shape: {
    summary: 'Places details per place_id.',
    format: 'JSON object { generatedAt, enriched: { placeId: {...} } }',
    expectations: [
      { label: 'Has an "enriched" lookup map', detail: 'The file carries an enriched map.' },
      { label: 'The map is not empty', detail: 'At least one entry.' },
      { label: 'At least one enriched place has a place_id', detail: 'At least one entry carries its place_id.' },
    ],
  },
  check(v) {
    const map = v?.enriched;
    const isMap = !!map && typeof map === 'object' && !Array.isArray(map);
    if (!isMap) return fromChecks([{ label: 'Has an "enriched" lookup map', ok: false, actual: 'missing "enriched" map' }]);
    const entries = Object.values(map);
    const withId = entries.filter((e) => e && typeof e.placeId === 'string' && e.placeId).length;
    return fromChecks([
      { label: 'Has an "enriched" lookup map', ok: true, actual: 'present' },
      { label: 'The map is not empty', ok: entries.length > 0, actual: `${entries.length} entry(ies)` },
      { label: 'At least one enriched place has a place_id', ok: withId > 0, actual: `${withId}/${entries.length} with a place_id` },
    ], `${withId}/${entries.length} enriched place(s)`);
  },
  summary: (v) => { const e = Object.values(v.enriched); return `${e.filter((x) => x.status === 'success').length}/${e.length} enriched`; },
  items: (v) => Object.values(v.enriched).map((e) => ({
    id: e.placeId, title: typeof e.data?.displayName === 'object' && e.data.displayName ? String((e.data.displayName as { text?: unknown }).text ?? e.placeId) : e.placeId,
    status: e.status, fields: [{ label: 'CID', value: e.cid }],
  })),
});

/** The workflow's product: one markdown profile per place. */
export const placeProfiles = dirArtifact({
  key: 'place-profiles',
  description: 'The finished markdown profile of each place.',
  format: 'markdown',
  files: (name) => name.endsWith('.md'),
  check(d) {
    const empty = d.files.filter((f) => statSync(join(d.path, f)).size === 0);
    return fromChecks([{ label: 'no profile is empty', ok: empty.length === 0, actual: empty.length ? `empty: ${empty.slice(0, 5).join(', ')}` : `${d.files.length} profile(s)` }], `${d.files.length} profile(s)`);
  },
  count: (d) => d.files.length,
  summary: (d) => `${d.files.length} profile(s)`,
  items: (d) => d.files.map((f) => ({ id: f, title: f.replace(/\.md$/, ''), preview: { path: join(d.path, f), format: 'markdown' } })),
});
