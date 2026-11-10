import { defineStage } from '../../../engine/index.js';
import { discoveredFiles, languageDecisions, resolvedLanguages } from '../contracts.js';
import { runEvaluate } from './evaluate.js';

export default defineStage({
  name: 'plex-language-evaluate',
  description:
    'For every file that is both discovered and resolved but not yet evaluated, fetches its live current ' +
    'Plex audio/subtitle stream selection and works out which track SHOULD be selected by default, using ' +
    'the same best-judgment heuristic as before (prefer an explicitly-labelled "Original" mix, then ' +
    'highest channel count, then higher-quality codec, then lowest stream index — a genuine tie is never ' +
    'flagged for manual review). Records a 2-value outcome per file: "change" (the default should be ' +
    'switched) or "skip" (already correct, or no matching track exists in any candidate language). ' +
    'Read-only — it never mutates Plex. Every file is evaluated exactly once, ever; a manual track change ' +
    'made after evaluation is not automatically re-detected.',
  timeoutMs: 3_600_000,
  maxRetries: 3,
  // Two inputs from two stages: the files from discover, their languages from resolve.
  inputs: {
    files: { artifact: discoveredFiles },
    languages: { artifact: resolvedLanguages },
  },
  outputs: { decisions: { artifact: languageDecisions } },
  async run(ctx) {
    await runEvaluate(ctx);
  },
});
