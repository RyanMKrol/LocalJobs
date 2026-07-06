import type { WorkflowDefinition } from '../../core/types.js';

/**
 * Plex per-title original-language default audit. Plex only supports ONE global
 * default-audio-language preference, which is wrong for any library whose original
 * language isn't English (a foreign-language show/movie's own baked-in file default
 * can silently win over that global preference too). This workflow scans the whole
 * library, resolves each title's TRUE original language via TMDB, and works out
 * which audio/subtitle track SHOULD be selected per file versus what's currently
 * selected — a per-title, original-language-aware replacement for that single
 * global setting.
 *
 * SCAN ONLY for now: `plex-language-scan` is read-only and never touches Plex — it
 * just reports proposed changes to `data/out/language-scan.json`. Applying the
 * proposed selections (`plex-language-apply`) and flagging titles with no matching
 * track (`plex-language-no-track-flag`) are separate, already-planned follow-up
 * tasks that will join this workflow as additional members `dependsOn:
 * ['plex-language-scan']` — this manifest is left easy to extend for that.
 *
 * Re-scans fresh every run (an audit of drifting real-world state, not a one-time
 * build), idempotent per ISO calendar week via the work_items ledger — a manual
 * re-run the same week regenerates that week's scan rather than duplicating it.
 * One member so far, so no DAG edge — no gate needed (see src/workflows/CLAUDE.md).
 */
const workflow: WorkflowDefinition = {
  name: 'plex-language-fix',
  category: 'regular-maintenance',
  description:
    'Scans your whole Plex library, resolves each show/movie\'s true original language via TMDB, ' +
    'and reports which audio/subtitle track should be selected by default per file versus what is ' +
    'currently selected — read-only for now (report only; no Plex mutation). Weekly.',
  schedule: '0 4 * * 0',
  jobs: [{ job: 'plex-language-scan' }],
};

export default workflow;
