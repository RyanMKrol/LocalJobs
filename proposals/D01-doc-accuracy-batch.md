# D01: Doc-accuracy batch — every verified stale claim across README, root CLAUDE.md, workflow CLAUDE.mds, and code comments

**Type**: docs · **Priority**: P1 (this repo treats stale docs as bugs) · **Effort**: S–M
**Area**: docs
**Sources**: four review agents independently verified each item against code.

## README.md

1. ~Line 164: says "**Thirteen** worked examples" — it lists 15 and there are 16;
   **`plex-language-fix` is entirely absent from the README's workflow list** despite being the
   most consequential workflow in the repo (the only one that mutates an external system).
2. ~Line 315: nav documented as "Overview · Workflows · Services · **Database** · **Backlog**" —
   the Database page was removed (T230), "Services" is now **Integrations** (T335/T361), Backlog
   moved to the harness dashboard on :4791. The real app has `logs/`, `admin/`, `admin-cache/`,
   `integrations/` pages the README never mentions.
3. ~Lines 217–221: claude-warmer documented as "every 30 minutes (`*/30 * * * *`)" — the
   manifest is `'0 8,16 * * *'` (twice daily; root CLAUDE.md has it right). README describes 48
   runs/day for a 2-runs/day workflow.

## Root CLAUDE.md

4. Self-contradiction: one line says the shared plex-client serves "all 6 Plex-touching
   workflows", another still says "all 4". Six is correct.
5. The file map's services line still enumerates "gemini, google-places, fragrantica,
   claude-cli" — there are 16 services.
6. Service `category` controlled vocabulary (T305) says `'cli-tool' | 'website-scrape' | 'api'`
   (also in `types.ts` ~281–283) — but `fs.service.ts` ships `category: 'local'` (asserted by
   its own test), `vercel` is a second unlisted `'cli-tool'`, and finnhub/plex/fs/vercel are
   absent from the enumeration. Update the vocabulary AND the types comment.
7. The T416 line "no job has been retrofitted yet" is stale — most item loops ARE compliant
   (see B13 for the real state).
8. **Theme/appearance section is badly stale vs shipped code** (T308/T309 landed after it was
   written): docs describe 3 `data-theme` families + a family switcher, 3 `data-font` options,
   `data-motion="reduced"`, and an "untouched default = pre-T142 plain-dark" invariant. Code:
   hardcoded sunny-8bit + Baloo 2; the only control is the dark/light/system mode cycler; Space
   Mono not loaded; no `data-theme`/`data-font`/`data-motion` written anywhere. Echoes:
   `ui.tsx` ~27–30 claims status emoji are hidden except on joyful themes — they're always on;
   CLAUDE.md documents `<MarkdownModal>` as a live shared component — it's dead code (R08).
9. The architecture section's "the parent is the sole DB writer" claim is false as stated —
   children write `work_items`, `work_item_runs`, `service_usage`, `service_consumers`,
   `service_cache` directly by design. State the true, narrower invariant: *the parent is the
   sole writer of the runs/logs/workflow tables* (this mis-claim actively misleads agents into
   assuming single-writer semantics — see B09/B18).

## Workflow CLAUDE.mds / code comments

10. `movies/CLAUDE.md` + `merge.job.ts` description: claim rec-merge appends recs-history —
    history is appended by **movie-gaps-notify** after a successful push.
11. `perfumes/CLAUDE.md`: "success path saves page *text*… pct only populated when an
    `<id>.html` capture exists" — stale since T072: `fetch.ts:61` writes `<id>.html` on EVERY
    success precisely so parse fills pct. (Also fix the matching stale row in
    `.harness/custom/docs/LIMITATIONS.md` if the owner agrees — it records the pre-T072 state.)
12. `claude-warm.job.ts` ~13–15 description says "every 30 minutes" (renders on /jobs and every
    run page).
13. `stock-digest/CLAUDE.md`: "an unresolved lookup is recorded 'failed' so it retries (capped,
    surfaces on the Stuck tile)" — false today (B13's attempts bug); fix the CODE (B13) and keep
    the doc.
14. `places/stages/ingest.job.ts:29` error text references pre-rename `places-data/out/…` path;
    `enrich.job.ts:8` says "scheduled weekly" while the same file says daily.
15. `stocks-resolve-names.ts` ~17–19: "T414 will consolidate this" — T414 landed.
16. `services/claude.ts` header + perfumes CLAUDE.md point at `.harness/docs/LIMITATIONS.md`
    for the perfumes migration note — no such entry exists there; re-point (or add the row).
17. `github.service.ts:6`: "We fetch repos infrequently (daily)" — projects-sync is weekly; this
    comment is the documented rationale for the caps.
18. `.gitignore` fossils: a fully duplicated harness-scratch block (hand-written entries ~60–75
    repeat verbatim inside the managed block) and the root `/plex-language-fix/` scratch entry
    whose justification is stale (the workflow has lived tracked under `src/workflows/` for a
    while).
19. `.env.example` AWS comment says "Region: e.g. us-east-2" while `dynamodb.service.ts`
    defaults `eu-west-1`.

## Proposed approach

One (or two) doc-sweep commits, each item verified against code at fix time (code wins; where
the CODE is the wrong side — items 13 — the paired code proposal fixes it and the doc stays).
Items 1–3 + 8 are the owner-visible ones; do them first.

## Acceptance criteria

Every claim above either fixed or consciously rejected with a note; README workflow table lists
all 16; a fresh reader of the appearance section finds code and docs agreeing.
