export interface PerfumeInput {
  id: string;            // slug, e.g. "amouage-beach-hut-man"
  name: string;          // "Beach Hut Man"
  concentration: string; // EDP | EDT | Parfum
  brand: string;         // "Amouage"
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
