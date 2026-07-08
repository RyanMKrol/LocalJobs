# CLAUDE.md — src/workflows/listening-digest/

Once a month, fetches Last.fm's own aggregated `user.getTopAlbums` + `user.getTopTracks` TWICE — once
with `period=1month` and once with `period=3month` (`listeningDigestConfig.period` /
`.trailingPeriod`) — filters out albums where a single track accounts for ≥70% of the album's plays (a
"one song on repeat" false positive — mirrors the same heuristic `ryankrol.co.uk`'s `/listening` page
uses; the SAME `singleTrackAlbumRatio` is shared by both passes), and writes TWO markdown digests to
`data/out/` per run: the current-month digest (`listening-digest-<YYYY-MM>.md`) and a trailing-3-month
digest (`listening-digest-<YYYY-MM>-3month.md`, heading suffixed "(Trailing 3 Months)"). Both passes
reuse the exact same fetch/filter/render pipeline — `makeTopAlbumsFetcher`/`makeTopTracksFetcher` take
the period as a request parameter rather than hardcoding it, so `runListeningDigest` just calls each
fetcher twice.

No DynamoDB — the website already reads Last.fm's period-based aggregation directly, so there's no
need to persist raw scrobbles.

Single job/stage — still no new DAG member. Not limitable (nothing to fan out over). Idempotent per
calendar month via the `work_items` ledger: the 1-month digest is keyed `YYYY-MM`, the 3-month digest
`YYYY-MM-3month`, both under the same `lastfm-digest` job name. A manual re-run the same month
regenerates BOTH files in place rather than duplicating either.

Service: `src/services/lastfm.service.ts`. Credentials: `LAST_FM_API_KEY`, `LAST_FM_USERNAME`.
