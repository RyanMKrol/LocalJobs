// The data the plex-language-fix stages hand to each other. It all travels in the
// work_items ledger: each stage's rows ARE its output, one per media file, so the
// artifacts here are ledger artifacts (no hand-off files).
//
//   discover ──files──▶ resolve ──languages──▶ evaluate ──decisions──▶ apply
//      ├──────────────files──────────────────────▲                       ▲
//      └──────────────────────────files──────────────────────────────────┘
//
// evaluate and apply both read the discover rows as well (for each file's Plex
// ids), so they depend on discover directly.
import { fromChecks, ledgerArtifact, successRows } from '../../engine/index.js';
import type { LedgerRowValue } from '../../engine/index.js';
import type { DiscoverDetail, EvaluateDetail, ResolveDetail } from './types.js';

const READABLE = 'The ledger is readable (the library may legitimately be empty).';
const named = (r: LedgerRowValue) => String((r.detail as { name?: unknown } | null)?.name ?? r.itemKey);

/** Every media file discovered across the configured Plex sections. */
export const discoveredFiles = ledgerArtifact({
  key: 'plex-language-discover',
  description: 'Every media file (movie or episode) known across the configured Plex sections, one ledger row each.',
  shape: {
    summary: 'Every file discovered across the configured Plex library sections.',
    format: 'work_items ledger rows for job "plex-language-discover"',
    expectations: [{ label: READABLE, detail: 'The ledger for this job is queryable.' }],
  },
  readRows: successRows,
  check: (rows) => fromChecks([{ label: READABLE, ok: true, actual: `${rows.length} file(s) known` }], `${rows.length} file(s)`),
  summary: (rows) => `${rows.length} file(s)`,
  items: (rows) => rows.map((r) => {
    const d = r.detail as DiscoverDetail | null;
    return { id: r.itemKey, title: named(r), fields: d ? [{ label: 'Kind', value: d.type }, { label: 'TMDB', value: String(d.tmdbId) }] : [] };
  }),
});

/** The original language of each file's title, resolved through TMDB. */
export const resolvedLanguages = ledgerArtifact({
  key: 'plex-language-resolve',
  description: 'Each file\'s true original language, resolved through TMDB, one ledger row per file.',
  shape: {
    summary: 'Every discovered file whose title\'s original language has been resolved via TMDB.',
    format: 'work_items ledger rows for job "plex-language-resolve"',
    expectations: [{ label: READABLE, detail: 'The ledger for this job is queryable.' }],
  },
  readRows: successRows,
  check: (rows) => fromChecks([{ label: READABLE, ok: true, actual: `${rows.length} file(s) resolved` }], `${rows.length} file(s)`),
  summary: (rows) => `${rows.length} file(s) resolved`,
  items: (rows) => rows.map((r) => {
    const d = r.detail as ResolveDetail | null;
    return { id: r.itemKey, title: named(r), fields: d?.originalLanguage ? [{ label: 'Original language', value: d.originalLanguage }] : [] };
  }),
});

const APPLIABLE = 'Every "change" decision has a numeric proposed audio stream id and a recorded current audio selection.';

/**
 * Each file's change-or-skip decision. The check is the bar the apply stage
 * relies on before it PUTs a track selection to Plex: a malformed "change" row
 * stops the run here, before anything is touched.
 */
export const languageDecisions = ledgerArtifact({
  key: 'plex-language-evaluate',
  description: 'Each file\'s decision: change its default audio and subtitle tracks, or leave it. One ledger row per file.',
  shape: {
    summary: 'Every resolved file\'s change/skip decision, with the current and proposed stream selection.',
    format: 'work_items ledger rows for job "plex-language-evaluate"',
    expectations: [{ label: APPLIABLE, detail: 'Every "change" row is well-formed enough for apply to act on safely.' }],
  },
  readRows: successRows,
  check(rows) {
    const offenders: string[] = [];
    for (const row of rows) {
      const detail = row.detail as EvaluateDetail | null;
      if (detail?.status !== 'change') continue;
      if (typeof detail.proposedAudio?.streamId !== 'number' || detail.currentAudio == null) offenders.push(row.itemKey);
    }
    const ok = offenders.length === 0;
    return fromChecks(
      [{ label: APPLIABLE, ok, actual: ok ? `${rows.length} file(s) evaluated, all "change" rows applicable` : `${offenders.length} malformed "change" row(s): ${offenders.slice(0, 20).join(', ')}` }],
      `${rows.length} file(s)`,
    );
  },
  summary: (rows) => `${rows.length} file(s) evaluated, ${rows.filter((r) => (r.detail as EvaluateDetail | null)?.status === 'change').length} to change`,
  items: (rows) => rows.map((r) => ({ id: r.itemKey, title: named(r), fields: [{ label: 'Decision', value: String((r.detail as EvaluateDetail | null)?.status ?? '?') }] })),
});

/** The files whose track selection has been changed in Plex, ever. Each is applied exactly once. */
export const appliedChanges = ledgerArtifact({
  key: 'plex-language-applied',
  description: 'Every file whose default tracks have been changed in Plex, one ledger row each. A file is applied once, ever.',
  readRows: successRows,
  check: (rows) => fromChecks([{ label: READABLE, ok: true, actual: `${rows.length} file(s) applied` }], `${rows.length} file(s)`),
  summary: (rows) => `${rows.length} file(s) applied`,
  items: (rows) => rows.map((r) => ({ id: r.itemKey, title: named(r) })),
});
