# CLAUDE.md — src/workflows/listening-digest/

Once a month, fetches Last.fm's own aggregated `user.getTopAlbums` + `user.getTopTracks`
(`period=1month`), filters out albums where a single track accounts for ≥70% of the album's plays (a
"one song on repeat" false positive — mirrors the same heuristic `ryankrol.co.uk`'s `/listening` page
uses), and writes a markdown digest to `data/out/`.

No DynamoDB — the website already reads Last.fm's period-based aggregation directly, so there's no
need to persist raw scrobbles.

Single stage, not limitable (nothing to fan out over). Idempotent per calendar month via the
`work_items` ledger (keyed `YYYY-MM`) — a manual re-run the same month regenerates that month's file
rather than duplicating it.

Service: `src/services/lastfm.service.ts`. Credentials: `LAST_FM_API_KEY`, `LAST_FM_USERNAME`.
