# CLAUDE.md — src/workflows/plex-rename/

Years of accumulated release-named files (`[Erai-raws] Mob Psycho 100 II - 05 [1080p].mkv`,
`10.Cloverfield.Lane.2016.2160p...`) were matched in Plex only via manual fix-ups. If the Plex
database were ever lost, none of that matching is reproducible from the filenames. This workflow
renames files/folders to the canonical Plex conventions — `Title (Year) {tmdb-N}/Title (Year)
{tmdb-N}.ext` for movies, `Show (Year) {tvdb-N}/Season NN/Show (Year) - sNNeNN - Title.ext` for TV,
plus a `.plexmatch` per show folder — using **Plex's own current matches as the source of truth**, so
the library becomes deterministically re-discoverable from disk alone.

## Safety doctrine (the owner's hard requirements — never weaken these)

1. **Never delete content that isn't verifiably replicated — and never rewrite bytes without
   verification.** Two move strategies (2026-08), chosen per move by whether bytes actually travel:
   - **Same-share (and not case-only) → ONE atomic rename** (`performAtomicRenameMove`): metadata
     only, the file's bytes are never read or rewritten, so there is nothing that CAN corrupt and
     nothing to checksum — and it's instant, which is what makes the ~26k same-share bulk of the
     library finishable in days instead of months of I/O. Crash-safe inherently (rename is atomic;
     the file is always fully at exactly one path). Space/utilization checks are skipped — a
     rename consumes no space.
   - **Cross-share (or case-only) → copy → checksum-verify → delete-original**
     (`performVerifiedMove`): stream-copy to `<target>.plexrename-partial` (never a media
     extension, so Plex can't scan a half-copy), SHA-256 both sides, atomically finalize
     partial → target, and ONLY then delete the source. The journal's copy-verified record is
     written before any delete is eligible. Worst crash outcome = a dead extra file, never a
     lost one.
   The journal records each move op's `strategy`, and the undo script reverses each the way it
   was applied (rename back / verified copy back).
2. **Write-AHEAD journal.** Intent is appended + fsync'd to the per-run NDJSON journal BEFORE each
   filesystem operation runs; completion records after. Ledger success is only recorded after the
   journal's item-done is flushed. (This is deliberately stronger than plex-language-fix's
   write-behind applied-log.)
3. **Hard per-op state gates.** Before every operation, apply re-asserts the disk is exactly as
   expected (source present at Plex's recorded size, target absent, mount healthy); after, it
   re-stats and re-hashes. Any surprise aborts the item — never "probably fine".
   The **volume-overburden guard** is part of this: a move soft-skips when the TARGET volume's
   projected utilization after the copy would exceed `PLEX_RENAME_MAX_VOLUME_UTILIZATION`
   (default 92%) — so moves onto a filling volume halt instead of filling it (load-bearing:
   volume1 was measured at 88% when this was added; cross-share consolidation adds data to a
   target volume permanently). The absolute free-space margin check still applies too.
4. **Folder removal is structurally incapable of deleting files**: only `rmdir` on a directory a
   fresh `readdir` shows empty, never a library root or ancestor. A half-moved folder (daily quota
   hit mid-folder) keeps its remaining files by construction.
5. **Mount-missing ≠ file-missing.** A mapped share root that's absent OR an empty directory (the
   stale-mountpoint trap) marks items `mount-missing` (routine, zero mutations); `file-missing`
   (mount healthy, file gone) is the alarming one.
6. **Never overwrite, never guess.** Target exists → skip. Metadata ambiguous/unmatched → typed
   skip. Existing `.plexmatch` (source tree, or divergent content at the target) → skip. Non-media
   siblings whose ownership is unclear (a lone `English.srt`) are left behind and reported.

## DAG — 5 stages, all keyed `${ratingKey}::part${partId}`

```
plex-rename-discover → plex-rename-plan → plex-rename-verify → plex-rename-apply → plex-rename-confirm
   (read-only, root)     (read-only)         (read-only, fs)      (MUTATING)          (read-only)
```

- **discover** — LIVE library walk (deliberately NEVER cached, unlike plex-language-fix's 3h-cached
  reads: a rename pipeline must not plan off a stale listing — `lib.ts`'s fetch helpers pass no
  cacheKey). Records one SNAPSHOT row per physical file, re-marked every run: path, `Part.size`,
  tmdb/tvdb/imdb ids off the item's own Guids, movie year/edition, episode numbering/titles/
  air-dates. Multi-episode files are grouped by shared Part id into one row (keyed by the FIRST
  leaf's ratingKey) listing every episode. Library roots come from Plex's own section `Location`
  paths — no env var. `inputKeys()` = the same live walk (T485), `inputKeysService: 'plex'`.
  **Snapshot ledgers self-prune (2026-08-11):** discover/plan/verify each end an UNLIMITED run by
  deleting their own rows whose keys this run didn't re-mark (`pruneSnapshotRows` in store) —
  keys that stop being emitted are GHOSTS (found live: pre-grouping-fix double-episode rows
  lingered and re-noised every apply run as "source no longer present" soft-skips). Limited runs
  never prune (they only re-mark selected roots), and the once-ever apply/confirm ledgers are
  NEVER pruned — deleting those rows would re-arm already-done mutations.
- **plan** — pure naming-engine computation (`naming.ts`), recomputed every run (plans are derived
  state). No disk, no Plex. Passes `siblings: []` — sidecar enumeration is verify's job, because
  directory listings are a FILESYSTEM fact. Cross-item collision pass (`finalizePlan`) downgrades
  duplicate targets deterministically. Detail carries from → to per item (the StageIoPanel report
  the owner reviews during probation).
- **verify** — the only fs-touching read stage (via `callService('fs', ...)` through the injectable
  `ReadFsSeam`). Mount preflight per `PLEX_RENAME_PATH_MAP` pair; maps Plex-side → local paths;
  asserts BOTH sides' shares are mounted + healthy (cross-share consolidation moves are
  legitimate — see the home-root rule below), source exists at exactly Plex's recorded size, mtime ≥
  `PLEX_RENAME_MIN_AGE_DAYS` (default 7 — the still-downloading guard: downloads land directly in
  library folders, so recency is the only in-flight signal), target absent (case-only excepted),
  sidecars enumerated from the REAL listing (`planSidecars`, movie folders also carry fixed-name
  assets; episodes never move release-folder assets into Season dirs), sidecar-target collisions,
  and the `.plexmatch` rules (source-tree hit → ineligible; identical target content → write op
  dropped; divergent → ineligible). Recomputed every run.
- **apply** — the ONLY mutating stage (`stages/apply.ts`). REHEARSAL MODE until
  `PLEX_RENAME_APPLY_ENABLED=1`: same selection + logging + REPORT-ONLY markdown, but no journal,
  no ledger marks, no Butler, zero mutations (a journal file existing always means real intent).
  When enabled: hard mount preflight (any needed share unhealthy → ZERO mutations, nothing marked,
  run success), daily quota via the `job_usage` meter (`PLEX_RENAME_MAX_PER_DAY`, default 30 media
  files; sidecars uncounted; `recordUsage` per applied file), crash reconciliation of any
  unresolved journal BEFORE new work (target-only → roll forward; both-sides-identical → delete
  source after hash equality; divergent/neither → fail loud, never guess), one Plex Butler DB
  backup before the first mutation (WARN-only — it protects the DB, not files), then per item:
  re-check EVERYTHING at the moment of truth (existence, exact size, mtime window, target absent,
  free space for a transient second copy, sidecar targets still clear — any drift is a SOFT skip,
  recomputed next run), journal the full op list, and execute mkdir → write-plexmatch → media
  move → sidecar moves → rmdir-if-empty, each move via `performVerifiedMove` with write-ahead
  journaling per step. Ledger success only after the journal's item-done is flushed; once-ever
  per file. Postamble: per-run report markdown (`data/out/reports/`), targeted
  `plexRefreshSection` per changed dir (falling back to full-section past 30 dirs, WARN-only),
  `run-end`, and a thrown error if any item failed.
- **confirm** — read-only post-verification (`stages/confirm.ts`) that Plex re-associated each
  moved file at the SAME ratingKey (watch state intact). Live fetch per applied-not-yet-confirmed
  item: new path at same key → success (once-ever); old path still → `skipped` (retryable) until
  `PLEX_RENAME_CONFIRM_GRACE_DAYS` (14) past `appliedAt`, then loud failure; ratingKey no longer
  resolving → loud failure immediately (the duplicate-re-import worst case — plex-library-guard
  independently alerts on the vanished key; deliberately NO library-wide search for the new owner
  in v1, the owner investigates). Transient fetch errors are soft skips.

## The naming engine (`naming.ts`) — pure, exhaustively table-tested

- **ID policy:** movies prefer `{tmdb-N}` (repo identity convention) falling back to `{imdb-ttN}`;
  shows prefer `{tvdb-N}` falling back to `{tmdb-N}`; **no id → skip `missing-id`** — an unmatched
  title's Plex metadata is filename-derived garbage, and renaming from garbage cements a wrong
  match. Movies also require a year (`missing-year`); shows don't (the folder id carries matching).
- **Sanitizer hazards encoded** (each is a real, documented Plex scanner behaviour): semicolons
  deleted (`Steins;Gate` truncates at `;`), colon → `" - "` with the leading space (`"- "` changes
  the parse), `[ ]` → `( )` (bracket content is Plex's ignore marker), `{ }` deleted (reserved for
  hint tags), NFC normalization (SMB/macOS NFD hazard), 255-byte component budgets (episode titles
  are all-or-nothing: dropped entirely rather than mid-truncated), and the exclusion-filter guard
  (never generate the word "sample" on a <300MB file, never a folder named like Plex's special
  dirs: `Extras`, `Behind The Scenes`, `Plex Versions`, …).
- **Conservative v1 skips:** multi-version items (>1 Media), non-contiguous multi-episode files,
  disc images (VIDEO_TS/BDMV/.iso), anything inside `Plex Versions/` or hidden/system dirs.
  Multi-part (>1 Part on one Media) DOES rename with ` - ptN`. Editions get `{edition-...}` on the
  file name only (folder shared).
- **`.plexmatch`:** identity pins only (title/year + every known id), NO `ep:` lines (canonical
  `sNNeNN` names parse deterministically; per-episode hints couple the file to exact paths).
- **Anime:** names come from Plex's OWN parentIndex/index belief — self-consistent on rescan. If
  Plex's match is wrong, the plan report is the v1 mitigation (garbage-in isn't detectable here).
- **One folder per show — the home-root consolidation rule (2026-08).** A show split across
  shares (e.g. seasons 1–2 on volume2, 3–5 on volume1) consolidates into ONE folder on its HOME
  root: `chooseShowHomeRoots` picks, per show, the library root already holding the most BYTES of
  it (each file weighs bytes + 1; ties resolve to the lexicographically first root — fully
  deterministic), and `plan` passes it as `RenameInput.homeRootPath`, overriding the file's own
  root for the TARGET. The minority share's files plan cross-share moves — safe because the move
  procedure is copy → verify → delete (never a rename), which crosses filesystems exactly as
  safely as it moves within one, and all bytes route through the Mac over SMB either way. Movies
  are per-item single folders on their own share by construction.
- **Folder strategy:** uniform "move out into a fresh canonical folder, never rename a directory in
  place" — old release folders keep their junk and are listed as leftovers in the report;
  cleanup of folders still HOLDING files is report-only. Emptied dirs
  are removed via plain `rmdir-if-empty` — including the emptied ANCESTOR chain (2026-08-11:
  nested release wrappers like "Mr Robot S01-S04 …/Season S02/" left an empty outer husk once
  drained; apply now climbs bottom-up, journal op carries `stopRoot`), each step structurally
  incapable of deleting files and stopping strictly below the library root. Pre-fix husks (4)
  were swept by hand.

## Plex health gate (2026-08-11 incident)

Apply probes Plex's **database-backed** health (`probePlexHealth` in `lib.ts` —
`/library/sections` under a hard `PLEX_RENAME_HEALTH_TIMEOUT_MS` budget, default 15s; NEVER
`/identity`, which a saturated server still answers instantly) BEFORE each batch and every 25
items during one. Pre-batch failure → the whole batch defers (zero mutations, run success);
mid-batch failure → stop early, unprocessed items lead the next run. Rationale: file moves
don't need Plex, but every batch triggers rescans + analysis on the same disks Plex's DB lives
on — during the live incident (five same-day batches + five Butler DB backups + Plex analyzing
~2,200 re-scanned files) the NAS saturated, Plex's DB-backed API hung, and clients showed the
server unavailable. The Butler backup is also once-per-day now (its own `job_usage` meter),
not once-per-batch.

## Operating the backlog sweep (2026-08-09 → 2026-08-15) — what the full-library run taught

The whole ~27k-file backlog was swept in batches over a week (30/day → 1,000 → 2,000 → 5,000 →
one 14,419-item run). Final state: **26,902 files moved, zero failed items, zero dangling
partials**, every journal closing with a matching `run-end`. Four operational facts worth
keeping, none of which are visible from the code alone:

- **Restarting the daemon kills an in-flight batch.** A restart hard-kills the apply child and
  the fresh daemon reaps the run as `cancelled`; this happened three times (twice from the
  autonomous loop, once from a parallel session deploying an unrelated workflow mid-batch).
  Always restart via `scripts/safe-restart.sh`, which refuses while a workflow run is active.
  The interruptions cost nothing but time — each stranded partial was reconciled away on the
  next run, exactly as designed.
- **Long batches need timeout overrides on BOTH mutating and verifying stages.** `apply`'s
  6h manifest default is far short of a multi-thousand-file batch (cross-share copies run
  ~55 files/hour vs ~1,200/hour for same-share renames); it was overridden to 96h from the
  dashboard. `confirm` is the subtler one: it makes ONE live Plex call per applied item, so a
  ~10k-item confirm backlog blew its 30-minute default three times in a row, each attempt
  making partial progress. Overridden to 6h. Both are `_overridden` dashboard values, so per
  the root doc's override rule they should be folded into the manifests as real defaults.
- **The health valve genuinely fires on big batches.** The 14,419-item run stopped itself at
  item 13,276 when Plex stopped answering inside the 15s window; the remaining 1,144 items led
  the next run and applied cleanly. Working as intended — treat an early stop as routine, not
  as a failure.
- **Watch state survives renaming; a changed ratingKey does not mean lost history.** Verified
  live: shows watched months before their rename still report their full watched count
  afterwards. Consolidation DOES retire duplicate show entries (the old episode ratingKeys 404
  afterwards) — see the confirm gap below.

## Three gaps the sweep exposed — all fixed (2026-08-17)

1. **`confirm` assumed a stable ratingKey; consolidation legitimately changes it.** Merging a show
   Plex held as TWO split entries retires the duplicate entry and its episode items, so the
   original key 404s while the file stays correctly matched (~6.5k items). `confirm` now indexes
   THIS run's discover snapshot by path and accepts an item at the exact target path whose ids
   match the ones the canonical name embeds, recording `reason: 'reassociated'`. That is a
   SHARPER check than the old one, not a weaker one — it distinguishes a merge from a genuinely
   lost file, which a bare ratingKey test cannot. A vanished key with nothing at the target now
   waits out the grace window before failing loud (the bytes were checksum-verified at apply
   time, so a missing Plex item is a matching problem, not data loss). Costs zero extra Plex
   calls — discover already walked the live library at the top of the same run.
2. **Our own `.plexmatch` blocked later renames for the same show.** `buildPlexmatch` emits
   identity lines only (never `ep:` hints), so a byte-identical file cannot pin a filename;
   `verify` now recognises one as ours and lets the rename through. A DIVERGENT `.plexmatch`
   still blocks, which is the protection that rule was actually written for.
3. **Release-layout subtitles were left behind.** `planSidecars` only ever saw flat siblings, so
   the `Subs/<media stem>/2_eng.srt` trees releases ship were orphaned when the video moved
   (~4.4k files). `planNestedSubtitles` handles both attributable layouts — a file NAMED for the
   media keeps its suffix chain verbatim (`.idx`/`.sub` pairs), and a file declaring a language
   inside a folder tied to the media becomes `<newStem>.<lang>[.modifier].<ext>`. A name with no
   language we recognise (`11_Français (Canadien).srt`) is still left behind and reported: the
   engine reports rather than guesses, always.

## Case-only sidecars deadlocked apply (2026-08-19)

Four items (3 Venture Bros, 1 Simpsons) soft-skipped with `sidecar target appeared since
verify` on every run for days. All four were case-only media renames (`Any Which Way But
Zeus` → `but Zeus`) whose `.eng.srt` needed the same case fix.

`verify` was right: its sidecar-collision pass skips a move whose `pathKey(from) ===
pathKey(to)`, because on a case-insensitive share those are one file and there is no
collision. `apply`'s moment-of-truth re-check then re-tested the same sidecars with a bare
`fs.stat(localTo)` and no such exemption — the share resolved that path back to the SOURCE
file, so apply concluded a target had appeared and soft-skipped the whole item. Forever:
nothing about the next run differs. The media file's own check never had this bug (it has
carried `!verify.caseOnly` all along), and the op-builder already computed per-sidecar
`caseOnly` and picked the right strategy, so the entire downstream pathway was correct —
only the gate in front of it disagreed. apply now applies the same exemption.

Worth noting for anything similar: **a check that opens the door must use the same equality
the checks behind it use.** `pathKey` exists precisely because these shares fold case; a raw
path comparison or a bare `stat` anywhere in a gate is the bug shape to look for.

The regression test needed the in-memory disk to actually behave like the share, so
`makeMemFs` gained a `caseInsensitive` option (see Testing) — without it the test passes on
the broken code, because an exact-string fs never reproduces the collision.

## Companion files: what moves with the media, and the attribution rule

Verified against the live library (2026-08-18) — every file type present is accounted for:

| Type | Count | Handling |
|---|---|---|
| `.mkv` / `.mp4` / `.avi` | 27.3k | the media itself |
| `.srt` | 4.5k | sidecar (7 subtitle formats supported: srt, ass, ssa, vtt, sub, idx, smi — a superset of what the library holds) |
| `.idx` + `.sub` | 32 + 32 | sidecar pairs; they ride along via the shared-stem rule, never re-interpreted |
| `.plexmatch` | 637 | one per show, written by apply |
| `.jpg` / `.nfo` | 27 | movie folders carry fixed-name assets (`poster.*`, `movie.nfo`, `theme.mp3`, …); anything else is left behind and reported |
| `.parts` | 24 | in-flight downloads — correctly invisible to the engine (Plex doesn't index them) |
| `.DS_Store` | 4 | Finder noise; the cleanup script treats a directory holding only these as empty |

**THE ATTRIBUTION RULE (2026-08-18, learned the hard way).** A companion file may only
be claimed when something ties it to THAT media file: it is NAMED for the media
(`<stem>.eng.srt`, `<stem>.idx`), or it sits in a folder that ties it there
(`Subs/<media stem>/…`, or a flat `Subs/` beside a directory holding exactly one media
file). **A language code is never sufficient on its own.** The first cut allowed
language-only matching, which quietly handed every episode's subtitles to whichever
episode ran first in a season folder with one shared `Subs/` directory — 607 files landed
against the wrong episode, and their rightful owners lost theirs. Callers report the
single-media case via `soleMediaInDir`; `naming.test.ts` locks the regression in.

## Artwork continuity (2026-08-17)

Plex can retire a library entry and build a fresh one when a file's folder changes, which
reverts to the agent's DEFAULT artwork — that silently cost ~103 films their uploaded
posters mid-sweep. apply now records which poster/background is showing BEFORE it touches
a file; confirm re-selects the same image afterwards on whichever entry owns the file.
Two traps worth remembering, both of which produced silent no-ops before they were found:

- **Write through `plexPut`, never global `fetch`.** Plex serves a self-signed certificate
  that `fetch` rejects outright — all 152 writes in the first attempt failed.
- **Select by the PHOTO's `ratingKey`** (`upload://posters/<hash>`), not by its
  item-scoped `key` URL. Plex answers **HTTP 200** to the `key` form and changes nothing.

A candidate's URL embeds the owning ratingKey, which is exactly what changes when an entry
is recreated, so `artworkIdentity()` matches on the stable part instead. Best-effort
throughout: artwork is cosmetic, confirmation is not, so a failure here never fails a run.

**Continuity must reach PAST the item being moved (2026-08-19).** For TV the moved item is
an EPISODE, and episodes carry no uploaded artwork at all (verified against Plex's own
metadata tree: uploads exist only for movies, shows, and seasons). The artwork an owner
curates lives on the SEASON and the SHOW, and those items are rebuilt too when their
folders change — so item-level continuity protected nothing on TV, and 478 hand-picked
season posters were lost before anyone noticed. apply now also captures the season's and
show's selections, and confirm restores them against the season/show as they stand AFTER
the move (their ratingKeys change as well, so the pre-move values must not be trusted).
Both are cached per run, so a 500-episode batch costs a couple of extra calls per show
rather than per file.

**Season artwork identifies itself differently.** A season's candidate is
`upload://posters/seasons/<n>/<hash>`, not the item-level `upload://posters/<hash>`.
Parsing only the item form made every season look unselected — a scan reported all 1,902
as broken with zero correct, which a control group of never-renamed shows disproved before
anything was written. If a scan ever claims 100% of anything is broken, check a group the
work never touched before believing it.

## One-time repair scripts (manual, dry-run by default, never scheduled)

- **`scripts/plex-rename-backfill-subtitles.ts`** — re-unites subtitles stranded by pre-fix runs,
  using the apply ledger's own from → to record to know where each belongs. Copy → checksum →
  delete, same procedure as the workflow. Ran 2026-08-17: 3,984 moved, 0 failed.
- **`scripts/plex-rename-cleanup-leftovers.ts`** — clears the old release folders of bonus
  featurettes Plex never indexed, orphaned release artwork/nfo, and husk directories kept alive
  by a Finder `.DS_Store`. Cross-checks every candidate against the live discover snapshot so a
  Plex-indexed file can NEVER be touched, only enters non-canonical folders, and moves everything
  into the share's own `#recycle/plex-rename-cleanup-<stamp>/` rather than unlinking. Ran
  2026-08-17: 570 files (75.4 GB) recycled, 648 empty directories removed, 0 failures — the
  library went from 195 non-canonical top-level folders to 44.
- **`scripts/plex-restore-uploaded-artwork.ts`** — re-selects uploaded artwork Plex
  deselected on entries it recreated before continuity existed. Only ever switches TO an
  upload, skips items already showing theirs. Ran 2026-08-18: 144 posters + 12 backgrounds
  restored across 2,280 items, verified by re-reading the selection back from Plex.
- **`scripts/plex-select-newest-upload.ts`** — where an item carries SEVERAL uploads (the
  owner replaced a poster and Plex kept both), selects the most recently uploaded one,
  dating them from the files in Plex's own metadata bundle since the API exposes no date.
  Ran 2026-08-18: 19 titles corrected, including Alien, where the first restore had
  reinstated a 2023 poster over the 2025 replacement.
- **`scripts/plex-restore-season-artwork.ts`** — restores custom SEASON posters the sweep
  deselected. Ran 2026-08-19: 478 restored, 1,424 already correct, 0 failures.
- **`scripts/plex-rename-repair-missubbed.ts`** — re-homes subtitles the language-only bug
  filed against the wrong episode, using the original name the disambiguator preserved, and
  only when the rightful episode's media file is in the same directory. Ran 2026-08-18:
  34 re-homed, 0 ambiguous, 0 failures.

**What the remaining 44 are** (none are bugs): the multi-version duplicates the engine
deliberately never names (one Plex title, two files — a human picks the keeper), downloads still
inside the 7-day `PLEX_RENAME_MIN_AGE_DAYS` window, a handful of unattributable subtitle variants,
and three harmless non-media files (an `index.json`, a `.blake3` checksum, and one of the owner's
own shell scripts) that the cleanup correctly refused to classify.

## Undo + journal

`journal.ts`: per-run NDJSON, `JournalWriter` fsyncs every record (and the journal dir at
create); `analyzeJournal` classifies complete/aborted/unresolved for crash recovery.
`move.ts`'s `performVerifiedMove` is the ONLY file-relocation primitive (copy → verify →
finalize → delete-source; case-only renames swap the last two so the verified partial guards
the bytes). `scripts/plex-rename-undo.ts` (manual, never scheduled, dry-run by default,
`--apply` to act) reverses completed ops newest-first with the SAME verified procedure, treats
every surprise as a loud conflict (occupied original, divergent duplicate, hand-edited
`.plexmatch`), and refuses when a journaled mount is absent. It never touches the apply ledger —
reprocessing an undone item is a manual unstick, same doctrine as plex-language-undo.

## Gates (contracts.ts)

discover→plan and apply→confirm are the sanctioned trivial minimum; **plan→verify and
verify→apply are REAL** (T574
pattern): plan's gate asserts every rename row has from ≠ to, target under the file's own library
root, and global collision-freedom; verify's gate asserts every eligible row has both local
paths mapped under configured shares, verified bytes > 0, and a well-formed sidecar list — exactly the malformations apply would
otherwise silently skip, failing loud at the boundary instead.

## Config (`config.ts`)

`PLEX_RENAME_PATH_MAP` (env-ONLY, no committed default — this repo is public and the share names
describe the owner's machine; empty map ⇒ everything `unmapped-path`, nothing can mutate),
`PLEX_RENAME_MIN_AGE_DAYS` (7), `PLEX_RENAME_MAX_PER_DAY` (30 — the daily move quota via the
job_usage meter, owner-raised in .env as trust grows), `PLEX_RENAME_MAX_VOLUME_UTILIZATION` (92 — the volume-overburden cap above),
`PLEX_RENAME_APPLY_ENABLED` (0 — the
probation gate: flipping it is a deliberate .env edit + daemon restart, never a dashboard click),
`PLEX_RENAME_CONFIRM_GRACE_DAYS` (14). Sections reuse `PLEX_MOVIE_SECTION`/`PLEX_TV_SECTION`.
Data dir routes through `resolveWorkflowDataDir` (the mandatory test guard).

## Probation plan (owner-decided)

The workflow runs DAILY report-only: plans + verify verdicts accumulate on the dashboard. The flip
to real applying requires ALL of: (1) daily rename plans reviewed for a while and trusted, (2) the
separate `plex-library-guard` workflow (the independent deletion detector) landed and running,
(3) both NAS shares mounted persistently on the Mini (`/Volumes/NAS-Cool Shared Drive` and
`/Volumes/NAS-Cool Shared Drive - 2` — the second is often NOT mounted), (4)
`PLEX_RENAME_APPLY_ENABLED=1` set in `.env` + daemon kickstart. Quota stays 30/day until earned.

## Testing

Every stage's `run*()` takes injectable seams (Plex fetchers / `ReadFsSeam`/`WriteFsSeam` /
ledger readers / quota / `now()`) — tests never touch a live Plex or the real disk (`memfs.ts` is
the shared in-memory write seam; journals go to per-test temp dirs). `makeMemFs` is
exact-string by default; pass `{ caseInsensitive: true }` to make it fold case like the real
SMB shares, which is the only way a case-only rename test can fail on broken code. `naming.test.ts` is the
table-driven engine suite (real-library-shaped cases: anime brackets, Steins;Gate, loose movies,
date-based shows, specials, e100, collisions). Stage tests cover: snapshot re-marking (discover),
decision recomputation + collision downgrades (plan), every verify ineligibility reason including
the mount-missing vs file-missing distinction and all three `.plexmatch` outcomes,
`move.test.ts`'s hook-before-effect ordering + checksum-mismatch + caseOnly ordering,
`journal.test.ts`'s torn-tail tolerance + unresolved classification, `apply.test.ts`'s rehearsal
/ mount-absent / quota / soft-skip / checksum-failure / once-ever / crash-reconciliation-matrix /
refresh-fallback coverage, `confirm.test.ts`'s four outcomes, and the undo script's
conflict-never-overwrite suite (`scripts/plex-rename-undo.test.ts`).
