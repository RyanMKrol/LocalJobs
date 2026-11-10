import { ensureDirs as coreEnsureDirs, readJsonFile, writeJsonFile } from '../../engine/fsjson.js';
import { tvRecsConfig } from './config.js';

export function ensureDirs(): void {
  coreEnsureDirs(tvRecsConfig.outDir, tvRecsConfig.recsDir, tvRecsConfig.reportDir);
}

export { readJsonFile, writeJsonFile };
