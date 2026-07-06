# custom/docs/HARNESS.md — project notes for docs/HARNESS.md

Customization overlay for `.harness/docs/HARNESS.md`. Record project-specific harness-design notes,
deviations, or extra context here; harness upgrades never touch this file. (See `.harness/custom/CLAUDE.md`.)

<!-- Add your project-specific notes here. -->

## Why the in-place loop variant (not the worktree variant)

This project runs the **in-place** loop (`# harness-loop-variant: in-place`) — it builds directly on
`main` in the primary checkout, not in a throwaway worktree off `origin/main`. The reason is
project-specific:

- The real jobs (`src/workflows/places`, `src/workflows/perfumes`, and the other private workflows) and
  all their `data/` live **untracked** in this checkout. A clean worktree off `origin/main` literally
  can't see them, so it couldn't build or verify against them.
- The safety model is **git itself**: every task is one commit on `main`; a bad one is a one-line
  `git revert`. This also lets the loop use the real local `data/` as verification fixtures.

See also the "Works in-place on `main` — no worktree isolation" row in `custom/docs/LIMITATIONS.md`
for the trade-off framing.
