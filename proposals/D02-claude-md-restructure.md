# D02: Restructure the root CLAUDE.md — 1,513 lines loaded every session, and its size is why it keeps going stale

**Type**: docs/arch · **Priority**: P2 · **Effort**: M
**Area**: docs
**Affected files**: `CLAUDE.md` (root), new `dashboard/CLAUDE.md`, `src/db/CLAUDE.md`, `src/core/CLAUDE.md`, expanded `src/workflows/CLAUDE.md`, new `docs/DECISIONS.md`

## Problem

The root `CLAUDE.md` is 1,513 lines (~10k words), loaded into context at EVERY session start.
Its Conventions section has become a per-task changelog — full narratives for T098, T112, T135,
T139, T156, T163, T169, T189, T201, T203, T205, T262, T285, T292, T344, T348, T382–T389, T447,
T458, T475, T497, … The file itself recognizes the failure mode: it created per-workflow
CLAUDE.mds precisely "so this root file stays a thin index — do not re-inflate it" — but applied
that discipline only to workflows.

Costs: context burned every session; the load-bearing hard rules (secrets, broker read-only,
commit-push, restart-what-you-changed) buried among UI-styling minutiae; and drift risk — D01's
findings (a self-contradicting Plex count, a stale services list, an entire appearance section
describing removed code) are proof it is already too big to keep honest. The repo's own
mechanism (directory-scoped CLAUDE.mds auto-loaded when working in that directory) is the
proven fix.

## Proposed restructure

Root keeps ONLY (~300 lines target):

- the read-first preamble + docs-as-Done + the non-negotiable hard rules (secrets, broker
  read-only, commit+push, restart-what-you-changed, never-scan-data/);
- what the project is + the 16-workflow index table (one line each, pointing at folder
  CLAUDE.mds);
- the architecture diagram + file map;
- how to add a job/workflow/service (the common request), kept tight;
- ports & gotchas;
- a pointer index to the scoped docs below.

Move, don't delete:

- Dashboard conventions (components, themes, mobile/visual checks, empty states, polling) →
  `dashboard/CLAUDE.md` (auto-loads when editing dashboard files).
- DB rules (store-only SQL, T098 migration rule, ledger/lineage semantics, retention when A01
  lands) → `src/db/CLAUDE.md`.
- Executor/scheduler/gates/cancellation/one-active-run mechanics → `src/core/CLAUDE.md`.
- Job-authoring conventions (T416, progress, detail quality, idempotency variants, services
  usage) → the existing `src/workflows/CLAUDE.md`.
- Historical per-task rationale → `docs/DECISIONS.md`, one short entry per task id, linked by
  id from wherever the rule lives (agents needing the why can read it on demand instead of
  every session).

Sequencing: do D01 (accuracy) FIRST so you're not reorganizing wrong content; then this is
pure moves + a rewrite of the root skeleton.

## Philosophy note (honest)

There's a real tension: the harness and interactive sessions rely on the root file being
exhaustive. The counter-evidence is D01 — exhaustive-and-stale loses to scoped-and-accurate,
and the directory-scoped mechanism already exists and works (the per-workflow files). The
restructure preserves total documentation while making each session load only what it acts on.

## Acceptance criteria

- Root ≤ ~350 lines with every hard rule intact and testable by inspection.
- Every moved section reachable from the root index; nothing deleted.
- A session editing only dashboard files sees the dashboard conventions (auto-load) without the
  DB/core content.
- The harness's loop prompts still get what they need (verify `.harness` prompt assembly reads
  root CLAUDE.md only, and that build tasks touching e.g. `src/db` load the scoped file by cwd).
