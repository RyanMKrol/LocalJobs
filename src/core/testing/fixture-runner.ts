// Child entrypoint for the ports end-to-end tests: runs ONE fixture stage through
// the real child runtime (`runJobProcess`), looking the stage up among the
// fixtures instead of in the registry. A test points `config.runJobScript` here.
import { runJobProcess } from '../child-main.js';
import { fixtureJobs } from './ports-fixtures.js';

runJobProcess(process.argv[2], (name) => fixtureJobs.find((j) => j.name === name));
