import type { WorkflowDefinition } from '../../core/types.js';

/**
 * Plex per-title original-language default audit. Plex only supports ONE global
 * default-audio-language preference, which is wrong for any library whose original
 * language isn't English (a foreign-language show/movie's own baked-in file default
 * can silently win over that global preference too). This workflow resolves each
 * title's TRUE original language via TMDB, works out which audio/subtitle track
 * SHOULD be selected per file versus what's currently selected, and APPLIES it — a
 * per-title, original-language-aware replacement for that single global setting.
 *
 * Four members (T453), each processing a file exactly once, ever, via the
 * per-item work_items ledger — NOT a whole-library re-scan every run:
 *   plex-language-discover  (read-only, root — enumerates every file)
 *     → plex-language-resolve   (read-only — TMDB original-language lookup, cached per title)
 *       → plex-language-evaluate  (read-only — decides change vs skip per file)
 *         → plex-language-apply    (MUTATING — applies every "change" via Plex's own API)
 *
 * There is NO manual approval step: the owner explicitly chose full unattended
 * automation over a per-run sign-off. The safety net is a Plex Butler on-demand
 * backup triggered before the first change of a run, plus a self-contained
 * per-run applied-changes log that the manual, never-scheduled
 * `scripts/plex-language-undo.ts` can replay to revert.
 */
const workflow: WorkflowDefinition = {
  name: 'plex-language-fix',
  category: 'regular-maintenance',
  description:
    'Resolves each show/movie\'s true original language via TMDB and applies the correct default audio/' +
    'subtitle track selection per file via Plex\'s own API — fully unattended (a Plex Butler backup + a ' +
    'per-file undo log stand in for manual review). Each file is processed exactly once, ever. Weekly.',
  idempotencyNote: 'Each individual file in your Plex library is tracked and processed through discovery, language lookup, evaluation, and (if needed) the actual audio/subtitle change exactly ONCE, ever — once a file has been evaluated or changed it is never automatically re-checked again, even if something about it changes later; a stuck or already-applied file must be manually reset from the dashboard to be reprocessed.',
  schedule: '0 4 * * 0',
  jobs: [
    { job: 'plex-language-discover' },
    { job: 'plex-language-resolve', dependsOn: ['plex-language-discover'] },
    { job: 'plex-language-evaluate', dependsOn: ['plex-language-discover', 'plex-language-resolve'] },
    { job: 'plex-language-apply', dependsOn: ['plex-language-evaluate'] },
  ],
};

export default workflow;
