# CLAUDE.md — src/workflows/claude-warmer/

Sends one minimal Claude CLI prompt (`"hi"`, on a small Haiku model, `WARM_MODEL` in
`claude-warm.job.ts`) at 08:00 and 16:00 every day (`'0 8,16 * * *'`), through `runClaude` in
`src/services/claude.ts`, which calls the shared `claude-cli` service.

**Why:** Claude accounts have a 5-hour rolling usage window. Firing at 16:00 starts a fresh window
that resets around 21:00, and firing at 08:00 covers daytime starts. By the time you sit down to
do intensive work, the usage window is already a couple of hours old rather than just started,
which lowers the chance of running out of usage mid-session.

There is no local quota cap. The upstream Claude plan enforces its own limit. The stage never
fails its run because of the Claude call: a rate or usage limit means the window is already open
(outcome `already-active`), and any other error is logged as a warning (outcome `failed`). Both
return normally, so the run succeeds and the outcome says what happened.

## How the stage hands over its result (ports)

One stage, in `claude-warm.job.ts` at the folder root (there is no `stages/` folder and no
`contracts.ts`; the artifact type is declared in the same file).

| Stage | Inputs | Outputs |
|---|---|---|
| `claude-warm` | none | `result` (`claude-warm-result`, inline) |

The value is `{ outcome: warmed | already-active | failed, model, detail?, at }`, so each run's
page says how the attempt went. There is no ledger and no `data/` folder.

`timeoutMs: 60_000`, `maxRetries: 0`. Not limitable. The manifest sets `maxConcurrency: 1` and
`notifyEnabled: false`: a twice-daily ping is not worth a push on every run.

`claude-warm.test.ts` does not call the real CLI. It re-creates the stage's branching with an
injected `runClaude`, so a change to the stage's `run` needs the same change in the test.
