import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { resolveWorkflowDataDir } from '../../config.js';

const here = dirname(fileURLToPath(import.meta.url));
// The data folder goes through resolveWorkflowDataDir: the real `data/` in production,
// a scratch folder under test, so a test can never write into real output.
const dataDir = resolveWorkflowDataDir(resolve(here, 'data'));

export const projectsSyncConfig = {
  outDir: resolve(dataDir, 'out'),
  catalogPath: resolve(dataDir, 'out', 'projects.json'),
  reposDir: resolve(dataDir, 'repos'),
  /** The output contract — the in-project summary template (self-contained, no
   *  external repo). Override with PROJECTS_SYNC_TEMPLATE_PATH to point elsewhere. */
  templatePath: process.env.PROJECTS_SYNC_TEMPLATE_PATH ?? resolve(here, 'project.template.md'),
};
