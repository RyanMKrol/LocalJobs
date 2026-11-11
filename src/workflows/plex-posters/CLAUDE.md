# CLAUDE.md: src/workflows/plex-posters/

The workflow is `plex-poster-backup`. Once a week (Sundays 04:00, `0 4 * * 0`) it backs up the
poster every film, show and season in Plex currently shows.

Posters chosen or uploaded by hand are the part of a Plex library that a metadata refresh, a
re-match or a rebuilt database can silently replace. This keeps every one of them, with a dated
record of which title had which image, so they can be put back.

It started as two commands (`pull-posters`, `push-posters`) in the owner's separate PlexUtils
repo. The pull is this workflow. The push is `scripts/plex-posters-restore.ts`, run by hand.

## The archive

The images and the snapshots are NOT in this workflow's `data/out`. They live in an archive
folder named by `PLEX_POSTER_ARCHIVE_DIR`, which on the owner's machine is a folder on a NAS
share (the share's name is kept out of this public repo, so there is no default). Two reasons:
the archive is several gigabytes, and the dashboard's "Clear output data" button empties
`data/out`.

```
<archive>/.plex-poster-archive                 marker file: proves this is the archive
<archive>/images/<sha1>.<ext>                  the posters, named by the SHA-1 of their bytes
<archive>/snapshots/posters-<timestamp>.json   one manifest per backup
<archive>/latest.json                          a copy of the newest manifest
```

- **Images are stored once.** A file is named by the hash of its contents, so the same picture
  is kept once however many titles or snapshots use it. A week in which nothing changed adds one
  snapshot file (about 3 MB) and no images. This is why nothing is zipped: posters are JPEGs
  (a sample compressed by 4%), and a zip per week would store every image again.
- **Nothing is ever deleted.** An old poster stays in `images/` after a title moves on from it;
  that is the point. There is no pruning.
- **SHA-1 is deliberate.** Plex names an uploaded poster `upload://posters/<sha1 of the file>`,
  so the restore script can tell that Plex already holds an image without sending it again.
- **The manifest is version 1 of the PlexUtils format**, unchanged, so the archive carried
  straight over from there.

### The marker file, and why the workflow never creates the archive folder

When a network share is not mounted, macOS can leave an EMPTY folder at its mount point. If a
stage created the archive's folders there, gigabytes of images would land on the local disk and
the mount point would start to look healthy to `mount-keeper`. So `assertArchiveReady` (`lib.ts`)
never creates the archive's root. The folder must already exist and contain
`.plex-poster-archive`; if it does not, the stage fails with "probably not mounted" and writes
nothing. Only then are `images/` and `snapshots/` created inside it.

Setting up a new archive is therefore a manual, one-time step: create the folder, create an
empty `.plex-poster-archive` file in it, and set `PLEX_POSTER_ARCHIVE_DIR` in `.env`.

## How the stages hand data to each other (ports)

A plain chain. Each stage takes everything it needs from the one before it (artifact types in
`contracts.ts`):

| Stage | Depends on | Inputs | Outputs |
|---|---|---|---|
| `plex-posters-list` | nothing | none | `list` (`plex-poster-list`, `data/out/poster-list.json`) |
| `plex-posters-fetch` | list | `list` | `set` (`plex-poster-set`, `data/out/poster-set.json`) |
| `plex-posters-record` | fetch | `set` | `report` (`plex-poster-backup-report`, `data/out/backup-report.json`) |
| `plex-posters-alert` | record | `report` | `digest` (`plex-poster-alert`, inline) |

`plex-posters-record` is the product stage (`product: true`): its report is what the workflow
page's Output section shows. Every output is rewritten on every run. The archive is not an
artifact: the stages write to it as a side effect, and the report says what was added.

1. **`plex-posters-list`** asks Plex for its libraries and lists every film, show and season in
   every film and TV library (one request per library per kind). It reads live, never from the
   plex service's response cache. The libraries are discovered, not taken from
   `PLEX_MOVIE_SECTION` / `PLEX_TV_SECTION`, so a library added later is covered. It fails,
   writing nothing, if Plex lists no titles at all.
2. **`plex-posters-fetch`** downloads only what is new. Plex puts a version number in a
   poster's path (`/library/metadata/<id>/thumb/<version>`) and changes it whenever the poster
   or the title's metadata changes. A path seen before, whose image is still in the archive,
   is not downloaded. "Seen before" comes from two places: `data/out/poster-index.json`, a local
   index saved as the stage goes (so a retry does not download again what a failed attempt
   already stored), and, when that file is missing, the archive's own `latest.json`. A path
   that changed with the same picture behind it is downloaded and then found to be an image
   the archive already has, so it costs bandwidth but no space.
3. **`plex-posters-record`** checks that every image the snapshot names is in the archive,
   writes the dated snapshot and then `latest.json`, and compares the new snapshot with the
   previous one. The comparison is by the bytes of each title's poster (its SHA-1), not its
   path. A title is followed across a new ratingKey by its Plex guid (a season by its show's
   guid and its number), because Plex gives a title a new ratingKey when it re-creates it.
4. **`plex-posters-alert`** sends one high-priority push when a large share of posters changed
   since the previous snapshot: at least `PLEX_POSTER_ALERT_PCT` percent (default 20) and at
   least `PLEX_POSTER_ALERT_MIN` posters (default 25). That usually means a metadata refresh
   replaced chosen artwork. On a normal week it sends nothing.

It is not limitable (no `inputKeys()`): a backup of some of the posters is not a backup.

## When a poster cannot be downloaded

One title whose artwork Plex cannot serve must not stop every other poster being recorded, and
it must not go unnoticed either. So:

- Up to `failureTolerance` failures (2% of the library, and never fewer than 10) are recorded
  in the set with no image. The snapshot is still written. The failed titles are left out of
  the "changed" comparison, so they are reported as failures and not as posters that changed.
- The LAST stage then fails, after recording its result, naming the titles. The run ends
  `partial` with a warning push, every week, until the poster is fixed in Plex.
- More failures than that means Plex was unwell. The fetch stage's output fails its own check,
  the attempt fails, nothing is recorded, and the retry downloads only what is still missing.

## The ledger

Only `plex-posters-alert` keeps one: a row keyed by the snapshot's timestamp, written when the
mass-change push has gone out, so a retry of the stage cannot send it twice. The other three
stages keep no ledger. They are not `eachItem` loops on purpose: no title is ever "done", every
one is looked at again each week, and what makes a poster skippable is its path, not a row.

## Putting posters back

`scripts/plex-posters-restore.ts`. Manual, never scheduled, and the only part of this that
writes to Plex. It is a dry run unless given `--apply`:

```
npx tsx scripts/plex-posters-restore.ts                      # what would be restored
npx tsx scripts/plex-posters-restore.ts --match "severance"  # only matching titles
npx tsx scripts/plex-posters-restore.ts --snapshot <archive>/snapshots/posters-<stamp>.json --apply
```

For each title whose current poster is not the one in the snapshot, it selects the image if
Plex still holds it as an upload, otherwise uploads it from the archive, then locks the poster
so a refresh does not replace it again (`--no-lock` to skip that). A title is found by its
ratingKey on the same server, else by guid, else by name and year; a title with two possible
matches is left alone. The header comment of the script lists every option.

## Settings

| Env var | Default | What it does |
|---|---|---|
| `PLEX_POSTER_ARCHIVE_DIR` | none (required) | The archive folder. Ignored under test, so a test can never write to the real archive |
| `PLEX_POSTER_FETCH_CONCURRENCY` | 4 | Posters downloaded at once |
| `PLEX_POSTER_ALERT_PCT` | 20 | Share of posters that must have changed for the alert |
| `PLEX_POSTER_ALERT_MIN` | 25 | ...and the least number of posters |

Plex is reached through the shared client (`src/core/plex-client.ts`: `plexGet` for listings,
`plexGetBinary` for the images) and every call goes through the `plex` service. Reads and
writes of the archive go through the `fs` service. Credentials are the usual `PLEX_HOST` and
`PLEX_API_TOKEN`.

Stage limits: list 5 minutes, 3 retries. Fetch 2 hours, 2 retries (a first run into an empty
archive downloads every poster). Record 10 minutes, 2 retries. Alert 1 minute, 1 retry.

The schedule sits after the nightly Plex-heavy runs and fifteen minutes after `mount-keeper`'s
03:45 check that the shares are mounted.

## Files

- `plex-posters.workflow.ts`: the manifest.
- `contracts.ts`: the four artifact types.
- `config.ts`: paths and settings. `types.ts`: the records and the manifest format.
- `lib.ts`: the archive's file handling (`assertArchiveReady`, `storeImage`,
  `listArchiveImages`, `readManifest`) and the comparison (`identityKey`, `diffSnapshots`).
- `stages/`: `list`, `fetch`, `record`, `alert`, each a `.job.ts` and its implementation.
- `plex-posters.test.ts`: the helpers and all four stages against a fake Plex and a temp folder.
- `scripts/plex-posters-restore.ts` and its test, at the repo root.
