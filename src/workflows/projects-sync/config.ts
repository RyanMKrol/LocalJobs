import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const here = dirname(fileURLToPath(import.meta.url));

export const projectsSyncConfig = {
  outDir: resolve(here, 'data', 'out'),
  catalogPath: resolve(here, 'data', 'out', 'projects.json'),
  reposDir: resolve(here, 'data', 'repos'),
  /** The output contract — the in-project summary template (self-contained, no
   *  external repo). Override with PROJECTS_SYNC_TEMPLATE_PATH to point elsewhere. */
  templatePath: process.env.PROJECTS_SYNC_TEMPLATE_PATH ?? resolve(here, 'project.template.md'),
};
