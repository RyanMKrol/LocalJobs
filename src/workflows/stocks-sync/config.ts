import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { resolveWorkflowDataDir } from '../../config.js';

const here = dirname(fileURLToPath(import.meta.url));
// The data folder goes through resolveWorkflowDataDir: the real `data/` in production,
// a scratch folder under test, so a test can never write into real output.
const outDir = resolve(resolveWorkflowDataDir(resolve(here, 'data')), 'out');

const DEFAULT_BREACH_THRESHOLD_PCT = 30;

function resolveBreachThresholdPct(): number {
  const raw = Number(process.env.STOCKS_WATCH_BREACH_PCT);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BREACH_THRESHOLD_PCT;
}

export const stocksSyncConfig = {
  outDir,
  rawPositionsJsonPath: resolve(outDir, 'raw-positions.json'),
  namedPositionsJsonPath: resolve(outDir, 'named-positions.json'),
  portfolioJsonPath: resolve(outDir, 'portfolio.json'),
  portfolioMdPath: resolve(outDir, 'portfolio.md'),
  freshBreachesJsonPath: resolve(outDir, 'fresh-breaches.json'),
  /**
   * A position rises this % or more above its average buy price to count as a
   * breach. A function (not a fixed value) so an env override (or a test
   * setting `process.env.STOCKS_WATCH_BREACH_PCT`) always takes effect —
   * `stocksSyncConfig` itself is only evaluated once, at module load.
   */
  breachThresholdPct: resolveBreachThresholdPct,
};
