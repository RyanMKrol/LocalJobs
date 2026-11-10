// Child entrypoint for the engine's scenario tests: runs ONE fixture stage through
// the real child runtime (`runJobProcess`), exactly as `src/runJob.ts` runs a real
// one, except that the stage is looked up in a scenario module instead of the
// application's registry. A test points `config.runJobScript` here and names the
// scenario module in LJ_SCENARIO_MODULE (see scenario.ts).
import { pathToFileURL } from 'node:url';
import { runJobProcess } from '../child-main.js';
import type { JobDefinition } from '../types.js';

const modulePath = process.env.LJ_SCENARIO_MODULE;
if (!modulePath) throw new Error('LJ_SCENARIO_MODULE is not set: the fixture runner needs a scenario module to load stages from');
const scenario = (await import(pathToFileURL(modulePath).href)) as { jobs?: JobDefinition[] };
if (!Array.isArray(scenario.jobs)) throw new Error(`${modulePath} does not export a \`jobs\` array`);

runJobProcess(process.argv[2], (name) => scenario.jobs!.find((j) => j.name === name));
