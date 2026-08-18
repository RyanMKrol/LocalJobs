# local-jobs

A personal job runner for a Mac Mini that never sleeps.

Some work doesn't fit a serverless function or a web request. It runs for hours,
drives a real browser, talks to a NAS over SMB, or needs to happen at 5am whether
or not anyone is watching. This is where that work lives: one daemon that keeps
about twenty jobs running on schedule, a record of every run, and a dashboard to
watch it all from the sofa.

It is deliberately small. SQLite, no Docker, no queue, no cloud.

## How it works

```
launchd  ──keeps alive──▶  daemon  ──runs──▶  workflow  ──runs──▶  job
                             │                (a pipeline)      (one step,
                             │                                 own process)
                             ▼
                          SQLite  ◀──reads──  dashboard
```

**The daemon** is the only long-lived process. It wakes up on a schedule, decides
what should run, and records what happened. Nothing else needs to be running for
work to get done.

**A workflow** is a pipeline. Most real tasks are several steps that depend on each
other: fetch the data, check it, transform it, publish it. A workflow describes
those steps and the order they need, and independent steps run at the same time.

**A job** is one step, and it runs in its own process. If it hangs, it gets killed.
If it crashes, it takes nothing else down with it. If it fails, it can retry
without redoing the work it already finished.

**The dashboard** is a window, not a control panel. Jobs run the same whether it is
open or closed.

## What you get

Everything below applies to any job you add, so a new job is mostly just the
interesting part.

**It remembers what it already did.** Jobs that chew through hundreds of items keep
a per-item ledger, so a re-run skips finished work and picks up where it stopped.
Interrupt a job halfway through 5,000 files and the next run continues from 2,501.

**Steps check each other's work.** Where one step hands data to the next, both sides
declare what that data should look like. If a website changes its layout or an
export drops a column, the pipeline stops at that boundary and tells you exactly
what changed, rather than quietly writing bad data to disk.

**Shared APIs get shared limits.** Paid or rate-limited services are declared once,
with a rate limit and a monthly spend cap. Every job that calls one goes through
the same meter, so caps hold no matter how many jobs run at once, and a job that
hits the ceiling stops politely instead of burning through your budget.

**Failures find you.** Runs that fail, time out, or leave items stuck send a push
notification to your phone, with a summary of what was processed.

**Nothing runs twice by accident.** A workflow can only have one run in flight. Ask
for a second and you get told, rather than quietly getting two.

**You can run a small slice.** Trigger a manual run limited to a handful of items to
see what a change does before letting it loose on the whole library.

**Everything is inspectable.** Live logs stream as jobs run, every past run is kept
with its output, and the dashboard shows what each step produced.

## What it currently runs

Twenty-two workflows, all included in this repo as working examples.

### Looking after a Plex library

| Workflow | What it does |
|---|---|
| plex-rename | Renames every file to Plex's canonical convention, so the library can rebuild itself from disk if the database is ever lost. |
| plex-library-guard | Watches for silent data loss and sends one urgent alert if the library shrinks or a file disappears. |
| plex-language-fix | Works out each title's real original language and sets the right audio and subtitle tracks. |
| plex-profiles | Writes a markdown profile for every film and show, with cast, ratings, and technical detail. |
| plex-space-saver | Reports where the disk space actually went, biggest first. |
| mount-keeper | Keeps the NAS shares mounted, because macOS drops them and everything else depends on them. |
| missing-movies | Finds collections you own part of, and tells you which films are missing. |
| missing-tv-seasons | Spots complete seasons of shows you follow that you haven't got yet. |
| movie-recommendations | Reads your library's taste and suggests films worth adding, monthly. |
| tv-recommendations | The same for television. |

### Keeping a personal archive

| Workflow | What it does |
|---|---|
| places | Turns your Google saved places into proper written profiles of each venue. |
| perfumes | Builds a profile for every fragrance you own, with notes, accords, and a written summary. |
| media-reviews | Pulls your own book, film, TV, and album reviews out of your website's database into markdown. |
| listening-digest | A monthly record of what you actually listened to. |
| workouts-sync | Syncs your workout history and writes a six-month progress report per exercise. |
| projects-sync | Catalogues your GitHub repos and writes a summary of what each project is. |
| vault-sync | Copies all of the above into your second-brain folder, with names a human would choose. |

### Money and housekeeping

| Workflow | What it does |
|---|---|
| stocks-sync | Takes a daily read-only snapshot of your portfolio and alerts on a big gain. |
| stock-digest | A weekly written summary of holdings, movers, and how diversified you actually are. |
| vercel-daily-redeploy | Ships a production deploy each night, so a site can't quietly go stale. |
| claude-warmer | Keeps a usage window warm, so the jobs that need it aren't cold when they run. |
| overrides-audit | Reminds you about settings you changed in the dashboard weeks ago and forgot to make permanent. |

Your own jobs stay private by default. This repo is public, and anything you add
is ignored by git unless you choose to publish it. Secrets live in `.env`.

---

## Running it

Two services, both kept alive by launchd, both back after a reboot.

```bash
git clone <this repo> && cd local-jobs
npm install

bash scripts/install-launchd.sh              # the engine

cd dashboard && npm install && npm run build && cd ..
bash scripts/install-dashboard-launchd.sh    # the dashboard

sudo pmset -a sleep 0 disablesleep 1         # schedules can't fire while asleep
```

The dashboard is at `http://localhost:4788`. The API stays on loopback.

To reach it from your phone, put it on a [Tailscale](https://tailscale.com)
tailnet with `tailscale serve --bg 4788`. Never use `tailscale funnel` for this,
which would publish it to the internet.

Day to day:

```bash
scripts/safe-restart.sh    # restart the daemon (refuses while a run is in flight)
tail -f data/daemon.out.log
```

Settings live in `.env`, documented in `.env.example`.

## Adding a job

A job is a description of itself and a function that does the work.

```ts
const job: JobDefinition = {
  name: 'cleanup-temp',
  description: 'Deletes stale temp files',
  timeoutMs: 600_000,
  maxRetries: 3,
  async run(ctx) {
    ctx.log('starting');
    ctx.progress(50, 'halfway');
    // throw to fail the run
  },
};
```

Then say when it runs, in a workflow of one step:

```ts
const workflow: WorkflowDefinition = {
  name: 'cleanup-temp',
  description: 'Nightly temp-file cleanup',
  schedule: '0 4 * * *',
  jobs: [{ job: 'cleanup-temp' }],
};
```

Drop both in `src/workflows/`, restart with `scripts/safe-restart.sh`, and it
appears in the dashboard. There is no registry to update.

## Testing

`npm test` runs the whole suite against a scratch database, so it can never touch
real data or real output. Add tests as you add behaviour.

Dashboard changes have two extra checks that drive a real browser, so they run by
hand rather than in CI: `dashboard/scripts/mobile-check.mjs` for phone widths, and
`dashboard/scripts/visual-check.mjs` for screenshots to look at.

## Reading further

`CLAUDE.md` covers the architecture and conventions in full. Each workflow folder
has its own `CLAUDE.md` describing how that particular one works and why.
