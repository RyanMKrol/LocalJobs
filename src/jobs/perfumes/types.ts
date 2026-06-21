export interface PerfumeInput {
  id: string;            // slug, e.g. "amouage-beach-hut-man"
  name: string;          // "Beach Hut Man"
  concentration: string; // EDP | EDT | Parfum
  brand: string;         // "Amouage"
}

/** What each stage reports back to the orchestrator. */
export interface StageResult {
  ok: number;          // items completed this run
  failed: number;      // items that failed (will retry unless out of attempts)
  pending: number;     // items still eligible (not done, not stuck) AFTER this run
  rateLimited: boolean; // a Claude rate/usage limit was hit — back off, don't give up
}
