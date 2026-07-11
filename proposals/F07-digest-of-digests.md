# F07: A cross-workflow "month in review" digest — the most owner-valuable artifact the dataset could produce, currently impossible by rule

**Type**: feature · **Priority**: P2 · **Effort**: M · **⚠ Philosophy tension — gate on backlog T470**
**Area**: workflows (new)
**Backlog cross-ref**: T470 (pending, needs-human — "Evaluate whether the framework should gain a cross-workflow job-sharing mechanism") is the gatekeeper decision. No task covers the digest itself.

## Problem

The system produces, monthly/weekly: a listening digest (+3-month trend), workouts progress, a
stock digest, movie recs + franchise gaps, TV recs, missing seasons, a projects catalog — each
sealed in its own `data/out/` silo with its own push. There is no "month in review": one
narrated roll-up across listening / training / portfolio / media. Narration-over-structured-
facts is the repo's established pattern (stock-digest, workouts-progress) — this is the same
pattern one level up.

**The tension is real and must not be dodged**: `stock-digest/CLAUDE.md` enshrines "No
inter-workflow dependency — do not read another workflow's output file". A digest-of-digests
must NOT be built by quietly violating that rule. The rule's rationale (don't couple fetch
logic across workflows) doesn't cleanly apply to a pure aggregator whose entire semantic is
"read the finished artifacts" — but that's the owner's call, and T470 is exactly that decision.
Decide T470 first; this proposal is the worked design for the "yes, via a blessed mechanism"
answer.

## Design sketch (post-T470)

Workflow `monthly-review` (monthly, ~3rd at 09:00 so all 1st-of-month producers have finished;
category `second-brain`):

1. Manifest declares `aggregates: ['listening-digest', 'workouts-sync', 'stock-digest',
   'movie-recommendations', 'tv-recommendations']` — an **explicit, framework-visible
   declaration** (the blessed mechanism T470 would define), not a buried file path. The
   framework resolves each producer's trailing-month artifacts via the existing
   `workflowTerminalItems` + output-path machinery — read-only, through the same safety guards.
2. Stage 1 (code, no LLM): gather + trim facts per producer into one JSON context; missing
   producers honestly noted, never invented.
3. Stage 2: `runClaude` narrates `data/out/monthly-review-<YYYY-MM>.md`; idempotent per month
   (month-key ledger). Gates between the stages assert the context shape.
4. Optionally, this ONE push replaces several per-producer pushes (pairs with F14's
   notification shaping) — owner's call per producer via the existing notify toggles.

## Acceptance criteria

- T470 decided "yes" with the `aggregates` mechanism (or this proposal is closed as rejected —
  a legitimate outcome).
- A run with all producers present yields one narrated file + one push; with a producer missing
  its month, the digest says so explicitly.
- No workflow reads another's files except through the declared mechanism (grep-enforceable).

## Test plan

Fixture artifacts for each producer; golden-ish structure assertions on the gathered context;
ledger idempotency test (second run same month = noop).
