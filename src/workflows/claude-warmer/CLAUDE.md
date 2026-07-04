# CLAUDE.md — src/workflows/claude-warmer/

Issues one minimal Claude CLI prompt (`"hi"`, cheapest model) every 30 minutes via `runClaude` in
`src/services/claude.ts`.

**Why:** Claude accounts have a 5-hour rolling usage window; this workflow fires proactively during
off-hours so the window is already running (or reset) by the time real work needs Claude.

No local quota cap — the upstream Claude plan enforces its own limit; if that limit is hit the CLI
fails out and the job exits cleanly (soft-fail).

One stage (`claude-warm.job.ts`), `maxRetries: 0`, `timeoutMs: 60_000`.
