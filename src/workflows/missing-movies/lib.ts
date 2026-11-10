import { mkdirSync } from 'node:fs';
import { readJsonFile, writeJsonFile } from '../../engine/fsjson.js';
import { missingMoviesConfig } from './config.js';

export function ensureDirs(): void {
  for (const d of [missingMoviesConfig.outDir, missingMoviesConfig.reportDir]) mkdirSync(d, { recursive: true });
}

// Shared (atomic-write) JSON helpers, re-exported so existing call sites keep resolving.
export { readJsonFile, writeJsonFile };
