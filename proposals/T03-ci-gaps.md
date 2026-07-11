# T03: CI gaps — dashboard npm cache path, `npm audit`, Node version pinning

**Type**: testing/ops · **Priority**: P3 · **Effort**: S
**Area**: ci
**Affected files**: `.github/workflows/ci.yml`, `package.json`, new `.nvmrc`

## Problem

CI correctly runs the documented Definition of Done (verified: `npx tsc --noEmit`, `npm test`,
dashboard `npm ci` + build, with concurrency-cancel). Three cheap gaps:

1. `setup-node`'s `cache: npm` keys on the ROOT lockfile only — the dashboard's `npm ci`
   re-downloads its entire tree every run.
2. No `npm audit`/Dependabot anywhere — for a repo running a LAN-exposed web server on an
   always-on box, staying current matters (spot-check found Next 15.5.19 safely past the 15.x
   middleware-bypass CVE; better-sqlite3/playwright current-ish — this is about staying that
   way).
3. Node pinned only in CI (22). Local happens to match; the launchd plists bake a node path at
   install time (Q06) — three environments can silently diverge.

## Proposed fix

1. `cache-dependency-path: ['package-lock.json', 'dashboard/package-lock.json']`.
2. Add `npm audit --omit=dev --audit-level=high` for both package roots (non-blocking warn or
   blocking — owner's call; blocking recommended at `high`).
3. `"engines": { "node": ">=22 <23" }` in both package.jsons + a `.nvmrc` with `22`.

## Acceptance criteria

- CI dashboard-install step hits the cache on unchanged lockfiles.
- A `high` advisory in prod deps fails (or loudly annotates) CI.
- `npm install` under Node 21 warns/refuses per engines.
