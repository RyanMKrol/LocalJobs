# Q01: Schema comment drift + latent migration fragility (a stale-columns pattern that will eventually reproduce the T098 crash-loop)

**Type**: quality · **Priority**: P3 · **Effort**: S
**Area**: db
**Affected files**: `src/db/schema.sql` (~19–20), `src/db/index.ts` (~35–155)

## Problem

1. **Comment drift**: `schema.sql:19` enumerates `runs.status` values without `'skipped'`
   (written by `recordSkippedRun`/`setRunNoop`), and `:20` enumerates `trigger` without
   `'workflow'` (written by skip/gate rows). Comment-only, but these enumerations are what a
   reader trusts.
2. **Stale column arrays**: `index.ts` reads `svcCols`/`wfCols`/`jobCols` **once** (lines
   ~42/75/117) and keeps consulting those arrays after intervening `ALTER TABLE`s (e.g. `wfCols`
   from line 75 is still used at line 153). Correct today only because every migration touches a
   distinct column name — the day two migrations touch the same column, the stale check produces
   a duplicate `ALTER` → throw → **daemon crash-loop at startup**, the exact T098 failure mode
   the repo already shipped once.
3. 15+ inline migration blocks with no `PRAGMA user_version` stamp — fine at this scale, but
   worth a numbered-array structure before it doubles.

## Proposed fix

1. Fix the two schema comments.
2. Replace the cached arrays with a per-check helper:
   `hasColumn(db, table, col) => db.prepare(\`SELECT 1 FROM pragma_table_info(?) WHERE name=?\`)…`
   — always-fresh, trivially cheap at startup.
3. Optional: restructure migrations into a numbered array
   `const MIGRATIONS: Array<{ id: number; up(db): void }>` gated on `PRAGMA user_version` —
   keeps additive semantics, makes ordering explicit. (Judgement call; the `hasColumn` fix alone
   removes the sharp edge.)

## Acceptance criteria

- `migrate-existing-db.test.ts` still passes against a pre-seeded old-shape DB.
- A synthetic double-migration touching the same column (test-only) no longer throws.

## Test plan

Extend the existing migration regression test with the same-column double-ALTER scenario.
