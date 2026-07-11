# Proposals — the local-jobs improvement queue

One file per improvement, produced by a full architectural review on 2026-07-11: six parallel
deep-dive agents (core framework · DB + HTTP API · dashboard · all 16 workflows ·
services/scripts/tests/CI/ops · product feature gaps), their ~127 raw findings verified,
deduplicated, and consolidated by a coordinator (the highest-severity claims were independently
re-checked against the code). Each file is a self-sufficient spec: an implementing agent should
be able to work from the file alone, without the original conversation.

**Scope note**: `.harness/` was deliberately excluded — it's plugin-owned
(`implementation-harness`, kept at parity via upgrades) and has its own proposals queue in the
plugin's home repo.

## Ground rules for the implementing agent (read before ANY proposal)

1. **Read first**: the repo-root `CLAUDE.md` in full (it is the session contract — hard rules on
   secrets, the broker read-only constraint, commit+push-as-you-go, restart-what-you-changed,
   docs-as-part-of-Done), plus the folder `CLAUDE.md` of any workflow you touch.
2. **One proposal = one focused commit** (or a small series). Don't bundle proposals; several
   explicitly note sequencing dependencies on others — respect them.
3. **Definition of Done mirrors CI**: `npx tsc --noEmit`, `npm test`, and
   `npm --prefix dashboard run build` for dashboard changes — plus
   `node dashboard/scripts/mobile-check.mjs` and a LOOKED-AT `visual-check.mjs` run for any UI
   surface change, and the living-artifact rule for `_dashboard-harness.mjs`.
4. **Docs are part of every change** — if a proposal alters behavior/commands/conventions,
   update `README.md`/`CLAUDE.md` in the same commit.
5. Line numbers are approximate (repo at 97e1b32 / 801d928-era) — anchor on function names.
6. When a proposal is completed, move its file to `proposals/done/` in the implementing commit.
7. Several proposals intersect the existing harness backlog (task ids cited inline, e.g. T470,
   T477/T479, T467–T469) — check the backlog state before starting those.

## Recommended order

**Now (correctness, silent-loss, safety):**
B03 → B02 → B15 → B16 → B13 (systemic) → B14 → D01
_(B08, B09, B01, B11, B12 captured to the harness ideas inbox — removed from this queue.)_

**Next (high value):**
B19+R04 (one refactor kills the env-bug class) → B07 → B05/B06/B04 → B17 → B20 → B22 → T02 →
T01 → A01 → F02 → F01 → F06 → A02+B10+A03 (the process-lifecycle trio) → A06 → D03

**Then (structural):**
R01 (do after B11/B13 land) → R02 → R05 → R03 → F08 → B18 → F04 → F05 → D02 → A05/A07 →
remaining B2x/Q/R/T by taste

**When wanted (product features):**
F03 (the flagship) → F12 → F11 → F15 → F16 → F07 (gate on T470) → F09/F10/F13/F14

## Index

| ID | Title | Type | Priority | Effort |
|----|-------|------|----------|--------|
| B02 | CSRF + DNS rebinding through the loopback-trust mutation guard | bug | P1 | S |
| B03 | Admin "Delete all output" / "Run all" have no confirmation | bug | P1 | S |
| B04 | `limit`/`after`/`windowHours` unvalidated: NaN→500, negative→full dump | bug | P2 | S |
| B05 | `resolveBulkScope` silently escalates unknown scope to `all` | bug | P2 | S |
| B06 | `readBody` maps malformed JSON to `{}` → destructive defaults; no size cap | bug | P2 | S |
| B07 | Service-limits endpoint: absent field ⇒ NULL ⇒ paid caps silently removed | bug | P2 | S |
| B10 | Timeout/cancel kills only the direct child — Chrome/claude/git orphaned | bug | P2 | S |
| B13 | Systemic: T416 retrofit (6 loops) + attempts-never-increment dead zone (5 jobs) | bug | P2 | M |
| B14 | hevy-sync marks synced before persisting — permanent silent data loss window | bug | P2 | S |
| B15 | plex-language-apply undo log not crash-safe + broken detail.path | bug | P2 | S |
| B16 | franchise-gaps quota-hit overwrites the gaps report with an empty one | bug | P2 | S |
| B17 | `inputKeys()` throw/hang before the run row exists → invisible failure / stuck claim | bug | P2 | S |
| B18 | Service quota check-then-act race across processes | bug | P2 | S |
| B19 | Unvalidated numeric env vars: NaN uncaps paid services, `''` bricks them | bug | P2 | S |
| B20 | Dashboard Run/toggle failures invisible; Overview ignores running state | bug | P2 | S |
| B21 | Date-parse convention violations (Safari Invalid Date; raw UTC shown) | bug | P2 | S |
| B22 | Output section can't preview non-markdown artifacts; fixture lies about it | bug | P2 | S |
| B23 | Core small-bug batch (noop labels, cache edges, plex cache, NDJSON, stall break) | bug | P3 | M |
| B24 | Second daemon reaps live runs before failing on the port | bug | P3 | S |
| B25 | Duplicate service names silently last-writer-win | bug | P3 | S |
| B26 | `/admin-cache` is an orphan route | bug | P3 | S |
| B27 | API small-bug batch (TOCTOU, HTTP semantics, markWorkItem atomicity) | bug | P3 | S–M |
| B28 | Workflow small-bug batch (month label, slug collision, un-timed fetches) | bug | P3 | S |
| A01 | Retention & housekeeping (runs/logs/usage/cache/WAL/launchd logs/clones) | arch | P2 | M |
| A02 | Graceful shutdown: drain + cancel instead of instant exit | arch | P2 | S |
| A03 | PID tracking so orphan reaping can kill surviving children | arch | P2 | S |
| A04 | Retry backoff (currently zero-delay, timeouts retried identically) | arch | P3 | S |
| A05 | Polling N+1: ~150 statements + 16 DAG builds per 5s tick; missing indexes | arch | P3 | M |
| A06 | Incremental log polling — the `after` cursor exists and is never used | arch | P2 | S |
| A07 | `setProgress` write amplification (roll-up that can't change anything) | arch | P3 | S |
| R01 | Shared recommender pipeline — movies↔tv-recs ~1,300 duplicated lines | refactor | P1 | L |
| R02 | Unify the Claude-CLI helper (3 copies; 2 bypass the editable timeout) | refactor | P2 | M |
| R03 | store.ts domain split + server.ts route table | refactor | P2 | L |
| R04 | `defineService` helper (16 near-identical files; kills the env-bug class) | refactor | P2 | M |
| R05 | Dashboard manager dedup (~740 copy-pasted lines, 14× handler block) | refactor | P2 | M |
| R06 | Audit ignore/unignore endpoint factory (4 drifted copies) | refactor | P3 | S |
| R07 | Small-utility dedup (weekKey ×3, JSON helpers ×4, PlexAllResponse ×5…) | refactor | P3 | S |
| R08 | Dead-code sweep (standalone-job path, DB browser, MarkdownModal, dead CSS…) | refactor | P3 | S–M |
| Q01 | Schema comment drift + stale-cols migration fragility (latent T098 repeat) | quality | P3 | S |
| Q02 | Hardening niceties (timingSafeEqual, LIKE escape, route listing, error slicing) | quality | P3 | S |
| Q03 | Dashboard a11y: keyboard-unreachable editors and sort headers | quality | P3 | S |
| Q04 | usePoll hardening + daemon-down blank detail pages | quality | P3 | S |
| Q05 | Dashboard nits batch (fmtDuration hours, StatusBadge widening, encoding…) | quality | P3 | S |
| Q06 | launchd installer hygiene (baked node path, stale comment) | quality | P3 | S |
| Q07 | Workflow convention cleanups (rootAllowed, empty IO panels, rate-limit handling, one real gate) | quality | P3 | M |
| T01 | Dashboard tests never run in CI or `npm test` | testing | P2 | S |
| T02 | `scripts/` untypechecked/untested; runner verdict/timeout/collision fixes | testing | P2 | S–M |
| T03 | CI gaps: dashboard npm cache, npm audit, Node pinning | testing | P3 | S |
| D01 | Doc-accuracy batch (19 verified stale claims incl. README missing a workflow) | docs | P1 | S–M |
| D02 | Root CLAUDE.md restructure (1,513 lines → thin root + scoped files) | docs | P2 | M |
| D03 | `.env.example` backfill (both paid-service keys undocumented) | docs | P2 | S |
| F01 | Startup env/secrets validation for enabled workflows | feature | P1 | M |
| F02 | Backup & restore story (online snapshots, rotation, off-box, restore doc) | feature | P1 | M |
| F03 | Library search over the second-brain corpora (FTS5) | feature | P1 | L |
| F04 | Missed-schedule catch-up after reboot/restart | feature | P2 | M |
| F05 | Service usage trends + proactive spend alerts | feature | P2 | M |
| F06 | Watchdog & health alerting (crash pushes, staleness detector, heartbeat agent) | feature | P2 | M |
| F07 | Cross-workflow "month in review" digest (gate on T470) | feature | P2 | M |
| F08 | Workflow-level timeout (reuses the cancel machinery) | feature | P2 | S |
| F09 | Global concurrency ceiling across workflows | feature | P3 | S |
| F10 | Manual single-stage run (largely mitigated; residual verify-a-fix gap) | feature | P3 | M |
| F11 | Upcoming-runs timeline on Overview | feature | P3 | S |
| F12 | Duration baseline + live elapsed on running runs | feature | P3 | S |
| F13 | new-workflow scaffolder (honestly low value; conditional) | feature | P3 | S |
| F14 | Notification quiet hours + overnight batch | feature | P3 | S |
| F15 | Dashboard UX batch (toggle feedback, log tail, run-log search, stage-io fan-out) | feature | P3 | S–M |
| F16 | Per-workflow improvements (TMDB collection cache, no-GUID ignore, capped-recs memory, re-evaluate tool) | feature | P3 | S–M |

## Cross-cutting observations (from the review, for context)

- **The orchestrator core is markedly more mature than the appliance layer around it**: gates,
  ledgers, cancellation, overrides, and spend governance are strong; but nothing validates
  config at boot (F01), nothing backs up state (F02), nothing notices silence (F04/F06), and
  the flagship "queryable second brain" output has no query surface (F03).
- **Copy-paste is the dominant defect factory**: the movies↔tv-recs duplication directly
  produced B11 and the B13 merge divergence; the four dashboard managers and four API endpoint
  families have already drifted the same way. R01/R04/R05/R06 are bug-prevention as much as
  cleanup.
- **Silent failure is the recurring theme of the worst bugs**: notified-but-never-sent (B11,
  B12), marked-but-never-persisted (B14), succeeded-but-empty (B16), reported-ok-but-deleted-
  nothing (B01), and the attempts dead zone (B13). The repo's own loud-failure philosophy is
  right; these are the places it wasn't applied.
- **Several agents verified strengths worth preserving**: parameterized SQL throughout, genuinely
  solid path-traversal guards, atomic rate-limit reservations, a robust test-DB isolation guard,
  hermetic dashboard checks, and clean secrets handling. No P0/P1 finding involved data
  corruption or secret leakage.
