# CLAUDE.md — src/workflows/claude-warmer/

Issues one minimal Claude CLI prompt (`"hi"`, cheapest model) at 08:00 and 16:00 daily via `runClaude` in
`src/services/claude.ts`.

**Why:** Claude accounts have a 5-hour rolling usage window. Firing at 16:00 starts a fresh window that
resets around 21:00, and firing at 08:00 covers daytime starts. By the time you sit down to do intensive
work, the usage window is already a couple of hours old (not just-started), reducing the chance of
running out of usage credits mid-session.

No local quota cap — the upstream Claude plan enforces its own limit; if that limit is hit the CLI
fails out and the job exits cleanly (soft-fail).

One stage (`claude-warm.job.ts`), `maxRetries: 0`, `timeoutMs: 60_000`.
