# B26: `/admin-cache` is an orphan route — nothing in the app links to it

**Type**: bug (unreachable feature) · **Priority**: P3 · **Effort**: S
**Area**: dashboard
**Affected files**: `dashboard/app/layout.tsx` (~61–67), `dashboard/app/admin/page.tsx`, `dashboard/app/admin-cache/page.tsx` (~94)
**Verified**: coordinator grep found zero references to `admin-cache` in app code outside its own route.

## Problem

The T451/T478 service-cache admin page (per-service `service_cache` row counts + "Clear all
cached responses") is reachable only by typing the URL: the nav has 5 links (no admin-cache),
and `/admin` — its natural parent — has no outbound link, while `admin-cache` itself links back
TO `/admin`. The URL-driven check infrastructure (nav-check/visual-check navigate by URL)
structurally cannot detect orphan routes, which is how this shipped.

Also: `admin-cache/page.tsx:94` uses a raw `<a href="/admin">` — a full-page reload, the exact
bug class nav-check (T427) exists to prevent; should be `<Link>`.

## Proposed fix

- Add a "Service cache →" link/button on `/admin` (the reverse link already exists), or a nav
  item if the owner prefers it top-level.
- Convert the raw `<a>` to `next/link`.
- Optional hardening: a tiny pure test that every route directory under `dashboard/app/` is
  reachable from the link graph rooted at the nav (the PAGES list in `_dashboard-harness.mjs`
  already enumerates routes — cross-check hrefs against it), so future orphans fail a check.

## Acceptance criteria

- `/admin-cache` reachable by clicking from the nav or `/admin`.
- nav-check passes (no full-reload anchors).

## Test plan

nav-check + visual-check after build; the optional reachability test if added.
