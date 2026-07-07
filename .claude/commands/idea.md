---
description: Capture a raw idea into the gitignored ideas inbox (.harness/tracking/IDEAS.jsonl)
argument-hint: <the idea — in as much detail as you like>
---

Append the following idea as a new JSON line to `.harness/tracking/IDEAS.jsonl`:

$ARGUMENTS

Rules:
- This is **capture only, and non-interactive** — do NOT plan, scope, ask the user any clarifying
  questions, or turn it into a backlog task. That is the separate `/local-jobs-convert-ideas` step. It is a
  single quick append with no back-and-forth.
- **Don't interrupt in-flight work.** This is typically fired while you (Claude) are mid-task on
  something else; capturing an idea must be a quick side-append that does NOT derail, change, or
  context-switch whatever you were doing — jot it down and carry straight on. The user is offloading
  a thought precisely so it doesn't interrupt the current flow; honour that.
- `.harness/tracking/IDEAS.jsonl` is JSONL — one JSON object per line: `{"id": <int>, "title":
  "<short one-line summary>", "description": "<the full capture>", "capturedAt": "<ISO-8601 UTC>"}`.
  If the file doesn't exist yet, create it empty (no header/comment convention — just start
  appending lines).
- **Determine the next id:** read every existing line, parse its `id`, take the max (0 if the inbox
  is empty), and use max + 1. `id`s are local to the current inbox contents — a converted/deleted
  idea's id is never reused while other ideas remain, but a fresh empty inbox restarts at 1.
- Draft `title` as a short label (a few words to ~10) — just enough to identify the idea at a
  glance in the dashboard's collapsed row. It is NOT the full capture.
- **Capture as much as you can in `description`** — the full substance of what the user described,
  in their meaning, PLUS any context you already have that will help understand it later: relevant
  code anchors (`path:line`), the root cause, related tasks/ideas, and why it matters. There is
  **no length limit** — a long, detailed description is good. The ONE thing you must not do is
  *resolve* the idea: no design decisions, no scoping, no acceptance criteria, no choosing between
  options, no inventing requirements the user didn't imply. That deeper digging is deferred to
  `/local-jobs-convert-ideas`. Enrich ONLY from what you already know — never by asking. In short:
  capture everything that helps *understand* the idea; defer everything that *decides* it.
- `capturedAt` is the current UTC timestamp (e.g. via `date -u +%Y-%m-%dT%H:%M:%SZ`).
- **Append using `jq -nc`** to guarantee valid JSON escaping regardless of what the description
  contains, e.g.:
  `printf '%s\n' "$(jq -nc --argjson id "$ID" --arg title "$TITLE" --arg description "$DESC" --arg capturedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{id:$id,title:$title,description:$description,capturedAt:$capturedAt}')" >> .harness/tracking/IDEAS.jsonl`
- `.harness/tracking/IDEAS.jsonl` is gitignored and private — do NOT commit it.
- Confirm with a one-line acknowledgement of what was captured (e.g. "Captured as idea #N: <title>"). Nothing more.
