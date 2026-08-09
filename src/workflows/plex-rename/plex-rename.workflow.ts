import type { WorkflowDefinition } from '../../core/types.js';

/**
 * Canonical Plex library renamer. Years of accumulated release-named files
 * ([Erai-raws] ..., Movie.Name.2016.2160p...) were matched in Plex only via
 * manual fix-ups — if the Plex database were ever lost, none of that matching
 * is reproducible from the filenames. This workflow renames files/folders to
 * the canonical Plex conventions (Title (Year) {tmdb-N}/..., Show (Year)
 * {tvdb-N}/Season NN/..., plus a .plexmatch per show) using Plex's OWN current
 * matches as the source of truth, so the whole library becomes
 * deterministically re-discoverable from disk alone.
 *
 * Currently report-only: discover → plan → verify are all read-only. The
 * mutating apply stage (copy → checksum-verify → delete-original, write-ahead
 * journal, daily quota) and the confirm stage land behind the
 * PLEX_RENAME_APPLY_ENABLED probation gate.
 */
const workflow: WorkflowDefinition = {
  name: 'plex-rename',
  category: 'regular-maintenance',
  description:
    'Plans (and, once the probation gate is enabled, applies) canonical Plex-convention renames for every ' +
    'movie and TV episode file, using Plex\'s own matches as truth: "Title (Year) {tmdb-N}" folders, ' +
    '"Show (Year) {tvdb-N}/Season NN" trees, and a .plexmatch per show — so the library re-matches ' +
    'deterministically if the Plex database is ever lost. Daily; report-only until apply is enabled.',
  idempotencyNote:
    'Discover, plan, and verify are snapshots recomputed fresh every run — a file\'s rename DECISION always ' +
    'reflects the current library state, and a renamed file converges to "already canonical" automatically. ' +
    'The mutating apply stage (when enabled) moves each physical file at most once, ever, via its own ' +
    'permanent ledger — re-moving a file requires manually unsticking its apply row from the dashboard.',
  schedule: '0 5 * * *',
  jobs: [
    { job: 'plex-rename-discover' },
    { job: 'plex-rename-plan', dependsOn: ['plex-rename-discover'] },
    { job: 'plex-rename-verify', dependsOn: ['plex-rename-plan'] },
  ],
};

export default workflow;
