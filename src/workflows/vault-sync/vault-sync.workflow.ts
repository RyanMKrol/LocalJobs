import type { WorkflowDefinition } from '../../core/types.js';

/**
 * vault-sync — a single-stage mirror that copies the markdown output of five
 * source workflows (places, perfumes, plex-profiles, listening-digest,
 * workouts-sync) into the owner's second-brain vault folder (~/SecondBrain by
 * default, SECOND_BRAIN_VAULT_DIR to override), organized one folder per
 * source with prettified filenames. The vault is a READ-ONLY mirror: the sync
 * always overwrites a vault copy when its source changes, and never deletes
 * anything. One stage, so no DAG edge — no gate needed (plex-profiles /
 * overrides-audit precedent).
 *
 * Daily at 07:30, after the nightly places (03:00) and perfumes (02:00) runs,
 * so new profiles reach the vault the same morning they're built.
 */
const workflow: WorkflowDefinition = {
  name: 'vault-sync',
  category: 'second-brain',
  description: 'Mirrors the markdown output of the places, perfumes, plex-profiles, listening-digest, and workouts-sync workflows into a second-brain vault folder on disk (~/SecondBrain by default), one folder per source with human-friendly filenames. Copy-only: source files stay in each workflow\'s data/out, and nothing is ever deleted from the vault. Daily.',
  idempotencyNote: 'Each source item is tracked by its source ledger row\'s last-updated marker: a vault copy is only (re)written when the source item has been re-recorded since the last sync, or when the vault copy has been deleted by hand. Re-running when nothing changed writes nothing, so the sync is safe to trigger any time.',
  schedule: '30 7 * * *',
  jobs: [{ job: 'vault-sync-export' }],
};

export default workflow;
