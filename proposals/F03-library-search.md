# F03: A query surface for the "second brain" corpora — 500+ structured markdown profiles with no search

**Type**: feature · **Priority**: P1 · **Effort**: L
**Area**: db / api / dashboard
**Backlog cross-ref**: adjacent, not covering — T041 (pending, needs-human: "Decide + wire up where pipeline output goes") is the destination decision; decide the two together.

## Problem

Four workflows explicitly state a *queryable corpus* goal in their own docs — projects-sync
("queryable cross-project 'second brain' corpus"), places ("a queryable local corpus … not just
a raw data dump"), plex-profiles ("kept STABLE … for corpus-wide queryability"), perfumes (same
shape). That's 500+ structured markdown files with uniform frontmatter. Yet the only read paths
are per-item View popovers and the run-scoped Stage I/O panel. **No search, no frontmatter
filtering, no cross-corpus view exists** — the "queryable" half of the product's own goal was
never built. This is also the single most phone-valuable page possible ("what did I say about
that perfume?" from the sofa).

## Design sketch

**Index** — SQLite FTS5, which better-sqlite3 already ships (no new dependency):

```sql
CREATE VIRTUAL TABLE output_index USING fts5(
  workflow, job, item_key, title, frontmatter, body,  -- frontmatter as JSON text
  tokenize = 'porter'
);
```

Populate from the `work_items` ledger's recorded artifact paths (`detail.markdown` /
`detail.path`, stored relative per T447) — the ledger already knows every produced file, so
**no directory scanning** (the never-scan-`data/`-for-code rule is untouched). Reindex a row
when its ledger row changes (hook in `markWorkItem`) plus a full-rebuild admin action.

**API** (read-only, poll-safe):
- `GET /api/library/search?q=&workflow=&key=value` → ranked FTS5 `snippet()` results;
- `GET /api/library/facets` → distinct frontmatter keys/values (themes, domain, type, rating…).
Content itself is served through the EXISTING `safeOutputMarkdown`/`safeOutputFile` guards —
no new file-read surface.

**UI** — new nav tab **Library** (`dashboard/app/library/page.tsx`): search box + per-corpus
filter pills + facet chips; results open the existing markdown modal (via `renderOutputBody`).
Mobile-first layout. Update `_dashboard-harness.mjs` PAGES + fixtures in the same change
(living-artifact rule) and run mobile/visual checks.

## Philosophy check

In-philosophy: local, no new deps, read-only, path-guarded. The main design risk is index
staleness vs `data/out` files edited out-of-band — mitigate with the rebuild action + a
mtime check on serve.

## Acceptance criteria

- Searching a phrase known to exist in a places profile returns it ranked, with a snippet, and
  opens the full profile in the modal.
- Facet filter (e.g. perfumes only) narrows results; phone-width layout passes mobile-check.
- Rebuild action re-indexes the full corpus in seconds (500 docs is trivial for FTS5).

## Test plan

Store-level tests for index/populate/search against fixture markdown; API shape tests;
harness fixtures + visual check for the page.
