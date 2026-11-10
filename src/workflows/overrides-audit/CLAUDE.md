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

## Output

A ports stage with one declared output: `report` (`stale-overrides-report`, the JSON file
`data/out/stale-overrides.json`, artifact type in `contracts.ts`). It re-scans fresh every run
and rewrites the file, so a run that returned without writing it fails. There is no ledger:
the weekly row that existed only so the dashboard's Output section had something to list is
gone, and that section now shows the report as an artifact card (latest run, with a "Browse
items" list of the overrides). Runs weekly
(Sundays 07:00, one hour after `plex-space-saver`'s Sunday 06:00 slot to avoid a scheduling
collision).
