# D03: `.env.example` backfill — the credentials for BOTH paid services are undocumented, plus ~15 real knobs

**Type**: docs/config · **Priority**: P2 · **Effort**: S
**Area**: config
**Affected files**: `.env.example`, README (pointer lines)

## Problem

Diffing every `process.env.X` reference in `src/` + `scripts/` against `.env.example`
(test-internal vars excluded) found these missing — headlined by **`GEMINI_API_KEY` and
`GOOGLE_MAPS_API_KEY`, the credentials for BOTH paid services**. The code even throws
`'GEMINI_API_KEY is not set. Add it to .env (see README — places workflow)'` — and neither the
README nor `.env.example` mentions the var (grep: zero hits). A machine migration or fresh
clone has no way to discover these except by running into the throw.

Also missing: `GEMINI_RATE_PER_MIN`, `GEMINI_MODEL`, `GEMINI_THINKING_LEVEL`,
`PLACES_LLM_*` / `PLACES_ENRICH_*` / `PLACES_RESOLVE_*` caps, `PLACES_RATE_PER_MIN`,
`HEVY_{RATE_PER_MIN,DAILY_CAP,MONTHLY_CAP}`, `DYNAMODB_*` caps, `TRADING212_INSTRUMENTS_*`,
`LOCALJOBS_NTFY_BACKOFF_{BASE,CAP}_MS`, `PERFUMES_*` (a dozen), `TV_RECS_*`,
`LISTENS_TABLE`/`PROJECTS_TABLE` (pending R08's verdict on the dead dynamo script).

Contrast: the newer FINNHUB/OPENFIGI/TRADING212/VERCEL vars ARE fully documented — the
update-as-you-go rule works going forward; the older vars were never backfilled.

## Proposed fix

One doc pass on `.env.example` (placeholders only — the repo is public):

- a `## places workflow (paid)` block with both key placeholders + commented cap overrides;
- ntfy backoff + hevy/dynamodb/trading212-instruments lines in their existing sections;
- per-workflow tuning knobs as ONE commented pointer line each to the workflow's own CLAUDE.md
  (don't bloat the example with a dozen perfumes knobs — point at where they're documented).

Add the same env-var names to the README's places section (the error message promises they're
there). Cross-ref: F01 (startup validation) makes missing REQUIRED vars loud at boot;
this proposal makes them discoverable before boot.

## Acceptance criteria

- Every `process.env.*` read in `src/`+`scripts/` is either in `.env.example`, covered by a
  pointer line, or consciously excluded (test-internal); a repeat of the diff comes back clean.
- No real values committed (placeholders only; the pre-push guard stays happy).
