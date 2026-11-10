import { ensureDirs as coreEnsureDirs, readJsonFile, writeJsonFile } from '../../engine/fsjson.js';
import { moviesConfig } from './config.js';

export function ensureDirs(): void {
  coreEnsureDirs(moviesConfig.outDir, moviesConfig.reportDir, moviesConfig.recsDir);
}

export { readJsonFile, writeJsonFile };
