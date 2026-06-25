---
description: Capture a raw idea into the gitignored ideas inbox (.harness/IDEAS.md)
argument-hint: <the idea — in as much detail as you like>
---

Append the following idea as a new bullet to the `## Inbox` section of `.harness/IDEAS.md`:

$ARGUMENTS

Rules:
- This is **capture only, and non-interactive** — do NOT plan, scope, ask the user any clarifying
  questions, or turn it into a backlog task. That is the separate `/convert-ideas` step. It is a
  single quick append with no back-and-forth.
- **Don't interrupt in-flight work.** This is typically fired while you (Claude) are mid-task on
  something else; capturing an idea must be a quick side-append that does NOT derail, change, or
  context-switch whatever you were doing — jot it down and carry straight on. The user is offloading
  a thought precisely so it doesn't interrupt the current flow; honour that.
- If `.harness/IDEAS.md` doesn't exist yet, create it with a `# Ideas inbox` heading and a `## Inbox`
  section, then add the bullet.
- Append under `## Inbox` as `- <the idea text>`, preserving any existing bullets. **Capture as much
  as you can** — the full substance of what the user described, in their meaning, PLUS any context
  you already have that will help understand it later: relevant code anchors (`path:line`), the root
  cause, related tasks/ideas, and why it matters. There is **no length limit** — a long, detailed
  bullet is good. The ONE thing you must not do is *resolve* the idea: no design decisions, no
  scoping, no acceptance criteria, no choosing between options, no inventing requirements the user
  didn't imply. That deeper digging is deferred to `/convert-ideas`. Enrich ONLY from what you
  already know — never by asking. In short: capture everything that helps *understand* the idea;
  defer everything that *decides* it.
- `.harness/IDEAS.md` is gitignored and private — do NOT commit it.
- Confirm with a one-line acknowledgement of what was captured. Nothing more.
