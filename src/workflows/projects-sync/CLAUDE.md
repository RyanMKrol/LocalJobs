# CLAUDE.md — src/workflows/projects-sync/

Weekly GitHub repo ingestion + Claude-authored per-project markdown summaries, forming a queryable
"second brain" corpus. Runs Sunday at 05:00. Two-stage DAG: `github-sync → project-summarize`,
run one stage at a time (`maxConcurrency: 1`). Limitable: `github-sync` declares `inputKeys()`.

## How the stages hand data to each other (ports)

A ports workflow (see "Ports" in the root `CLAUDE.md`; artifact types in `contracts.ts`):

| Stage | Inputs | Outputs |
|---|---|---|
| `github-sync` | none (root: `inputKeys()` live from GitHub) | `catalog` (`projects-catalog`, `projects.json`) |
| `project-summarize` | `catalog` | `summaries` (`project-summaries`, the folder of `<repo>.md` profiles, cumulative) |

The catalog is rebuilt from GitHub every run and must not be empty. The summarize stage reads
the catalog it was handed (`ctx.input('catalog').read()`), not whatever file is on disk. A repo
is re-summarized only when it has been pushed to, so on a quiet week the summaries folder is
carried forward. `project-summarize` is the final stage, so the summaries are the workflow's
product. Both stages keep their ledgers, keyed by the repo's numeric GitHub id: `github-sync`
records every cataloged repo again on each run (`detail: { name, description, language, topics,
url, pushedAt }`), and `project-summarize` keeps one row per repo holding the markdown path and
the `pushedAt` it was last summarized at (stored as `detail.lastCommitSha`), which is what
decides whether a repo is skipped.

## Stage 1 — `github-sync`

Fetches the owner's repos via `GET /users/<GITHUB_USERNAME>/repos`, filters out forks/archived/private,
sorts by `pushed_at` descending, and writes the result to `data/out/projects.json` (no DynamoDB).
Idempotent per GitHub numeric repo id (`repoId`) via the `work_items` ledger — re-scans and re-records
every run so catalog fields (description, topics, etc.) stay fresh, rather than skipping already-seen
repos.

The GitHub API call is rate/quota-gated through the `github` service via `callService('github', ...)`
ONCE PER PAGE fetched (T424) — a multi-page catalog reserves one slot per request, not one for the
whole paginated fetch. Each page is cached by the service for 22 hours (`cacheKey:
github:repos:<user>:page:<n>`), so a manual re-run the same day sees the same catalog.

**`githubSyncInputKeys()` (the root-stage `inputKeys()` with `inputKeysService: 'github'`, T094) is a
LIVE API call, not a read-back of `data/out/projects.json` (T486).** This stage is the SAME stage that
writes that catalog file, so reading it back to derive candidate roots would be self-referential: on
a fresh checkout or after a `data/` reset (no catalog file yet) it would return `[]`, and every repo
would look "already complete" to the limited-run root selector even though nothing had ever synced.
It calls `fetchAllRepos` (the same paginated fetcher + `callService('github', ...)` wrapper
`runGithubSync` uses for its main sync), filters and sorts identically, and derives the candidate
repo-id list from that response.

## Stage 2 — `project-summarize`

Shallow-clones each cataloged repo into a gitignored `data/repos/<name>/` (pulling/resetting instead of
re-cloning if already present), then calls Claude via a **different invocation shape from the plain
`runClaude` call**: `src/services/claude.ts`'s `runClaudeWithRepoAccess` spawns the CLI with `cwd` set
to the cloned repo directory and `--add-dir <repoDir> --allowedTools Read Glob Grep` — real, scoped,
**read-only** filesystem access (deliberately no `Bash`/`Write`/`Edit`), so Claude explores the actual
checked-out project (package.json, source layout, README, other docs) itself rather than relying on a
prompt-embedded README slice. This invocation shape lives in the shared `src/services/claude.ts`
(there is no projects-sync-local Claude helper), sharing the same `spawnClaudeCli`
spawn/timeout/parse primitive `runClaude` uses: only the argv (`buildRepoAccessArgs`) and `cwd`
differ. It reads the same per-call, dashboard-overridable `claudeTimeoutMs()` as `runClaude`, and is
routed through the same `claude-cli` service/quota meter.

The `git clone`/`git fetch`/`git reset` operations are also routed through `callService('github',
...)` (T424) — the same shared `github` service/budget as the REST API pagination above, rather than
a second, untracked one.

The prompt (`buildSummaryPrompt`) embeds the catalog metadata GitHub knows (name/description/language/
topics/pushedAt/url — unreachable from local exploration alone) and instructs Claude to explore the
repo itself for everything else, writing a one-project summary to `data/out/<repo-name>.md`. The
path is recorded as `detail.markdown` on the repo's ledger row.

**The output is an enforced template contract**, mirroring `perfumes`'s `profile.template.md` pattern:
`buildSummaryPrompt` embeds `project.template.md` (override via `PROJECTS_SYNC_TEMPLATE_PATH` /
`projectsSyncConfig.templatePath`) and instructs Claude to follow it exactly — YAML frontmatter
(`name`/`full_name`/`url`/`language`/`topics`/`status`/`last_pushed`/`themes`/`domain`) plus fixed `##`
sections (`What It Is`/`Tech Stack`/`Status`/`Structure`/`Themes & Interests`/`Notable Technical
Approaches`/`Sources`), designed so the whole corpus is queryable for cross-project questions ("what
kind of work am I interested in", "what have I built in domain X"). Each section is expected to be a
couple of substantive paragraphs grounded in real repo exploration, not a one-line restatement of the
catalog metadata — while keeping the "never invent facts" honesty rule intact (a small/dormant project
may honestly say a section has little to add). The reply is first cleaned with
`salvageFrontmatterMarkdown` (`src/services/claude.ts`): a code fence is unwrapped and any line of
commentary before the opening `---` is dropped. Without it, a real run on 2026-11-10 failed 5 of 7
attempts on the leading-`---` check alone, with every required section present. `templateShapeViolations`
then validates what is left (leading `---` + every required heading); a reply that is still the wrong
shape is saved to `data/rejected-summaries/<repo>.txt` for inspection and throws with the missing pieces
named. The loop catches it, records the repo `failed`, carries on with the other repos, and fails
the run at the end if any repo failed. A Claude usage or rate limit ends the loop early without
failing the run; the repos not reached are picked up next run.

Idempotent per repo via a commit-sha-equivalent marker (the catalog's `pushedAt`): a repo whose stored
marker already matches the catalog's current value is skipped entirely (no clone, no Claude call) — no
separate calendar-based skip.

## Config

- Service: `src/services/github.service.ts`.
- Credentials: `GITHUB_USERNAME`, `GITHUB_TOKEN`.
- Model: `PROJECTS_SYNC_CLAUDE_MODEL` (defaults to a Sonnet 5 id) at effort `PROJECTS_SYNC_CLAUDE_EFFORT`
  (defaults to `medium`), shares `LOCALJOBS_CLAUDE_BIN`/`LOCALJOBS_CLAUDE_TIMEOUT_MS` via the
  `claude-cli` service.
- Stage limits: `github-sync` 2 minute timeout, 3 retries; `project-summarize` 10 minute timeout,
  2 retries.
- Paths (`config.ts`): `data/out/projects.json`, `data/out/<repo>.md`, clones in `data/repos/`.
  `config.ts` takes the data folder through `resolveWorkflowDataDir`, so under `npm test`
  everything (the rejected-reply save in `data/rejected-summaries/` included) goes to a scratch
  folder and never the real one.
