# B15: `plex-language-apply` — the undo log (the workflow's PRIMARY safety net) is not crash-safe, and success rows reference a file that never exists

**Type**: bug · **Priority**: P2 · **Effort**: S
**Area**: workflows (plex-language-fix)
**Affected files**: `src/workflows/plex-language-fix/stages/apply.ts` (~86, ~100–102, ~119, ~125–128)

## Problem

`plex-language-apply` is the ONLY stage in the repo that mutates an external system (Plex
audio/subtitle defaults via `plexPutStreams`). Its documented safety story is the Plex Butler
backup plus a per-file undo log consumed by `scripts/plex-language-undo.ts`. Three defects:

**(a) Undo log is written once, after the loop.** The mutating `putStreams(...)` runs per file
inside the loop (~86); the applied-changes log is a single `writeFileSync(logPath, …)` AFTER the
loop (~125–128). A crash / SIGKILL / the stage's 1-hour `timeoutMs` firing mid-loop leaves real
Plex mutations applied with **no undo record on disk** — the before-states exist only in the
in-memory `entries[]` array that died with the process. The stated safety mechanism does not
survive the executor's own kill path.

**(b) `detail.path` points at a file that never exists.** Success ledger rows record
`detail: { ..., path: `${appliedLogPrefix}.json`, format: 'json' }` (~100–102), but the file
actually written is `` `${appliedLogPrefix}-${generatedAt.replace(/[:.]/g,'-')}.json` `` (~127).
`applied-log.json` never exists → every applied row's dashboard "View" 404s via
`safeOutputFile`.

**(c) Failed rows never increment `attempts`** (~119) → `MAX_ATTEMPTS = 3` is dead code; a
persistently-failing PUT is retried weekly forever and never surfaces as stuck. (Covered
systemically by B13; listed here for completeness since this stage is the highest-stakes
instance.)

## Proposed fix

1. Compute the final timestamped `logPath` BEFORE the loop, and flush the undo log
   **incrementally**: after each successful `putStreams`, append/rewrite the log with all
   entries so far (the file is tiny — a rewrite per item is fine; JSONL append is the
   alternative). The log on disk must always cover every mutation performed so far.
2. Record that same real `logPath` in each success row's `detail.path` — fixing (b) for free.
3. Use `bumpFailedWorkItem` (B13) on the failure path.
4. Confirm `scripts/plex-language-undo.ts` handles the (unchanged) log format and the
   incremental-write file correctly.

## Acceptance criteria

- Killing the stage after N successful PUTs leaves an undo log on disk covering exactly those N
  files.
- The dashboard "View" on an applied row opens the real log file.
- A file whose PUT fails 3 times stops being retried and appears on the Stuck tile.

## Test plan

`apply.test.ts` exists — extend it: fake `putStreams`, kill (throw) after item 2 of 3, assert
the on-disk log has 2 entries; assert `detail.path` === the actual written filename; attempts
increment test.
