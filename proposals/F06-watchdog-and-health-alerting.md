# F06: Watchdog & health alerting — the daemon monitors everything except itself, and a silently-stale workflow looks identical to a healthy quiet one

**Type**: feature · **Priority**: P2 · **Effort**: M
**Area**: core / scripts / dashboard
**Backlog cross-ref**: adjacent — T062 (pending, needs-human) is a daily *log-review* self-inspection: a quality reviewer, not a liveness watchdog. This is the mechanical half. Found independently by two agents.

## Problem

launchd restarts a *crashed* daemon — silently, forever, throttled. The repo has ALREADY had
this failure: the T098 schema bug "crash-loops the daemon at startup" (CLAUDE.md's own words) —
the only symptom is jobs quietly not running and a growing `daemon.err.log`. The push model
makes it worse: **absence of failure pushes is indistinguishable from absence of runs** — the
classic unattended-appliance trap. The documented real failure modes are silent-wrong, not
crashed: the registry-shadowing incident (workflows running stale cloned code while "reporting
success"), stuck schedules, ntfy itself unreachable. Nothing computes "workflow X hasn't
succeeded in N× its schedule interval". The ntfy plumbing to alert exists (`notifier.ts`) and is
unused at daemon level.

## Design sketch — three independent, cheap layers

1. **Crash-restart push (in-daemon)**: in `main()`, if `reapOrphanRuns() + reapOrphanWorkflowRuns()`
   reaped > 0 → one ntfy push "daemon restarted after crash — reaped N orphaned runs" (the
   evidence is already computed; A02 makes deliberate restarts reap nothing, keeping this
   signal clean). Plus `process.on('uncaughtException')` (B09) sends one push before exiting.
   Crash-LOOP detector: persist a boot timestamp (tiny file or DB row); ≥3 boots in 5 min → one
   "crash-looping" push (ntfy backoff already dampens storms).
2. **Staleness detector (in-daemon, hourly)**: for each enabled scheduled workflow, if
   `now − last success > staleFactor × cron interval` (factor 2; interval derived from croner's
   next/previous fire delta) → mark stale: amber pill on the Workflows list + an Overview tile +
   ONE ntfy push per stale episode (dedup via the repo's own T144 "have I notified this?"
   ledger pattern). Catches schedule bugs, perpetual-failure loops, and shadowed-code no-ops.
3. **External heartbeat (covers the daemon itself — must live outside it by definition)**: a
   third tiny launchd agent (`scripts/install-watchdog-launchd.sh`, mirroring the existing two)
   running a ~15-line shell script every 10 min:
   `curl -fsS 127.0.0.1:4789/api/health || ntfy "daemon down"` with a cooldown file. launchd is
   already the accepted supervision dependency; no new infra.

## Acceptance criteria

- Kill -9 the daemon mid-run → next boot pushes the crash-restart message once.
- A workflow whose schedule stops firing (disable its cron in a test double) goes amber within
  2× its interval and pushes once, not hourly.
- Stopping the daemon → the watchdog agent pushes "daemon down" within 10 min, once per
  cooldown window.

## Test plan

Unit: staleness math over fake schedule/last-success pairs; episode dedup. Manual on the Mini:
the watchdog agent end-to-end. Docs: README ports/services table gains the third agent (docs-as-
Done).
