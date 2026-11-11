# CLAUDE.md — src/workflows/listening-digest/

Once a month (the 1st at 06:00, `0 6 1 * *`) this workflow asks Last.fm for its own aggregated
`user.getTopAlbums` (top 25) and `user.getTopTracks` (top 50) twice, once with `period=1month`
and once with `period=3month` (`listeningDigestConfig.period` and `.trailingPeriod`), and writes
two markdown digests to `data/out/`:

- `listening-digest-<YYYY-MM>.md`, the one-month digest
- `listening-digest-<YYYY-MM>-3month.md`, the trailing three-month digest (its heading ends
  "(Trailing 3 Months)")

`<YYYY-MM>` is the UTC month the run happens in. Last.fm's periods trail back from the moment of
the request, so the scheduled run on the 1st mostly covers the calendar month that just ended.

Both passes go through the same fetch, filter and render code: `makeTopAlbumsFetcher` and
`makeTopTracksFetcher` take the period as a parameter, and `runListeningDigest` calls `runPass`
once per period. A re-run in the same month rewrites both files in place.

No DynamoDB. The owner's website reads Last.fm's period aggregation directly, so there is no
need to store raw scrobbles.

## The single-track album filter

Each pass drops an album when the plays of its tracks in that pass's top-tracks list add up to
70% or more of the album's plays (`singleTrackAlbumRatio`, shared by both passes). It is meant to
catch one song on repeat being counted as an album, the same heuristic the `ryankrol.co.uk`
`/listening` page uses. Tracks are matched to an album by the track's `album` field. A comment
in `renderDigestMarkdown` (`stages/listening-digest.ts`) records that Last.fm's
`user.getTopTracks` response does not include that field, in which case the filter drops nothing.

## One stage, one output

A single stage. The workflow is `listening-digest`; its job is named `lastfm-digest` (file
`stages/listening-digest.job.ts`). No `inputKeys()`, so it is not limitable. Timeout 60 seconds,
3 retries.

| Stage | Inputs | Outputs |
|---|---|---|
| `lastfm-digest` | none | `digests` (`listening-digests`, the `.md` files in `data/out/`) |

The artifact type is in `contracts.ts`. Its check wants at least one digest and no empty one.
The output is not cumulative: every run writes this month's two files, so every run commits it.

## The ledger

Each digest written is one row under the job name `lastfm-digest`: key `YYYY-MM` for the
one-month digest and `YYYY-MM-3month` for the trailing one, each `success` with the path of its
markdown file. A re-run in the same month re-records the same two rows.

The rows are read by another workflow: `vault-sync` copies one file per row into the
second-brain vault, so do not drop them. `vault-sync` also names this workflow in its `after`
list, so it waits if a `listening-digest` run is in progress.

## Service and credentials

Service: `lastfm` (`src/services/lastfm.service.ts`). Credentials: `LAST_FM_API_KEY`,
`LAST_FM_USERNAME`. The stage fails if either is not set.
