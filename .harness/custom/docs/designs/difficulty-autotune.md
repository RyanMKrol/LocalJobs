# custom/docs/designs/difficulty-autotune.md — project notes

Customization overlay for `.harness/docs/designs/difficulty-autotune.md`. Add project-specific design notes
or deviations here; harness upgrades never touch this file. (See `.harness/custom/CLAUDE.md`.)

<!-- Add your project-specific notes here. -->

---

## 8. Status + tunables

| Piece | State |
|---|---|
| Faceted taxonomy + `facets.json` (vocabulary, ladder, knobs) | ✅ built |
| Retro-tags on 170 buildable tasks; needs-human carved out | ✅ built |
| Capture (`outcomes.jsonl` from mark_done/block_task) | ✅ built |
| Calibration + policy (`policy.jq`, rung machinery on the global ladder) | ✅ built |
| `MAX_ATTEMPTS` = 2 | ✅ built |
| Authoring: assign facets + emit poor-fit (add-to-backlog skill) | ✅ built (`ralph-loop-add-to-backlog` skill) |
| Poor-fit gate + layer re-eval + history migration + human prompt | ✅ built (same skill — see `.harness/CLAUDE.md`) |
| Portability: plugin framework + per-project layer setup | ✅ built — ships as the `claude-skills` plugin marketplace (a separate, sibling repo), not in-tree here |
| Surface calibration (a dashboard "harness health" view) | ⬜ optional |

**Tunables:** `floor` (0.75) and `minN` (6) in `facets.json`; `MAX_ATTEMPTS` (2) in `loop.sh`; the
poor-fit threshold **N** (to be set). **Possible future:** explicit downward *exploration* (occasionally
start one tier below the policy's pick to probe for cheaper settings) — today downward discovery relies
on the cheapest-qualifying rule + the authoring side trying cheaper.

**Invariant to preserve forever:** the calibration aggregates **only from `outcomes.jsonl`**, joining
each ledger row → its facets → its cell. It must never derive an outcome from a task's status or
authored difficulty. That is what keeps retro-tagged/done tasks (and any future metadata edit) from
ever leaking into difficulty selection.
