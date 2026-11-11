import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { resolveWorkflowDataDir } from '../../config.js';

const here = dirname(fileURLToPath(import.meta.url));
// The data folder goes through resolveWorkflowDataDir: the real `data/` in production,
// a scratch folder under test, so a test can never write into real output.
const dataDir = resolveWorkflowDataDir(resolve(here, 'data'));

export const listeningDigestConfig = {
  dataDir,
  /** Last.fm API base URL */
  lastFmApiBase: 'https://ws.audioscrobbler.com/2.0',
  /** Last.fm `period` param — trailing 1 month from run time (not calendar month). */
  period: '1month',
  /** Last.fm `period` param for the second, trailing-3-month digest written alongside the 1-month one. */
  trailingPeriod: '3month',
  /** How many top albums / top tracks to request from Last.fm. */
  topAlbumsLimit: 25,
  topTracksLimit: 50,
  /**
   * Filter out an "album" where a single track accounts for more than this
   * fraction of the album's total plays — usually means it's really just one
   * song on repeat, not an album you listened through. Mirrors the same
   * heuristic used by the ryankrol.co.uk /listening page.
   */
  singleTrackAlbumRatio: 0.7,
};
