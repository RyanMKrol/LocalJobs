# T01: Dashboard tests never run anywhere — three well-written suites are dead weight

**Type**: testing · **Priority**: P2 · **Effort**: S
**Area**: dashboard / ci
**Affected files**: `scripts/run-tests.ts` (~30: `walk('src')` only), `.github/workflows/ci.yml`, `dashboard/package.json` (no `test` script); orphaned: `dashboard/app/components/StageIoLists.test.ts`, `dashboard/app/components/OutputRenderer.test.ts`, `dashboard/scripts/nav-check.test.ts`

## Problem

Three real test files exist in the dashboard tree, and **nothing invokes them**: `npm test`
walks only `src/`, CI runs only `npm ci` + `next build` for the dashboard, and
`dashboard/package.json` has no `test` script. A regression in `detailHints`, the
OutputRenderer format dispatch, or SPA navigation ships green today.

Also untested pure logic worth covering (grep-verified no test references): `cronToEnglish`,
`resolveMode`, `backFrom`, `fmtDuration`/`fmtRelative`, `parseFrontmatter`.

## Proposed fix

1. Add a `test` script to `dashboard/package.json` running the two pure component suites (they
   need no browser); wire it into root `npm test` (or extend `run-tests.ts` to walk
   `dashboard/app` for `*.test.ts`) and into CI after the dashboard build.
2. `nav-check.test.ts` needs Playwright → keep it local-only alongside mobile/visual-check;
   document that split where the checks are documented.
3. Add the missing pure-helper tests (cheap, high-value under the B21/Q05 helpers work).

## Acceptance criteria

- Breaking `OUTPUT_RENDERERS` dispatch or `detailHints` fails `npm test` and CI.
- CI time increase negligible (pure Node tests).

## Test plan

Self-demonstrating: land, then verify a deliberate local breakage fails the suite.
