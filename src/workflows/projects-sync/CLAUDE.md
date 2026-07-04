# CLAUDE.md — src/workflows/projects-sync/

Weekly GitHub repo ingestion + Claude-authored per-project markdown summaries, forming a queryable
"second brain" corpus. Runs Sunday at 05:00. Two-stage DAG: `github-sync → project-summarize`.

## Stage 1 — `github-sync`

Fetches the owner's repos via `GET /users/<GITHUB_USERNAME>/repos`, filters out forks/archived/private,
sorts by `pushed_at` descending, and writes the result to `data/out/projects.json` (no DynamoDB).
Idempotent per GitHub numeric repo id (`repoId`) via the `work_items` ledger — re-scans and re-records
every run so catalog fields (description, topics, etc.) stay fresh, rather than skipping already-seen
repos.

⚠️ Known gap (see `.harness/tasks/T424.md`, pending): the GitHub API call is only rate/quota-gated ONCE
for the whole paginated fetch, not once per page — harmless at the owner's current repo count (under
100, so it never actually paginates), but wrong if that changes.

## Stage 2 — `project-summarize`

Shallow-clones each cataloged repo into a gitignored `data/repos/<name>/` (pulling/resetting instead of
re-cloning if already present), then calls Claude via a **different invocation shape from the shared
`runClaude` helper**: `claude-repo.ts`'s `runClaudeWithRepoAccess` spawns the CLI with `cwd` set to the
cloned repo directory and `--add-dir <repoDir> --allowedTools Read Glob Grep` — real, scoped,
**read-only** filesystem access (deliberately no `Bash`/`Write`/`Edit`), so Claude explores the actual
checked-out project (package.json, source layout, README, other docs) itself rather than relying on a
prompt-embedded README slice. Still routed through the same `claude-cli` service/quota meter as
`runClaude` — only the CLI args/cwd differ; the shared `src/services/claude.ts`'s `runClaude` itself is
unmodified and still used by `perfumes`/`movies`/`tv-recs`.

⚠️ Known gap (see `.harness/tasks/T424.md`, pending): the `git clone`/`git fetch` operations themselves
are NOT service-gated at all today — no rate/quota check on the git-over-HTTPS calls to GitHub.

The prompt (`buildSummaryPrompt`) embeds the catalog metadata GitHub knows (name/description/language/
topics/pushedAt/url — unreachable from local exploration alone) and instructs Claude to explore the
repo itself for everything else, writing a one-project summary to `data/out/<repo-name>.md` (the
standard `detail.markdown` shape, surfaces automatically in the workflow's Output section).

**The output is an enforced template contract**, mirroring `perfumes`'s `profile.template.md` pattern:
`buildSummaryPrompt` embeds `project.template.md` (override via `PROJECTS_SYNC_TEMPLATE_PATH` /
`projectsSyncConfig.templatePath`) and instructs Claude to follow it exactly — YAML frontmatter
(`name`/`full_name`/`url`/`language`/`topics`/`status`/`last_pushed`/`themes`/`domain`) plus fixed `##`
sections (`What It Is`/`Tech Stack`/`Status`/`Structure`/`Themes & Interests`/`Notable Technical
Approaches`/`Sources`), designed so the whole corpus is queryable for cross-project questions ("what
kind of work am I interested in", "what have I built in domain X"). Each section is expected to be a
couple of substantive paragraphs grounded in real repo exploration, not a one-line restatement of the
catalog metadata — while keeping the "never invent facts" honesty rule intact (a small/dormant project
may honestly say a section has little to add). `templateShapeViolations` validates the response post-hoc
(leading `---` + every required heading); a shape mismatch throws with the missing pieces named, routing
through the existing `catch` → `markWorkItem(..., 'failed', ...)` path.

Idempotent per repo via a commit-sha-equivalent marker (the catalog's `pushedAt`): a repo whose stored
marker already matches the catalog's current value is skipped entirely (no clone, no Claude call) — no
separate calendar-based skip.

## Config

- Service: `src/services/github.service.ts`.
- Credentials: `GITHUB_USERNAME`, `GITHUB_TOKEN`.
- Model: `PROJECTS_SYNC_CLAUDE_MODEL` (defaults to a Sonnet 5 id) at effort `PROJECTS_SYNC_CLAUDE_EFFORT`
  (defaults to `medium`), shares `LOCALJOBS_CLAUDE_BIN`/`LOCALJOBS_CLAUDE_TIMEOUT_MS` via the
  `claude-cli` service.
