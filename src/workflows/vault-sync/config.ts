import { homedir } from 'node:os';
import { join } from 'node:path';

import { resolveWorkflowDataDir } from '../../config.js';

/**
 * vault-sync writes OUTSIDE the repo — into the owner's second-brain vault
 * folder — so unlike every other workflow it has no `data/` tree of its own.
 * The destination comes from `SECOND_BRAIN_VAULT_DIR` (defaulting to
 * `~/SecondBrain`, computed via homedir() at runtime — never a hardcoded
 * `/Users/...` literal, per the repo self-containment rule). The path is routed
 * through `resolveWorkflowDataDir` for the same reason every workflow's dataDir
 * is: under `npm test` it redirects to a per-process temp dir, so the suite can
 * never touch the owner's real vault.
 */
export const vaultSyncConfig = {
  vaultDir: resolveWorkflowDataDir(
    process.env.SECOND_BRAIN_VAULT_DIR?.trim() || join(homedir(), 'SecondBrain'),
  ),
};
