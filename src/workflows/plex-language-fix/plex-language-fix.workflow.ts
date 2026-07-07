import type { WorkflowDefinition } from '../../core/types.js';

/**
 * Plex per-title original-language default audit. Plex only supports ONE global
 * default-audio-language preference, which is wrong for any library whose original
 * language isn't English (a foreign-language show/movie's own baked-in file default
 * can silently win over that global preference too). This workflow scans the whole
 * library, resolves each title's TRUE original language via TMDB, works out which
 * audio/subtitle track SHOULD be selected per file versus what's currently selected,
 * and now APPLIES it — a per-title, original-language-aware replacement for that
 * single global setting.
 *
 * `plex-language-scan` is read-only and never touches Plex — it reports proposed
 * changes to `data/out/language-scan.json`. `plex-language-apply` (depends on
 * plex-language-scan) applies every proposed change via Plex's own official
 * "PUT /library/parts/<id>" stream-selection endpoint. There is NO manual
 * approval step: the owner explicitly chose full unattended automation over a
 * per-run sign-off. The safety net is a Plex Butler on-demand backup triggered
 * before the first change of a run, plus a self-contained per-run applied-changes
 * log that the manual, never-scheduled `scripts/plex-language-undo.ts` can replay
 * to revert.
 *
 * Re-scans fresh every run (an audit of drifting real-world state, not a one-time
 * build), idempotent per ISO calendar week via the work_items ledger — a manual
 * re-run the same week regenerates that week's scan rather than duplicating it.
 */
const workflow: WorkflowDefinition = {
  name: 'plex-language-fix',
  category: 'regular-maintenance',
  description:
    'Scans your whole Plex library, resolves each show/movie\'s true original language via TMDB, and ' +
    'applies the correct default audio/subtitle track selection per file via Plex\'s own API — fully ' +
    'unattended (a Plex Butler backup + a per-file undo log stand in for manual review). Weekly.',
  schedule: '0 4 * * 0',
  jobs: [
    { job: 'plex-language-scan' },
    { job: 'plex-language-apply', dependsOn: ['plex-language-scan'] },
  ],
};

export default workflow;
