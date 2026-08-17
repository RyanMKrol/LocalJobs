// Pure tests for artwork continuity across a rename — no IO, no live Plex.
import assert from 'node:assert/strict';
import { artworkIdentity, candidateToRestore, orphanedUpload, selectedIdentity, type ArtworkCandidate } from './artwork.js';

const UP_ID = 'upload://posters/89c62b49dc3fa256ffd8ac260705a98ae6d9594b';
const AGENT_ID = 'metadata://posters/tv.plex.agents.movie_57685ff5abee';
const UPLOAD_OLD = '/library/metadata/111/file?url=upload%3A%2F%2Fposters%2F89c62b49dc3fa256ffd8ac260705a98ae6d9594b';
const UPLOAD_NEW = '/library/metadata/63109/file?url=upload%3A%2F%2Fposters%2F89c62b49dc3fa256ffd8ac260705a98ae6d9594b';
const AGENT = '/library/metadata/63109/file?url=metadata%3A%2F%2Fposters%2Ftv%2Eplex%2Eagents%2Emovie_57685ff5abee';
const REMOTE = 'https://image.tmdb.org/t/p/original/bk9GVjN4kxmGekswNigaa5YIdr5.jpg';

{
  // The whole point: the SAME uploaded image under a recreated entry (a different
  // ratingKey in the URL) must resolve to the same identity, or continuity breaks.
  assert.equal(artworkIdentity(UPLOAD_OLD), artworkIdentity(UPLOAD_NEW));
  assert.equal(artworkIdentity(UPLOAD_OLD), 'upload:89c62b49dc3fa256ffd8ac260705a98ae6d9594b');
  assert.equal(artworkIdentity(AGENT), 'metadata:tv.plex.agents.movie_57685ff5abee');
  assert.equal(artworkIdentity(REMOTE), REMOTE);
  assert.equal(artworkIdentity(''), null);
  assert.equal(artworkIdentity('/library/metadata/1/file'), null, 'unidentifiable key is never acted on');
  // A bare ratingKey (what a recorded selection looks like) resolves to the same identity.
  assert.equal(artworkIdentity(UP_ID), artworkIdentity(UPLOAD_NEW));
  console.log('  ✓ artwork: identity survives an entry being recreated');
}

{
  const recreated: ArtworkCandidate[] = [
    { key: AGENT, ratingKey: AGENT_ID, selected: true }, // Plex reverted to the agent default
    { key: REMOTE, ratingKey: REMOTE, selected: false },
    { key: UPLOAD_NEW, ratingKey: UP_ID, selected: false }, // the owner's upload, still available
  ];
  assert.equal(selectedIdentity(recreated), 'metadata:tv.plex.agents.movie_57685ff5abee');

  const restore = candidateToRestore(recreated, artworkIdentity(UPLOAD_OLD)!);
  assert.ok(restore);
  assert.equal(restore!.key, UPLOAD_NEW, 're-selects the same image under its new URL');
  assert.equal(restore!.ratingKey, UP_ID, 'and hands back the ratingKey Plex actually selects by');

  // Already showing what was recorded → nothing to do (idempotent).
  const intact: ArtworkCandidate[] = [{ key: UPLOAD_NEW, ratingKey: UP_ID, selected: true }, { key: AGENT, ratingKey: AGENT_ID, selected: false }];
  assert.equal(candidateToRestore(intact, artworkIdentity(UPLOAD_OLD)!), null);

  // Recorded image is gone → leave Plex's choice alone rather than guessing.
  const gone: ArtworkCandidate[] = [{ key: AGENT, ratingKey: AGENT_ID, selected: true }, { key: REMOTE, ratingKey: REMOTE, selected: false }];
  assert.equal(candidateToRestore(gone, artworkIdentity(UPLOAD_OLD)!), null);

  // Nothing recorded → nothing to do.
  assert.equal(candidateToRestore(recreated, undefined), null);
  console.log('  ✓ artwork: restores the recorded selection, and only when it is both changed and available');
}

{
  // Fallback for entries with no recorded selection.
  const reverted: ArtworkCandidate[] = [{ key: AGENT, ratingKey: AGENT_ID, selected: true }, { key: UPLOAD_NEW, ratingKey: UP_ID, selected: false }];
  assert.equal(orphanedUpload(reverted)?.key, UPLOAD_NEW);

  const showingUpload: ArtworkCandidate[] = [{ key: UPLOAD_NEW, ratingKey: UP_ID, selected: true }, { key: AGENT, ratingKey: AGENT_ID, selected: false }];
  assert.equal(orphanedUpload(showingUpload), null, 'already showing the upload');

  const noUpload: ArtworkCandidate[] = [{ key: AGENT, ratingKey: AGENT_ID, selected: true }, { key: REMOTE, ratingKey: REMOTE, selected: false }];
  assert.equal(orphanedUpload(noUpload), null, 'never switches away from agent artwork when there is no upload');
  console.log('  ✓ artwork: orphaned-upload fallback only ever switches TO an upload');
}

console.log('  ✓ plex-rename artwork continuity tests passed');
