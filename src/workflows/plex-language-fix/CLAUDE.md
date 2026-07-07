# CLAUDE.md — src/workflows/plex-language-fix/

Plex only supports ONE global default-audio-language preference for the whole server — wrong for any
library whose original language isn't English, and even a foreign-language title's own baked-in file
default (its `default` flag) isn't guaranteed to match, since it's a per-file authoring choice, not a
per-language server setting. This workflow builds a per-title, original-language-aware replacement:
resolve each show/movie's TRUE original language via TMDB, then work out which audio/subtitle track
SHOULD be selected by default per file versus what's currently selected.

**Two members: scan (read-only) → apply (mutating).** `plex-language-scan` is strictly READ-ONLY: it
never issues a mutating request to Plex, only writes its proposed changeset to
`data/out/language-scan.json`. `plex-language-apply` (`dependsOn: ['plex-language-scan']`, gated on the
`plex-language-scan` contract — see `contracts.ts`) reads that changeset and APPLIES every
`status: 'change'` entry via Plex's own official `PUT
/library/parts/<id>?audioStreamID=&subtitleStreamID=&allParts=1` endpoint — the same call Plex's own
clients make when a user manually picks a track (`plexPutStreams` in `src/core/plex-client.ts`, shared
there rather than kept workflow-local since it's a Plex-generic mutating primitive, like `plexGet` is a
Plex-generic read).

**A third member, `plex-language-no-track-flag`, was deliberately removed (T452).** It used to flag
files with NO audio track at all in their title's true original language (a probable wrong-release
signal). The owner decided this signal wasn't worth keeping and had it dropped with no replacement —
this is an intentional removal, not an oversight; don't re-add it without a fresh ask.

**Fully unattended — no per-run manual sign-off, by explicit owner decision.** The owner does not want
to review every run by hand; this runs on the workflow's weekly schedule with no approval gate. Every
`'change'` entry (including what would previously have been flagged an ambiguous channel-count tie — see
below) is applied the same way, using the scan stage's best-judgment pick. In place of manual review, two
safety nets stand in:
1. **Plex Butler backup, triggered once per run before the first real PUT** (`triggerButlerBackup()` in
   `src/core/plex-client.ts`, `POST /butler/BackupDatabase`) — validated live to produce a real dated
   backup within about a minute. A failed trigger only logs a WARN; it does not block applying (the
   per-file undo log below is the primary safety net, Butler the secondary one).
2. **A self-contained per-run applied-changes log**, `data/out/applied-log-<ISO-timestamp>.json`,
   recording every applied (or failed) file's `partId`, path, and BOTH its before AND after
   audio/subtitle selection — so a revert never needs to cross-reference the scan file. The manual,
   NEVER-scheduled `scripts/plex-language-undo.ts` (top-level `scripts/`, run directly by the owner:
   `tsx scripts/plex-language-undo.ts [--apply] [path]`, dry-run by default) reads the most recent (or a
   given) log and reverts every `'applied'` entry back to its recorded before-state.
`plex-language-apply` records every processed file on the `work_items` ledger (`success`/`failed`, keyed
by `partId`) and throws (failing the run itself) if any file failed to apply this run, per the repo-wide
item-loop convention.

**Ambiguous ties are NOT a thing here — the owner explicitly ruled it out.** An earlier scratch
exploration flagged a genuine audio-candidate tie (same original-mix status, channel count, and codec
quality) as a 4th `'ambiguous'` status requiring manual review. The owner decided this workflow should
never carve out a "needs a human" state for a tie: `FileStatus` has exactly 3 values —
`'change' | 'already-correct' | 'no-match'` — and every tie resolves automatically via the existing
best-judgment heuristic in `lib.ts`'s `pickAudioCandidate` (prefer an explicitly-labelled "Original"
mix, then highest channel count, then higher-quality codec, then lowest stream index), then is treated
exactly like any other proposed change.

**Shared Plex/TMDB connectivity.** Like the other three Plex-touching workflows
(`missing-tv-seasons`, `movie-recommendations`, `plex-space-saver`), this workflow reuses the shared,
self-contained `src/core/plex-client.ts` (`plexGet`/`tmdbGet`, DHCP-self-heal LAN scan) rather than
duplicating connectivity — see that file for the mechanism. TMDB lookups route through the shared
rate-limited `tmdb` service (`callService('tmdb', ...)`, same as `missing-tv-seasons`), so a hit
monthly/daily cap stops the scan gracefully (a `QuotaExceededError` is caught per-title-loop and logged,
not thrown) rather than blowing the shared quota.

**Sections scanned.** The movie and TV sections reuse the SAME `PLEX_MOVIE_SECTION`/`PLEX_TV_SECTION`
env vars every other Plex workflow already reads (no duplicate env vars). A third, lower-confidence
"downloadable" section is opt-in only: `PLEX_DOWNLOADABLE_SECTION` is unset by default (excluded from
the scan); setting it to a Plex section key includes that section too.

**Idempotency: "re-scan fresh every run", mirroring `plex-space-saver` exactly.** This is a periodic
audit of real-world drifting state (files get added/removed, a track might be changed by hand), not a
one-time ingestion — there is no per-item "skip if already scanned" logic. Idempotency is just "don't
duplicate the SAME week's report on a manual re-run": a `work_items` ledger row keyed by ISO calendar
week (`weekKey`, in `stages/scan.ts`) under job name `plex-language-scan`, with
`detail: { path, format: 'json' }` (the T262 output-form convention — a structured JSON artifact, not
markdown prose). This workflow declares no `inputKeys()` (not limitable — scheduled-only, like
`missing-tv-seasons`/`plex-space-saver`).

Runs weekly (Sundays 04:00 — distinct from `plex-space-saver`'s Sunday 06:00 and
`missing-tv-seasons`'s Monday 09:00, to spread Plex/TMDB load across the week).

**Retained from validated exploration, don't simplify away:** the commentary/description stoplist and
the "Signs & Songs"-only English subtitle classifier (`isSignsOrSongsOnly`/`SIGNS_SONGS_PATTERN`/
`FULL_DIALOGUE_OVERRIDE` in `lib.ts`) — both were found live against the owner's real library and catch
real bugs (a Songs & Signs-only subtitle paired with foreign audio leaves dialogue unsubtitled).
