# B25: Duplicate service names silently last-writer-win — lookup, enforcement, and DB seeding can disagree

**Type**: bug (latent) · **Priority**: P3 · **Effort**: S
**Area**: services / registry
**Affected files**: `src/workflows/registry.ts` (~93–107), `src/core/services.ts` (~18–25)

## Problem

Workflows have a duplicate-name guard (logs "invalid — skipped: duplicate workflow name"); jobs
got the whole data/-shadowing hardening; **services got neither**. The registry pushes every
discovered def into `loadedServices` AND calls `registerService` (a `Map.set` — silent
overwrite). Since a private workflow MAY colocate a `*.service.ts` (a documented, supported
pattern), a name collision with a top-level service gives three different answers for "what are
this service's limits":

- `callService`/`getServiceDef` enforces the LAST-sorted file's limits (Map overwrite);
- registry `getServiceDefinition` returns the FIRST (`Array.find` over `loadedServices`);
- the DB row's seeded limits are whichever `syncService` ran last.

A collision on a paid service name (someone adds a private `gemini.service.ts` with laxer caps)
silently changes the effective spend governor with no warning anywhere.

## Proposed fix

Mirror the workflow guard in the registry's service loop: on a duplicate name, either skip +
loud warn, or — better, matching the orphan-job fail-loud convention — **throw at load** so the
daemon refuses to start. Also make lookup and enforcement read from the same structure so they
cannot disagree.

## Acceptance criteria

- Two `*.service.ts` files exporting the same `name` → daemon refuses to start (or one is
  deterministically ignored with a loud warning naming both file paths — pick one; fail-loud
  recommended).
- `registry.test.ts` covers the duplicate case.

## Test plan

Extend the registry test suite with a synthetic duplicate-service fixture (temp-dir pattern
already exists in `registry-find-files.test.ts`).
