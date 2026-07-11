# R02: Unify the Claude-CLI spawn/parse helper — three near-identical copies, two of which bypass the dashboard-editable timeout

**Type**: refactor · **Priority**: P2 · **Effort**: M
**Area**: services / workflows (perfumes, projects-sync)
**Affected files**: `src/services/claude.ts`, `src/workflows/perfumes/claude.ts`, `src/workflows/projects-sync/claude-repo.ts`

## Problem

Three copies of the same ~70-line spawn/parse body exist:

1. `src/services/claude.ts` — the blessed shared helper (`spawnClaude` + `RATE_LIMIT_RE` +
   envelope parse + `extractJsonObject`), gated through the `claude-cli` service.
2. `src/workflows/perfumes/claude.ts` — same, plus `unfenceMarkdown`. The migration onto (1) is
   the *documented* follow-up in CLAUDE.md/LIMITATIONS.
3. `src/workflows/projects-sync/claude-repo.ts` — `spawnClaudeWithRepoAccess`, the same body
   with different argv. This third copy appeared silently AFTER the "migrate perfumes" note was
   written — the debt is growing, not shrinking.

Concrete behavioral cost beyond duplication: the T465 feature made the `claude-cli` service
timeout dashboard-editable via `claudeTimeoutMs()` — but perfumes reads
`PERFUMES_CLAUDE_TIMEOUT_MS` from its own config at call time, and claude-repo reads
`LOCALJOBS_CLAUDE_TIMEOUT_MS` at **module load** (`claude-repo.ts:19`). Both bypass the editable
timeout entirely; a dashboard edit that claims to govern Claude CLI calls doesn't govern these.

## Proposed fix

One internal primitive in `src/services/claude.ts`:

```ts
spawnClaudeCli(prompt: string, args: string[], opts: { bin: string; timeoutMs: number; cwd: string })
```

- `runClaude` (existing public API) passes `buildClaudeArgs(...)` + a tmpdir cwd.
- New `runClaudeWithRepoAccess` passes `buildRepoAccessArgs(...)` + the repo cwd;
  projects-sync migrates to it.
- Perfumes migrates onto `runClaude`; `unfenceMarkdown` moves into the shared module.
- All three paths read the effective timeout via `claudeTimeoutMs()` (env overrides can remain
  as more-specific fallbacks if the owner wants, but default to the editable service value).
- All calls stay gated through the `claude-cli` service (perfumes already is via its own copy —
  verify meter parity so counts don't double or drop).

## Acceptance criteria

- One spawn/parse implementation; grep finds no residual `spawn(...claude...)` outside
  `services/claude.ts`.
- A dashboard edit of the claude-cli timeout affects perfumes builds and repo summaries on the
  next run.
- Perfumes/build + project-summarize outputs unchanged for fixture inputs.

## Test plan

Existing `claude.test.ts` + perfumes/build + project-summarize tests stay green against the
unified helper; add one test that the timeout resolution order is (service effective → env
fallback → default).
