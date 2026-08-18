/**
 * Artwork continuity across a rename.
 *
 * Moving a file to a new folder can make Plex retire the old library entry and
 * build a fresh one. The new entry re-matches the same title, but it starts from
 * the agent's DEFAULT artwork — so any poster/background the owner had chosen
 * silently stops being shown. That is exactly what happened to ~103 films and a
 * number of shows in the 2026-08 sweep, and it is the kind of personalisation a
 * programmatic renamer must not cost its owner.
 *
 * The images themselves are never lost: Plex keys its metadata bundle off the
 * item's GUID, so an uploaded poster is still among the NEW entry's candidates —
 * just unselected. So continuity only needs two things:
 *   1. capture WHICH candidate is selected before we touch the file, and
 *   2. re-select the same one afterwards, on whichever entry now owns the file.
 *
 * A candidate's URL embeds the owning ratingKey, which changes when the entry is
 * recreated — so a raw key is NOT portable. `artworkIdentity` extracts the stable
 * part (the upload hash, the agent's metadata id, or the remote image URL) and
 * that is what we match on.
 */

export type ArtworkKind = 'poster' | 'art';

export interface ArtworkCandidate {
  /** The item-scoped file URL (identity is derived from this). */
  key: string;
  /** What Plex expects back to SELECT this image — `upload://posters/<hash>`,
   *  `metadata://posters/<agent id>`, or a remote URL. NOT interchangeable with
   *  `key`: selecting by `key` is accepted with a 200 and silently does nothing. */
  ratingKey: string;
  selected: boolean;
}

/** What was showing before the move, as portable identities. */
export interface ArtworkSelection {
  poster?: string;
  art?: string;
}

/**
 * The stable identity of an artwork candidate, independent of which library entry
 * currently owns it:
 *   /library/metadata/63109/file?url=upload%3A%2F%2Fposters%2F89c62b… → upload:89c62b…
 *   /library/metadata/63109/file?url=metadata%3A%2F%2Fposters%2Ftv.plex…_5768… → metadata:tv.plex…_5768…
 *   https://image.tmdb.org/t/p/original/abc.jpg                        → https://image.tmdb.org/t/p/original/abc.jpg
 * Returns null for a key we cannot identify, which callers treat as "do not touch".
 */
export function artworkIdentity(key: string): string | null {
  if (!key) return null;
  if (/^https?:\/\//i.test(key)) return key;
  // A bare ratingKey form (upload://posters/… or metadata://posters/…) identifies
  // itself directly — no item-scoped URL to unwrap.
  const bare = /^(upload|metadata):\/\/(?:posters|art)\/(.+)$/.exec(key);
  if (bare) return `${bare[1]}:${bare[2]}`;
  const m = /[?&]url=([^&]+)/.exec(key);
  if (!m) return null;
  const decoded = decodeURIComponent(m[1]);
  const inner = /^(upload|metadata):\/\/(?:posters|art)\/(.+)$/.exec(decoded);
  if (inner) return `${inner[1]}:${inner[3] ?? inner[2]}`;
  return decoded;
}

/** The identity currently selected among `candidates`, or null when none is. */
export function selectedIdentity(candidates: ArtworkCandidate[]): string | null {
  const sel = candidates.find((c) => c.selected);
  return sel ? artworkIdentity(sel.key) : null;
}

/**
 * The candidate to re-select so `wanted` is showing again, or null when nothing
 * needs doing. Null covers every safe case: nothing was recorded, it is already
 * showing, or the recorded image is no longer among the candidates (in which case
 * we leave Plex's choice alone rather than substituting something arbitrary).
 */
export function candidateToRestore(candidates: ArtworkCandidate[], wanted: string | undefined): ArtworkCandidate | null {
  if (!wanted) return null;
  if (selectedIdentity(candidates) === wanted) return null;
  return candidates.find((c) => artworkIdentity(c.key) === wanted) ?? null;
}

/**
 * Fallback for items renamed BEFORE capture existed (and for any entry recreated
 * without a recorded selection): if an upload is available but an agent default is
 * showing, the upload is what the owner had chosen. Only ever switches TO an
 * upload, so it cannot undo a deliberate preference for agent artwork on an item
 * that has no upload at all.
 *
 * AMBIGUITY IS NOT RESOLVED BY GUESSING (2026-08-18). An item can carry SEVERAL
 * uploads — the owner replaced a poster, and Plex keeps both images. The API
 * exposes no upload date and no ordering guarantee, so "the first one listed" is
 * not "the one they last chose": picking it restored a poster the owner had
 * replaced months earlier. With more than one upload present there is nothing here
 * that can distinguish them, so this returns null and leaves Plex's current choice
 * alone. The recorded-selection path (`candidateToRestore`) is unaffected — it
 * matches an exact image and stays correct however many uploads exist.
 */
export function orphanedUpload(candidates: ArtworkCandidate[]): ArtworkCandidate | null {
  const uploads = candidates.filter((c) => artworkIdentity(c.key)?.startsWith('upload:'));
  if (uploads.length !== 1 || uploads[0].selected) return null;
  return uploads[0];
}
