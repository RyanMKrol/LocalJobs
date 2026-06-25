---
description: Capture a raw idea into the gitignored ideas inbox (.harness/IDEAS.md)
argument-hint: <one or two sentences describing the idea>
---

Append the following idea as a new bullet to the `## Inbox` section of `.harness/IDEAS.md`:

$ARGUMENTS

Rules:
- This is **capture only** — do NOT plan, scope, ask clarifying questions, or turn it into a backlog
  task. That is the separate `/convert-ideas` step. Keep it to one quick append.
- If `.harness/IDEAS.md` doesn't exist yet, create it with a `# Ideas inbox` heading and a `## Inbox`
  section, then add the bullet.
- Append under `## Inbox` as `- <the idea text>`, preserving any existing bullets. Don't reword or
  expand the idea — capture it verbatim (lightly tidied) in one or two sentences.
- `.harness/IDEAS.md` is gitignored and private — do NOT commit it.
- Confirm with a one-line acknowledgement of what was captured. Nothing more.
