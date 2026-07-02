import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const here = dirname(fileURLToPath(import.meta.url));

export const stockDigestConfig = {
  dataDir: resolve(here, 'data'),
  outDir: resolve(here, 'data', 'out'),
  /** How many winners/losers to surface in the movers section. */
  moversCount: 3,
};

/** "data/out/stock-digest-<weekKey>.md" for a given ISO week key. */
export function reportPathFor(weekKey: string, outDir: string = stockDigestConfig.outDir): string {
  return resolve(outDir, `stock-digest-${weekKey}.md`);
}

/** "data/out/sectors.json" — ticker -> resolved Finnhub industry map. */
export const sectorsJsonPath = resolve(stockDigestConfig.outDir, 'sectors.json');
