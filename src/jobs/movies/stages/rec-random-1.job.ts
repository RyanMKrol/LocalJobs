import { makeBranchJob } from './recommend.js';

// Recommender branch — see stages/branches.ts for its lens + prompt. Thin
// wrapper; all logic is the shared makeBranchJob factory.
export default makeBranchJob('rec-random-1');
