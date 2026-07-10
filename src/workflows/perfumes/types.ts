export interface PerfumeInput {
  id: string;            // PerfumeRatings item id, e.g. "altha-r__parfums-de-marly__edp"
  name: string;          // "Beach Hut Man"
  concentration: string; // EDP | EDT | Parfum
  brand: string;         // "Amouage"
  /** Present when the source PerfumeRatings item already has a Fragrantica URL
   *  recorded (T401) — find-url seeds from this instead of asking Claude. */
  fragranticaUrl?: string;
  /** Owner's free-text notes on the perfume, from Dynamo's `description`. */
  description?: string;
  /** The owner's own score, halved from Dynamo's raw 0-10 `rating` to a 0-5
   *  scale (by `loadPerfumes`) so it lines up with Fragrantica's 0-5
   *  `community_rating`. Maps to the template's `personal_rating` frontmatter
   *  key (not `rating` — the property here keeps its original name for now). */
  rating?: number;
  /** Raw `DD-MM-YYYY` string, from Dynamo's `date` — passed through verbatim.
   *  Maps to the template's `personal_date_added` frontmatter key. */
  dateAdded?: string;
  /** From Dynamo's `ownership`. Maps to the template's `personal_ownership`
   *  frontmatter key. */
  ownership?: 'Sample' | 'Travel size' | 'Full bottle';
  /** 0-8, from Dynamo's `longevity`. `personal`-prefixed so it's never confused
   *  with the template's community-vote-derived `longevity` enum field. */
  personalLongevity?: number;
  /** 1-4, from Dynamo's `projection`. */
  personalProjection?: number;
  /** From Dynamo's `seasons`. `personal`-prefixed so it's never confused with
   *  the template's community/LLM-researched `season` array field. */
  personalSeasons?: string[];
  /** From Dynamo's `applicationSpots`. */
  applicationSpots?: string[];
}

/** One "main accord" with its relative strength. `pct` is the coloured bar's
 *  width on the Fragrantica page (strongest accord = 100); null when the page
 *  shows the accord but no measurable bar, or no HTML was cached to read. */
export interface Accord {
  name: string;
  pct: number | null;
}

/** What each stage reports back to the orchestrator. */
export interface StageResult {
  ok: number;          // items completed this run
  failed: number;      // items that failed (will retry unless out of attempts)
  pending: number;     // items still eligible (not done, not stuck) AFTER this run
  rateLimited: boolean; // a Claude rate/usage limit was hit — back off, don't give up
}
