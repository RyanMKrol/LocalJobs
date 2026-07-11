# R06: Four copy-pasted ignore/unignore endpoint families (~330 lines) — already drifted

**Type**: refactor · **Priority**: P3 · **Effort**: S
**Area**: api
**Affected files**: `src/api/server.ts` (~534–870)

## Problem

The movie-gaps / movie-recs / tv-recs / missing-seasons endpoint blocks are structurally
identical — read JSON body → overlay ignored/notified state → ignore / unignore / bulk — hand-
copied with only `(jobName, keyFn, filePath)` varying. They have already drifted: movie-gaps and
missing-seasons have `ignore-bulk`; movie-recs and tv-recs only have `unignore-bulk`. The
missing-seasons 14-line bulk validator is duplicated verbatim (~828–841 and ~853–866).

## Proposed fix

A `registerAuditEndpoints(cfg)` factory (or, with R03's route table, a loop over 4 config
objects):

```ts
const AUDIT_FAMILIES = [
  { base: 'movie-gaps',      job: MOVIE_GAPS_JOB,   key: (p) => gapKey(num(p.id)) },
  { base: 'movie-recs',      job: MOVIE_RECS_JOB,   key: (p) => recKey(num(p.id)) },
  { base: 'tv-recs',         job: TV_RECS_JOB,      key: (p) => recKey(num(p.id)) },
  { base: 'missing-seasons', job: PLEX_SEASONS_JOB, key: (p) => pairKey(num(p.id), num(p.season)) },
];
```

Each family gets the SAME verb set (ignore, unignore, ignore-bulk, unignore-bulk) — closing the
drift as a feature, not a side effect. One shared bulk-body validator.

## Acceptance criteria

- All existing endpoints respond byte-identically (`server.test.ts`'s audit-family cases pin
  this).
- All four families expose all four verbs; the dashboard managers (see R05) can adopt the two
  previously-missing bulk endpoints.
- Net deletion ≥ 200 lines.

## Test plan

Existing audit-endpoint tests green; add the two newly-uniform bulk verbs' tests by copying the
existing family's cases.
