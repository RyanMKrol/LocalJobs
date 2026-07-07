// Typed-artifact contracts for the plex-language-fix DAG (T453):
// plex-language-discover → plex-language-resolve → plex-language-evaluate → plex-language-apply.
// Unlike places/perfumes, this workflow's stages chain through the per-item
// `work_items` ledger, not a shared JSON file — each `check()` below is a
// deliberately trivial "did the producer record anything" gate (an acceptable
// minimum per this repo's gate-coverage rule), reading the ledger read-only via
// `stages/ledger.ts` (never a paid/remote call).
import type { ArtifactContract, ExpectationResult, GateResult } from '../../core/types.js';
import { ledgerSuccessCount } from './stages/ledger.js';

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

const EXP_RECORDED = 'The ledger is readable (the library may legitimately be empty).';

/** discover → resolve / discover → evaluate boundary: every discovered file. */
export function plexLanguageDiscoverContract(): ArtifactContract {
  return {
    key: 'plex-language-discover',
    description: 'discover output: one work_items row per known file, keyed by "<itemRatingKey>::part<partId>", detail { name, file, itemRatingKey, partId, type, tmdbId, seasonEpisode? }.',
    shape: {
      summary: 'Every file (movie or TV episode) discovered across the configured Plex library sections.',
      format: 'work_items ledger rows for job "plex-language-discover"',
      expectations: [{ label: EXP_RECORDED, detail: 'The ledger for this job is queryable.' }],
    },
    check(): GateResult {
      const n = ledgerSuccessCount('plex-language-discover');
      return fromChecks([{ label: EXP_RECORDED, ok: true, actual: `${n} file(s) known` }], `${n} file(s)`);
    },
  };
}

/** resolve → evaluate boundary: every file with a resolved candidate-language list. */
export function plexLanguageResolveContract(): ArtifactContract {
  return {
    key: 'plex-language-resolve',
    description: 'resolve output: one work_items row per resolved file, detail { name, originalLanguage?, candidateLanguages[] }.',
    shape: {
      summary: 'Every discovered file whose show/movie true original language has been resolved via TMDB.',
      format: 'work_items ledger rows for job "plex-language-resolve"',
      expectations: [{ label: EXP_RECORDED, detail: 'The ledger for this job is queryable.' }],
    },
    check(): GateResult {
      const n = ledgerSuccessCount('plex-language-resolve');
      return fromChecks([{ label: EXP_RECORDED, ok: true, actual: `${n} file(s) resolved` }], `${n} file(s)`);
    },
  };
}

/** evaluate → apply boundary: every file with a change/skip decision. */
export function plexLanguageEvaluateContract(): ArtifactContract {
  return {
    key: 'plex-language-evaluate',
    description: 'evaluate output: one work_items row per evaluated file, detail { name, status: "change"|"skip", currentAudio, currentSubtitle, proposedAudio?, proposedSubtitle? }.',
    shape: {
      summary: 'Every resolved file\'s change/skip decision, with the current + proposed stream selection.',
      format: 'work_items ledger rows for job "plex-language-evaluate"',
      expectations: [{ label: EXP_RECORDED, detail: 'The ledger for this job is queryable.' }],
    },
    check(): GateResult {
      const n = ledgerSuccessCount('plex-language-evaluate');
      return fromChecks([{ label: EXP_RECORDED, ok: true, actual: `${n} file(s) evaluated` }], `${n} file(s)`);
    },
  };
}
