import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const here = dirname(fileURLToPath(import.meta.url));

export const stocksSyncConfig = {
  outDir: resolve(here, 'data', 'out'),
  rawPositionsJsonPath: resolve(here, 'data', 'out', 'raw-positions.json'),
  portfolioJsonPath: resolve(here, 'data', 'out', 'portfolio.json'),
  portfolioMdPath: resolve(here, 'data', 'out', 'portfolio.md'),
  freshBreachesJsonPath: resolve(here, 'data', 'out', 'fresh-breaches.json'),
};
