# T02: `scripts/` is neither typechecked nor tested (the Plex recovery tool is unguarded), and the test runner has verdict/timeout/collision defects

**Type**: testing · **Priority**: P2 · **Effort**: S–M
**Area**: scripts / test-infra
**Affected files**: `tsconfig.json` (~17), `scripts/run-tests.ts` (~31–42), `package.json` (~14), `scripts/plex-language-undo.test.ts`

## Problem

1. **`scripts/*.ts` invisible to tsc and the test runner.** tsconfig includes only `src/`;
   `run-tests.ts` walks only `src/`. So `npx tsc --noEmit` (locally AND in CI) never typechecks
   the 7 `scripts/*.ts` files — including `plex-language-undo.ts`, the safety-net revert tool
   for the one workflow that MUTATES the owner's Plex server. **`scripts/plex-language-undo.test.ts`
   is a dead test** — never discovered by `npm test` (it passes when run manually today). A
   refactor of `plex-client.ts` or the language-fix types can break the recovery tool while CI
   stays green; the breakage is discovered at the exact moment the tool is needed.
2. **Runner prints its verdict before node:test executes** (empirically reproduced by the
   reviewing agent): ~10+ files use `node:test` `describe/it`, which runs AFTER the serial
   imports resolve — the runner's synchronous `'✓ all tests passed'` can print before failures
   surface (exit code IS still correct, so CI is safe — but a human or log-tailing agent
   reading the last banner is misled, and node:test failures aren't attributed to their file
   banner).
3. **No timeout anywhere** — one hanging `it()` or top-level await hangs `npm test` and CI until
   the 6-hour Actions kill.
4. **Fixed scratch-DB path collides**: `"test": "rm -f /tmp/lj-test.db*; LOCALJOBS_DB=/tmp/lj-test.db …"`
   — two concurrent `npm test` runs (a manual run while the harness loop's DoD check runs — a
   real scenario in this repo) share and mutually DELETE each other's live DB. Ironically the
   in-code `isTestEnv` guard already mints per-PID scratch paths; the npm script bypasses it.

## Proposed fix

1. tsconfig `include: ["src/**/*.ts", "scripts/**/*.ts"]`; run-tests walks
   `[...walk('src'), ...walk('scripts')]` (scripts already use the same NodeNext import idiom;
   the undo test passes today, so low-risk).
2. Print the final verdict from a `process.on('beforeExit')` hook (lands after the node:test
   drain). Better: run each test file as a child process with a per-file wall-clock timeout —
   buys isolation (today 174 files share one process + one scratch DB) AND parallelism (suite
   is 2m06s at 14% CPU, mostly waits; 4-way parallel with per-worker scratch DBs ≈ 40 s).
3. Drop `LOCALJOBS_DB` from the npm script and let `resolveDbPath`'s test-context redirect mint
   the per-PID scratch path (already unit-tested), or `mktemp -d`.

## Acceptance criteria

- Breaking `plex-language-undo.ts`'s imports fails `tsc` and `npm test`.
- A deliberately-failing node:test file → the runner's LAST line is the failure verdict.
- A deliberately-hanging test fails the suite within the per-file timeout.
- Two concurrent `npm test` runs both pass.

## Test plan

Self-demonstrating per criterion; keep the suite's current green state as the regression bar.
