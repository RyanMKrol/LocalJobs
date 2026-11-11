# custom/docs/HARNESS.md — project notes for docs/HARNESS.md

Customization overlay for `.harness/docs/HARNESS.md`. Record project-specific harness-design notes,
deviations, or extra context here; harness upgrades never touch this file. (See `.harness/custom/CLAUDE.md`.)

<!-- Add your project-specific notes here. -->

## Why the in-place loop variant (not the worktree variant)

This project runs the **in-place** loop (`# harness-loop-variant: in-place`) — it builds directly on
`main` in the primary checkout, not in a throwaway worktree off `origin/main`. The reason is
project-specific:

- The workflow code under `src/workflows/` is tracked, but what a task is verified against is not:
  each workflow's `data/` folder, `.env`, the SQLite database, and any private top-level
  `src/workflows/*.job.ts`. All of that exists only in this checkout. A clean worktree off
  `origin/main` has the code and none of the data, so the loop could not verify a task there.
- The safety model is **git itself**: every task is one commit on `main`; a bad one is a one-line
  `git revert`. This also lets the loop use the real local `data/` as verification fixtures.

See also the "Works in-place on `main`, with no worktree isolation" row in
`custom/docs/LIMITATIONS.md` for the trade-off framing.
