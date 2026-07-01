import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const here = dirname(fileURLToPath(import.meta.url));

export const projectsSyncConfig = {
  outDir: resolve(here, 'data', 'out'),
  catalogPath: resolve(here, 'data', 'out', 'projects.json'),
};
