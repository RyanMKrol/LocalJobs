// The data the tv-recommendations stages hand to each other.
//
//   tv-snapshot ──snapshot, taste──▶ 8 branches ──suggestions──▶ tv-rec-merge ──recommendations──▶ tv-recs-notify
//        └───────────────snapshot, taste────────────────────────────▲
//
// The artifact types (what each is, how it is checked, how it is shown) are
// shared with the movie recommender: see src/core/recommender/stages.ts. This
// file only says which domain they are for. The branch artifact is ONE type
// that all eight branches output, which is what lets the merge take them through
// a single fan-in port.
import { recommenderArtifacts } from '../../core/recommender/stages.js';
import { tvDomain } from './stages/branches.js';

export const tvArtifacts = recommenderArtifacts(tvDomain, 'tv', 'shows');
