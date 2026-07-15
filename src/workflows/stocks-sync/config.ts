import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const here = dirname(fileURLToPath(import.meta.url));

const DEFAULT_BREACH_THRESHOLD_PCT = 30;

function resolveBreachThresholdPct(): number {
  const raw = Number(process.env.STOCKS_WATCH_BREACH_PCT);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BREACH_THRESHOLD_PCT;
}

export const stocksSyncConfig = {
  outDir: resolve(here, 'data', 'out'),
  rawPositionsJsonPath: resolve(here, 'data', 'out', 'raw-positions.json'),
  namedPositionsJsonPath: resolve(here, 'data', 'out', 'named-positions.json'),
  portfolioJsonPath: resolve(here, 'data', 'out', 'portfolio.json'),
  portfolioMdPath: resolve(here, 'data', 'out', 'portfolio.md'),
  freshBreachesJsonPath: resolve(here, 'data', 'out', 'fresh-breaches.json'),
  /**
   * A position rises this % or more above its average buy price to count as a
   * breach. A function (not a fixed value) so an env override (or a test
   * setting `process.env.STOCKS_WATCH_BREACH_PCT`) always takes effect —
   * `stocksSyncConfig` itself is only evaluated once, at module load.
   */
  breachThresholdPct: resolveBreachThresholdPct,
};
