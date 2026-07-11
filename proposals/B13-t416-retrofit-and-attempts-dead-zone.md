# B13: Systemic — retrofit the 6 remaining T416-non-compliant item loops, and fix the `attempts`-never-increments dead zone that disables retry caps and the Stuck tile in 5 jobs

**Type**: bug (systemic) · **Priority**: P2 · **Effort**: M
**Area**: workflows + db
**Affected files**: see tables below; `src/db/store.ts` (`markWorkItem` ~494–546, `isWorkItemDone` ~462, `stuckItems` ~823–825); root `CLAUDE.md` (stale T416 line)

## Problem — part 1: T416 non-compliance

The T416 convention (root CLAUDE.md): an item-loop job must THROW a summarizing error at the end
of its run if any item genuinely failed, so the run is marked failed, downstream stages are
blocked, and `maxRetries` engages. The CLAUDE.md line "no job has been retrofitted yet" is
**stale** — a full audit found most jobs compliant, with these remaining non-compliant loops:

| Job | Evidence | Notes |
|---|---|---|
| `franchise-gaps` (movies) | `franchise-gaps.ts` ~90–92, 121–123: per-item catch logs warn + continues; never throws | also see B16 (quota clobber) |
| `rec-merge` (movies) | `merge.ts` ~165–166: TMDB search failures logged + skipped, no counter, no throw | its documented mirror `tv-rec-merge.ts` ~374–376 THROWS (`searchFailed > 0`) — backport the counter + throw (a transient TMDB blip then retries merge at zero LLM cost via `maxRetries: 2`) |
| `stock-sector-lookup` (stock-digest) | `stock-sector-lookup.ts` ~162, 169: `failed` tallied but run always succeeds | contradicts its own CLAUDE.md |
| `plex-language-discover` | `discover.ts` ~149–151: catch warn+continue, no failed row, no throw | |
| `plex-language-resolve` | `resolve.ts` ~50–57: non-quota errors warn+continue, NO `markWorkItem('failed')` | a systematically-failing file is retried every weekly run forever, invisible |
| `plex-language-evaluate` | `evaluate.ts` ~65–67 same; the "part no longer found" branch (~48–51) also `continue`s forever | |

(`tv-recs-notify` and `stocks-notify` are also non-compliant but are covered by B11/B12 — the
push-failure bugs. The 8 rec-branch stages' never-throw behavior is documented deliberate
resilience — leave as is.)

## Problem — part 2: failed rows never increment `attempts` (retry-cap / Stuck-tile dead zone)

`markWorkItem` defaults `attempts` to **1 and overwrites on every upsert** (`store.ts` ~529:
`attempts: opts.attempts ?? 1`, upsert `attempts = excluded.attempts`). Both
`isWorkItemDone(…, maxAttempts)` and `stuckItems(minAttempts = 4)` require `attempts >=
threshold`. So any job that marks `'failed'` WITHOUT explicitly reading + incrementing prior
attempts (the places/perfumes stages do it correctly) gets: (a) the item retried **forever**,
and (b) the item **never** surfacing on the Stuck tile.

| Job | Site | Consequence |
|---|---|---|
| `stock-sector-lookup` | ~146, 160 | `MAX_ATTEMPTS = 3` is dead code; a dead ticker re-queries Finnhub weekly forever; its CLAUDE.md's "capped, surfaces on the Stuck tile" claim is false |
| `project-summarize` | ~264 | a permanently-broken repo re-clones + re-calls Claude weekly forever |
| `plex-language-apply` | ~119 | a failing PUT retried weekly forever |
| `plex-profiles-build` | ~188 | same class |
| `tmdb-season-check` | ~59, 120 | mitigated (run throws so it's visible), but still never sticks |

(`hevy-sync`'s failure path is unreachable dead code — see B14.)

## Proposed fix

1. **One shared helper** in `src/db/store.ts`:
   ```ts
   export function bumpFailedWorkItem(jobName: string, key: string, detail?: unknown) {
     const prior = getWorkItem(jobName, key)?.attempts ?? 0;
     markWorkItem(jobName, key, 'failed', { attempts: prior + 1, detail });
   }
   ```
   (Or: make `markWorkItem` auto-increment when `status === 'failed'` and `opts.attempts` is
   omitted — but first audit the soft-stop sites that deliberately pass `attempts - 1`.)
   Use it at every `'failed'` call site in the 5 jobs above.
2. **Retrofit the 6 loops**: per-item catch → `bumpFailedWorkItem(...)` with the error message in
   `detail` (fixes the detail-quality gap too: `project-summarize`/`plex-profiles-build`
   currently discard the error) + `failed++`; at end of loop
   `if (failed > 0) throw new Error(\`${failed}/${processed} item(s) failed this run — see logs above\`)`.
   Quota/rate-limit soft-stops remain `'skipped'` (not failures) per the convention.
3. For `rec-merge`: backport tv-rec-merge's `searchFailed` counter + throw verbatim.
4. Update root `CLAUDE.md`'s stale "no job has been retrofitted yet" sentence to describe the
   real state (all item loops compliant; convention enforced going forward).

## Acceptance criteria

- Each retrofitted job: a run with ≥1 genuinely-failed item ends `failed` with a summarizing
  error; quota-pause runs still end `success`.
- A repeatedly-failing item in each of the 5 attempts-dead-zone jobs reaches its cap, stops
  being retried (`isWorkItemDone` true), and appears in `stuckItems()`.
- CLAUDE.md updated in the same change (docs-as-Done).

## Test plan

Unit test `bumpFailedWorkItem` in `store.test.ts`. Per-job: simulate one failing item, assert
run throws + attempts increment across two runs + stuck surfacing at the cap. Existing
green-path tests unchanged.
