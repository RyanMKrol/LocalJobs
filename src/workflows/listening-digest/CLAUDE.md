# CLAUDE.md — src/workflows/listening-digest/

Once a month, fetches Last.fm's own aggregated `user.getTopAlbums` + `user.getTopTracks` TWICE in
one run — once with `period=1month` and once with `period=3month` — reusing the exact same
fetch/filter/render pipeline for both passes. Each pass filters out albums where a single track
accounts for ≥70% of the album's plays in that period (a "one song on repeat" false positive —
mirrors the same heuristic `ryankrol.co.uk`'s `/listening` page uses), and writes its own markdown
digest to `data/out/`: `listening-digest-<YYYY-MM>.md` (current month, unchanged from before this
was added) and `listening-digest-<YYYY-MM>-3month.md` (trailing 3 months, heading suffixed
"(Trailing 3 Months)").

No DynamoDB — the website already reads Last.fm's period-based aggregation directly, so there's no
need to persist raw scrobbles.

Single job, single stage — still not limitable (nothing to fan out over), and still no new DAG
member/edge/gate; both files come out of the one `lastfm-digest` job. Idempotent per calendar month
via the `work_items` ledger, with a SEPARATE ledger key per period — `YYYY-MM` for the 1-month
digest and `YYYY-MM-3month` for the trailing digest — both under the same `lastfm-digest` job name.
A manual re-run the same month regenerates BOTH files in place rather than duplicating either.

Service: `src/services/lastfm.service.ts`. Credentials: `LAST_FM_API_KEY`, `LAST_FM_USERNAME`.
