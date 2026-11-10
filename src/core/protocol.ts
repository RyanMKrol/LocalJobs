/**
 * The child-protocol version: what the daemon tells each child it can do (as
 * `LOCALJOBS_ENGINE`) and what a child needs in order to run.
 *
 * Children are spawned with `tsx` straight from the checkout, so a child always
 * runs the code currently on disk, while the daemon keeps the code it started
 * with until restarted. When the two are out of step a stage must fail with a
 * clear instruction rather than half-work, hence a version it can compare.
 *
 *   2  run identity env (run id, attempt, cycle, workflow name, trigger)
 *   3  ports: the daemon resolves a stage's inputs before spawning it and
 *      verifies its declared outputs afterwards
 */
export const ENGINE_PROTOCOL = 3;

/** The lowest daemon protocol a ports stage can run under. */
export const PORTS_MIN_PROTOCOL = 3;
