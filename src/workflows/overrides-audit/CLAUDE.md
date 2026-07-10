# CLAUDE.md — src/workflows/overrides-audit/

A single-stage, report-only audit of every dashboard override currently set across
services/workflows/jobs — distinct from `plex-space-saver` (disk usage) and
`missing-tv-seasons` (Plex content), but built to the SAME shape: plain SQLite reads, no
LLM, no API/scrape calls, weekly cron.

## Why this exists

Five `_overridden` flags exist so a dashboard edit can take ownership of a value away from
its manifest/service-definition code default (see root `CLAUDE.md`'s many "user-editable +
code-reconciled" conventions): `services.limits_overridden`,
`workflows.schedule_overridden`, `workflows.max_concurrency_overridden`,
`workflows.notify_enabled_overridden`, `jobs.timeout_ms_overridden`. Once set, that override
persists in SQLite **forever** — nothing ever prompts the owner to fold a stable override
back into code and clear the flag. This workflow is that reminder mechanism.

## What it does

`overrides-audit-scan` (the only stage — no DAG edge, no gate needed) calls
`listStaleOverrides(minAgeMs)` in `src/db/store.ts`, which reads every row across
`services`/`workflows`/`jobs` with an `_overridden = 1` flag and returns it if its matching
`_overridden_at` timestamp (T475) is either `NULL` ("unknown age — set before this column
existed, or by some future path that doesn't stamp it") or at least `minAgeMs` old. The
threshold is 2 weeks (`overridesAuditConfig.minAgeMs`, `config.ts`). The stage writes a JSON
report (`data/out/stale-overrides.json`) naming each stale override's table/row/field,
current value, and human-readable age, logging every row as it goes.

**Report only — never patches anything.** No push notification, no write to
`.harness/tracking/IDEAS.jsonl`, and no automated edit of any manifest/service-definition
file. Folding an override into code and clearing its `_overridden` flag stays a fully manual
step the owner does by hand (there is currently no "reset to code default" action anywhere in
the dashboard — see the comment in `src/db/index.ts`'s T475 migration for where one would
clear `_overridden`/`_overridden_at` together if that's ever added).

## Idempotency + output form

Re-scans fresh every run (an audit, not a build); idempotent per ISO calendar week via the
`work_items` ledger (`weekKey`, mirrors `plex-space-saver`/`stock-digest`) — a manual re-run
the same week regenerates that week's report instead of duplicating it. The ledger row
records `detail.format: 'json'` + `detail.path` pointing at the report, served through the
unified Output section's `safeOutputFile` guard (T262/T282) — no dedicated dashboard viewer
needed, it renders via the generic JSON/raw fallback (`OutputRenderer.tsx`). Runs weekly
(Sundays 07:00, one hour after `plex-space-saver`'s Sunday 06:00 slot to avoid a scheduling
collision).
