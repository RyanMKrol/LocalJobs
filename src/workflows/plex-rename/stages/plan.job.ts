import type { JobDefinition } from '../../../core/types.js';
import { plexRenameDiscoverContract, plexRenamePlanContract } from '../contracts.js';
import { runPlan } from './plan.js';

const job: JobDefinition = {
  name: 'plex-rename-plan',
  description:
    'Computes each discovered file\'s canonical Plex-convention rename decision using the pure naming engine ' +
    '(naming.ts): movies become "Title (Year) {tmdb-N}/Title (Year) {tmdb-N}.ext" and episodes become ' +
    '"Show (Year) {tvdb-N}/Season NN/Show (Year) - sNNeNN - Title.ext", with full sanitization for the real ' +
    'Plex scanner hazards (semicolon truncation, bracket-ignore, special folder names). Every decision — ' +
    'rename (with exact from → to and the planned operations), already-canonical, or a typed skip reason ' +
    '(missing ids, multi-version, disc images, collisions, and more) — is recorded on the ledger and ' +
    'RECOMPUTED on every run, since plans are derived state that improves as metadata and the engine do. ' +
    'A cross-item pass downgrades any two files computing the same target to collision skips. Purely ' +
    'computational: no filesystem access, no Plex calls, nothing mutated. The from → to for every planned ' +
    'rename is visible per item in the run\'s Inputs & Outputs panel — this is the report the owner reviews ' +
    'during the probation period before enabling the mutating apply stage.',
  timeoutMs: 900_000,
  maxRetries: 3,
  consumes: [plexRenameDiscoverContract()],
  produces: [plexRenamePlanContract()],
  async run(ctx) {
    await runPlan(ctx);
  },
};

export default job;
