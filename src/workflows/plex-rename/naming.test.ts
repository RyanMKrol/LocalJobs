// Pure-logic tests for the plex-rename naming engine — no IO, no live Plex.
import assert from 'node:assert/strict';
import {
  buildPlexmatch,
  currentPathGuard,
  decideRename,
  finalizePlan,
  hasExclusionHazard,
  planNestedSubtitles,
  subtitleSuffix,
  pathKey,
  planSidecars,
  posixBasename,
  posixDirname,
  resolveLibraryRoot,
  sanitizeComponent,
  splitExt,
  type DirEntry,
  type LibraryRoot,
  type NamingOp,
  type PlanEntry,
  type RenameDecision,
  type RenameInput,
} from './naming.js';

const ROOTS: LibraryRoot[] = [
  { path: '/volume1/NAS-Cool Shared Drive/Movies', kind: 'movie' },
  { path: '/volume1/NAS-Cool Shared Drive/TV', kind: 'tv' },
  { path: '/volume2/NAS-Cool Shared Drive - 2/Movies', kind: 'movie' },
  { path: '/volume2/NAS-Cool Shared Drive - 2/TV', kind: 'tv' },
];

const GB = 1024 * 1024 * 1024;

function movieInput(
  overrides: Omit<Partial<RenameInput>, 'movie'> & { movie?: Partial<import('./naming.js').MovieRef> } = {},
): RenameInput {
  const { movie, ...rest } = overrides;
  return {
    kind: 'movie',
    file: '/volume1/NAS-Cool Shared Drive/Movies/10.Cloverfield.Lane.2016.2160p.UHD.BluRay.X265-IAMABLE/10.Cloverfield.Lane.2016.2160p.mkv',
    partId: 101,
    partSize: 8 * GB,
    mediaCount: 1,
    partCount: 1,
    partIndex: 0,
    movie: { ratingKey: '11', title: '10 Cloverfield Lane', year: 2016, tmdbId: 333371, imdbId: 'tt1179933', ...movie },
    siblings: [],
    roots: ROOTS,
    ...rest,
  } as RenameInput;
}

function episodeInput(
  overrides: Omit<Partial<RenameInput>, 'show'> & {
    show?: Partial<import('./naming.js').ShowRef>;
    episodes?: RenameInput['episodes'];
  } = {},
): RenameInput {
  const { show, episodes, ...rest } = overrides;
  return {
    kind: 'episode',
    file: '/volume1/NAS-Cool Shared Drive/TV/[Erai-raws] Mob Psycho 100 II - 01 ~ 13 [1080p]/[Erai-raws] Mob Psycho 100 II - 05 [1080p].mkv',
    partId: 201,
    partSize: 1 * GB,
    mediaCount: 1,
    partCount: 1,
    partIndex: 0,
    show: { ratingKey: '21', title: 'Mob Psycho 100', year: 2016, tvdbId: 305074, tmdbId: 67195, ...show },
    episodes: episodes ?? [{ ratingKey: '22', season: 2, episode: 5, title: 'Discord ~Choices~' }],
    siblings: [],
    roots: ROOTS,
    ...rest,
  } as RenameInput;
}

function mediaMove(d: RenameDecision): Extract<NamingOp, { op: 'move' }> {
  assert.equal(d.kind, 'rename', 'expected a rename decision');
  const move = (d as Extract<RenameDecision, { kind: 'rename' }>).ops.find((o) => o.op === 'move' && o.role === 'media');
  assert.ok(move, 'expected a media move op');
  return move as Extract<NamingOp, { op: 'move' }>;
}

// ── path helpers ──
{
  assert.equal(posixDirname('/a/b/c.mkv'), '/a/b');
  assert.equal(posixDirname('/c.mkv'), '/');
  assert.equal(posixBasename('/a/b/c.mkv'), 'c.mkv');
  assert.deepEqual(splitExt('Show - s01e01.mkv'), { stem: 'Show - s01e01', ext: 'mkv' });
  assert.deepEqual(splitExt('noext'), { stem: 'noext', ext: '' });
  assert.deepEqual(splitExt('.hidden'), { stem: '.hidden', ext: '' });
  assert.equal(pathKey('/A/É.mkv'), pathKey(`/a/É.mkv`), 'pathKey folds case AND unicode normalization');
  console.log('  ✓ naming: posix path helpers + pathKey');
}

// ── sanitizeComponent ──
{
  assert.equal(sanitizeComponent('Steins;Gate'), 'SteinsGate', 'semicolons deleted (scanner truncates at ;)');
  assert.equal(sanitizeComponent('Dr. Stone: New World'), 'Dr. Stone - New World', 'colon → " - " with leading space');
  assert.equal(sanitizeComponent('[Oshi no Ko]'), '(Oshi no Ko)', 'square brackets → parens (never Plex-ignored)');
  assert.equal(sanitizeComponent('What If...?'), 'What If', 'illegal ? dropped, then now-trailing dots trimmed (SMB rejects them)');
  assert.equal(sanitizeComponent('Face/Off'), 'Face Off', 'slash → space');
  assert.equal(sanitizeComponent('AC\\DC Live'), 'AC DC Live', 'backslash → space');
  assert.equal(sanitizeComponent('Movie {tmdb-99} hack'), 'Movie tmdb-99 hack', 'braces deleted (reserved for hints)');
  assert.equal(sanitizeComponent('a   b\t c'), 'a b c', 'whitespace collapsed');
  assert.equal(sanitizeComponent('Trailing... '), 'Trailing', 'trailing dots/spaces trimmed');
  assert.equal(sanitizeComponent('<>|"*?'), null, 'nothing survives → null');
  const nfd = 'Amélie'; // NFD é
  assert.equal(sanitizeComponent(nfd), 'Amélie'.normalize('NFC'), 'NFD input → NFC output');
  // Grapheme-safe clamp: a long Japanese title truncates without splitting a codepoint.
  const long = '氷菓'.repeat(100);
  const clamped = sanitizeComponent(long, 30);
  assert.ok(clamped && Buffer.byteLength(clamped, 'utf8') <= 30, 'clamped within the byte budget');
  assert.ok([...clamped!].every((c) => c === '氷' || c === '菓'), 'no split codepoints/mojibake');
  console.log('  ✓ naming: sanitizeComponent pipeline (Steins;Gate, colons, brackets, NFC, clamp)');
}

// ── hasExclusionHazard ──
{
  assert.ok(hasExclusionHazard('Extras', { isDir: true }), 'folder exactly "Extras" is hazardous');
  assert.ok(hasExclusionHazard('plex versions', { isDir: true }), 'case-insensitive special-dir match');
  assert.ok(!hasExclusionHazard('Bonus Family (2017)', { isDir: true }), 'a title merely containing a keyword is fine');
  assert.ok(hasExclusionHazard('Sample People (2000).mkv', { isDir: false, sizeBytes: 200 * 1024 * 1024 }), 'word "sample" + <300MB file');
  assert.ok(!hasExclusionHazard('Sample People (2000).mkv', { isDir: false, sizeBytes: 1 * GB }), '≥300MB file with "sample" is fine');
  assert.ok(!hasExclusionHazard('Samples of Life.mkv', { isDir: false, sizeBytes: 100 }), '"Samples" ≠ word-boundary "sample"');
  assert.ok(hasExclusionHazard('sample.mkv', { isDir: false }), 'unknown size + "sample" → hazardous (conservative)');
  console.log('  ✓ naming: hasExclusionHazard (special dirs, <300MB sample rule)');
}

// ── resolveLibraryRoot + currentPathGuard ──
{
  const r = resolveLibraryRoot('/volume1/NAS-Cool Shared Drive/Movies/x/y.mkv', ROOTS);
  assert.equal(r?.path, '/volume1/NAS-Cool Shared Drive/Movies');
  assert.equal(resolveLibraryRoot('/volume3/Other/y.mkv', ROOTS), null, 'unmapped path → null');
  // Longest prefix wins when roots nest.
  const nested = [
    { path: '/a', kind: 'movie' as const },
    { path: '/a/b', kind: 'tv' as const },
  ];
  assert.equal(resolveLibraryRoot('/a/b/c.mkv', nested)?.path, '/a/b');

  assert.equal(currentPathGuard('/v/Movies/Heat (1995)/Heat.mkv'), null);
  assert.equal(currentPathGuard('/v/Movies/M/Plex Versions/Optimized for Mobile/m.mp4')?.reason, 'inside-plex-versions');
  assert.equal(currentPathGuard('/v/Movies/M/VIDEO_TS/VTS_01_1.VOB')?.reason, 'disc-image');
  assert.equal(currentPathGuard('/v/Movies/M/movie.iso')?.reason, 'disc-image');
  assert.equal(currentPathGuard('/v/Movies/#recycle/m.mkv')?.reason, 'hidden-or-system-path');
  assert.equal(currentPathGuard('/v/TV/@eaDir/x.mkv')?.reason, 'hidden-or-system-path');
  assert.equal(currentPathGuard('/v/TV/.hidden/x.mkv')?.reason, 'hidden-or-system-path');
  console.log('  ✓ naming: resolveLibraryRoot longest-prefix + currentPathGuard skip classes');
}

// ── movie decisions ──
{
  // Loose file in Movies/ root → canonical folder created, file moved in.
  const loose = decideRename(
    movieInput({
      file: '/volume1/NAS-Cool Shared Drive/Movies/10.Cloverfield.Lane.2016.2160p.mkv',
      siblings: [{ name: '10.Cloverfield.Lane.2016.2160p.mkv', isDir: false }],
    }),
  );
  assert.equal(loose.kind, 'rename');
  const looseMove = mediaMove(loose);
  assert.equal(
    looseMove.to,
    '/volume1/NAS-Cool Shared Drive/Movies/10 Cloverfield Lane (2016) {tmdb-333371}/10 Cloverfield Lane (2016) {tmdb-333371}.mkv',
    'tmdb preferred over imdb; folder + file carry the id tag',
  );
  assert.equal((loose as Extract<RenameDecision, { kind: 'rename' }>).ops[0].op, 'mkdir', 'mkdir precedes the move');

  // Release folder: matching sidecar moves, junk left behind.
  const dir = '/volume1/NAS-Cool Shared Drive/Movies/22 Jump Street (2014) + Extras (1080p)';
  const rel = decideRename(
    movieInput({
      file: `${dir}/22.Jump.Street.2014.mkv`,
      movie: { ratingKey: '12', title: '22 Jump Street', year: 2014, tmdbId: 187017 },
      siblings: [
        { name: '22.Jump.Street.2014.mkv', isDir: false },
        { name: '22.Jump.Street.2014.en.srt', isDir: false },
        { name: 'RARBG.txt', isDir: false },
        { name: 'poster.jpg', isDir: false },
        { name: 'Featurettes', isDir: true },
      ],
    }),
  );
  assert.equal(rel.kind, 'rename');
  const relPlan = rel as Extract<RenameDecision, { kind: 'rename' }>;
  const sub = relPlan.ops.find((o) => o.op === 'move' && o.role === 'sidecar') as Extract<NamingOp, { op: 'move' }>;
  assert.equal(sub.to, '/volume1/NAS-Cool Shared Drive/Movies/22 Jump Street (2014) {tmdb-187017}/22 Jump Street (2014) {tmdb-187017}.en.srt');
  const asset = relPlan.ops.find((o) => o.op === 'move' && o.role === 'asset') as Extract<NamingOp, { op: 'move' }>;
  assert.equal(asset.to, '/volume1/NAS-Cool Shared Drive/Movies/22 Jump Street (2014) {tmdb-187017}/poster.jpg', 'fixed asset moves unchanged');
  assert.ok(relPlan.leftBehind.includes(`${dir}/RARBG.txt`), 'release junk left behind + reported');

  // imdb-only fallback.
  const imdbOnly = decideRename(movieInput({ movie: { tmdbId: undefined, imdbId: 'tt1179933' } }));
  assert.ok(mediaMove(imdbOnly).to.includes('{imdb-tt1179933}'), 'imdb fallback when tmdb absent');

  // Missing id / year.
  const noId = decideRename(movieInput({ movie: { tmdbId: undefined, imdbId: undefined } }));
  assert.equal(noId.kind, 'skip');
  assert.equal((noId as Extract<RenameDecision, { kind: 'skip' }>).reason, 'missing-id');
  const noYear = decideRename(movieInput({ movie: { year: undefined } }));
  assert.equal((noYear as Extract<RenameDecision, { kind: 'skip' }>).reason, 'missing-year');

  // Edition on file only; multi-part; multi-version skip.
  const edition = decideRename(movieInput({ movie: { editionTitle: "Director's Cut" } }));
  const edMove = mediaMove(edition);
  assert.ok(edMove.to.endsWith("{tmdb-333371} {edition-Director's Cut}.mkv"), 'edition tag on the file name');
  assert.ok(posixDirname(edMove.to).endsWith('{tmdb-333371}'), 'folder stays plain (editions share it)');

  const pt2 = decideRename(movieInput({ partCount: 2, partIndex: 1 }));
  assert.ok(mediaMove(pt2).to.endsWith(' - pt2.mkv'), 'multi-part gets " - ptN" from Plex part order');

  const mv = decideRename(movieInput({ mediaCount: 2 }));
  assert.equal((mv as Extract<RenameDecision, { kind: 'skip' }>).reason, 'multi-version');

  // Sample hazard on a small file whose TITLE contains the word.
  const sample = decideRename(
    movieInput({ partSize: 100 * 1024 * 1024, movie: { title: 'Sample People', year: 2000, tmdbId: 77 } }),
  );
  assert.equal((sample as Extract<RenameDecision, { kind: 'skip' }>).reason, 'sample-filter-hazard');

  // Unmapped root.
  const unmapped = decideRename(movieInput({ file: '/somewhere/else/m.mkv' }));
  assert.equal((unmapped as Extract<RenameDecision, { kind: 'skip' }>).reason, 'unmapped-root');
  console.log('  ✓ naming: movie decisions (loose file, release folder, ids, edition, pt, skips)');
}

// ── episode decisions ──
{
  const anime = decideRename(episodeInput({}));
  assert.equal(anime.kind, 'rename');
  const animeMove = mediaMove(anime);
  assert.equal(
    animeMove.to,
    '/volume1/NAS-Cool Shared Drive/TV/Mob Psycho 100 (2016) {tvdb-305074}/Season 02/Mob Psycho 100 (2016) - s02e05 - Discord ~Choices~.mkv',
    'tvdb preferred; id on show folder only; Plex-belief SxxExx',
  );
  const animePlan = anime as Extract<RenameDecision, { kind: 'rename' }>;
  const pm = animePlan.ops.find((o) => o.op === 'write-plexmatch') as Extract<NamingOp, { op: 'write-plexmatch' }>;
  assert.equal(pm.dir, '/volume1/NAS-Cool Shared Drive/TV/Mob Psycho 100 (2016) {tvdb-305074}');
  assert.ok(pm.content.includes('tvdbid: 305074') && pm.content.includes('tmdbid: 67195'), 'plexmatch pins every known id');
  assert.ok(!pm.content.includes('ep:'), 'no per-episode hint lines');
  assert.ok(
    animePlan.ops.findIndex((o) => o.op === 'write-plexmatch') < animePlan.ops.findIndex((o) => o.op === 'move'),
    'plexmatch is written before any file moves in',
  );

  // Specials → Season 00.
  const special = decideRename(episodeInput({ episodes: [{ ratingKey: 'x', season: 0, episode: 3, title: 'OVA' }] }));
  assert.ok(mediaMove(special).to.includes('/Season 00/'), 'specials land in Season 00');
  assert.ok(mediaMove(special).to.includes('s00e03'), 's00eNN token');

  // Episode >99 widens naturally.
  const e100 = decideRename(episodeInput({ episodes: [{ ratingKey: 'x', season: 1, episode: 100, title: 'Centennial' }] }));
  assert.ok(mediaMove(e100).to.includes('s01e100'), 's01e100 (3-digit widens, no truncation)');

  // Multi-episode contiguous / non-contiguous.
  const multi = decideRename(
    episodeInput({
      episodes: [
        { ratingKey: 'a', season: 1, episode: 1, title: 'Part 1' },
        { ratingKey: 'b', season: 1, episode: 2, title: 'Part 2' },
      ],
    }),
  );
  assert.ok(mediaMove(multi).to.includes('s01e01-e02'), 'contiguous same-season range token');
  const crossSeason = decideRename(
    episodeInput({
      episodes: [
        { ratingKey: 'a', season: 1, episode: 12, title: 'A' },
        { ratingKey: 'b', season: 2, episode: 1, title: 'B' },
      ],
    }),
  );
  assert.equal((crossSeason as Extract<RenameDecision, { kind: 'skip' }>).reason, 'non-contiguous-multi-episode');

  // Date-based shows.
  const daily = decideRename(
    episodeInput({ episodes: [{ ratingKey: 'x', season: 2024, episode: 65, title: 'March 5, 2024', airDate: '2024-03-05' }] }),
  );
  assert.ok(mediaMove(daily).to.includes('/Season 2024/'), 'date-based season folder is the year');
  assert.ok(mediaMove(daily).to.includes(' - 2024-03-05 - '), 'date token replaces sNNeNN');
  const dailyNoDate = decideRename(episodeInput({ episodes: [{ ratingKey: 'x', season: 2024, episode: 65 }] }));
  assert.equal((dailyNoDate as Extract<RenameDecision, { kind: 'skip' }>).reason, 'missing-episode-numbering');

  // Show year optional; missing id skips; existing plexmatch skips.
  const noYear = decideRename(episodeInput({ show: { year: undefined } }));
  assert.ok(mediaMove(noYear).to.includes('/Mob Psycho 100 {tvdb-305074}/'), 'year omitted when unknown (id carries matching)');
  const noIds = decideRename(episodeInput({ show: { tvdbId: undefined, tmdbId: undefined } }));
  assert.equal((noIds as Extract<RenameDecision, { kind: 'skip' }>).reason, 'missing-id');
  const hasPm = decideRename(episodeInput({ show: { hasExistingPlexmatch: true } }));
  assert.equal((hasPm as Extract<RenameDecision, { kind: 'skip' }>).reason, 'existing-plexmatch');

  // Placeholder episode titles dropped.
  const placeholder = decideRename(episodeInput({ episodes: [{ ratingKey: 'x', season: 2, episode: 5, title: 'Episode 5' }] }));
  assert.ok(mediaMove(placeholder).to.endsWith(' - s02e05.mkv'), 'placeholder "Episode N" title adds nothing');

  // Length ladder: an absurd episode title is dropped rather than failing.
  const longTitle = decideRename(episodeInput({ episodes: [{ ratingKey: 'x', season: 2, episode: 5, title: 'x'.repeat(400) }] }));
  assert.ok(mediaMove(longTitle).to.endsWith(' - s02e05.mkv'), 'over-budget title dropped, rename still proceeds');
  console.log('  ✓ naming: episode decisions (anime SxxEyy, specials, e100, multi-ep, date-based, plexmatch)');
}

// ── sidecar planning details ──
{
  const siblings: DirEntry[] = [
    { name: 'Old.Name.mkv', isDir: false },
    { name: 'Old.Name.en.forced.srt', isDir: false },
    { name: 'Old.Name.idx', isDir: false },
    { name: 'Old.Name.sub', isDir: false },
    { name: 'English.srt', isDir: false },
    { name: 'movie.nfo', isDir: false },
    { name: '.plexmatch', isDir: false },
  ];
  const plan = planSidecars('/v/Movies/Old', 'Old.Name', '/v/Movies/New Folder', 'New Name', siblings, {
    moveFixedAssets: true,
    mediaName: 'Old.Name.mkv',
  });
  const tos = plan.moves.map((m) => m.to);
  assert.ok(tos.includes('/v/Movies/New Folder/New Name.en.forced.srt'), 'suffix chain preserved verbatim');
  assert.ok(tos.includes('/v/Movies/New Folder/New Name.idx') && tos.includes('/v/Movies/New Folder/New Name.sub'), 'idx/sub pair in lockstep');
  assert.ok(tos.includes('/v/Movies/New Folder/movie.nfo'), 'fixed-name movie.nfo moves unchanged');
  assert.ok(plan.leftBehind.includes('/v/Movies/Old/English.srt'), 'non-matching subtitle left behind (never guess language)');
  assert.ok(plan.leftBehind.includes('/v/Movies/Old/.plexmatch'), 'an existing .plexmatch is never moved');

  // Episodes do NOT move fixed assets (a release folder's poster does not belong in a Season dir).
  const epPlan = planSidecars('/v/TV/Rel', 'Old.Name', '/v/TV/Show/Season 01', 'New Name', [
    { name: 'Old.Name.mkv', isDir: false },
    { name: 'poster.jpg', isDir: false },
  ], { moveFixedAssets: false, mediaName: 'Old.Name.mkv' });
  assert.equal(epPlan.moves.length, 0);
  assert.ok(epPlan.leftBehind.includes('/v/TV/Rel/poster.jpg'));
  console.log('  ✓ naming: sidecar planning (suffix chains, idx/sub, assets, left-behind)');
}

// ── already-canonical + caseOnly ──
{
  const canonicalPath =
    '/volume1/NAS-Cool Shared Drive/Movies/10 Cloverfield Lane (2016) {tmdb-333371}/10 Cloverfield Lane (2016) {tmdb-333371}.mkv';
  const done = decideRename(
    movieInput({ file: canonicalPath, siblings: [{ name: posixBasename(canonicalPath), isDir: false }] }),
  );
  assert.equal(done.kind, 'already-canonical', 'exact match converges to a no-op');

  const caseVariant = canonicalPath.replace('10 Cloverfield Lane (2016) {tmdb-333371}.mkv', '10 cloverfield lane (2016) {tmdb-333371}.mkv');
  const caseFix = decideRename(movieInput({ file: caseVariant, siblings: [{ name: posixBasename(caseVariant), isDir: false }] }));
  assert.equal(caseFix.kind, 'rename', 'case-only difference still plans a rename');
  assert.equal(mediaMove(caseFix).caseOnly, true, 'flagged caseOnly for the two-step apply');
  console.log('  ✓ naming: already-canonical convergence + caseOnly flag');
}

// ── chooseShowHomeRoots + cross-share consolidation ──
{
  const { chooseShowHomeRoots } = await import('./naming.js');
  // A show split across shares: 33 big files on volume1, 23 on volume2 → volume1 wins.
  const files = [
    ...Array.from({ length: 33 }, () => ({ showRatingKey: 'hmt', rootPath: '/volume1/NAS-Cool Shared Drive/TV', bytes: 2 * GB })),
    ...Array.from({ length: 23 }, () => ({ showRatingKey: 'hmt', rootPath: '/volume2/NAS-Cool Shared Drive - 2/TV', bytes: 2 * GB })),
    { showRatingKey: 'other', rootPath: '/volume2/NAS-Cool Shared Drive - 2/TV', bytes: 1 * GB },
    { showRatingKey: 'nowhere', rootPath: '', bytes: 1 * GB }, // unmapped — never a candidate
  ];
  const homes = chooseShowHomeRoots(files);
  assert.equal(homes.get('hmt'), '/volume1/NAS-Cool Shared Drive/TV', 'majority-bytes share wins');
  assert.equal(homes.get('other'), '/volume2/NAS-Cool Shared Drive - 2/TV');
  assert.equal(homes.has('nowhere'), false);

  // Deterministic tie-break: equal weight → lexicographically first root.
  const tied = chooseShowHomeRoots([
    { showRatingKey: 's', rootPath: '/volume2/B/TV', bytes: 100 },
    { showRatingKey: 's', rootPath: '/volume1/A/TV', bytes: 100 },
  ]);
  assert.equal(tied.get('s'), '/volume1/A/TV');

  // homeRootPath overrides the file's own root for the TARGET — a volume2
  // episode of a volume1-homed show plans a cross-share move into ONE folder.
  const crossShare = decideRename(
    episodeInput({
      file: '/volume2/NAS-Cool Shared Drive - 2/TV/The.Handmaids.Tale.S02/The.Handmaids.Tale.S02E01.mkv',
      homeRootPath: '/volume1/NAS-Cool Shared Drive/TV',
      show: { ratingKey: 'hmt', title: "The Handmaid's Tale", year: 2017, tvdbId: 321239 },
      episodes: [{ ratingKey: 'e', season: 2, episode: 1, title: 'June' }],
      roots: [
        { path: '/volume1/NAS-Cool Shared Drive/TV', kind: 'tv' },
        { path: '/volume2/NAS-Cool Shared Drive - 2/TV', kind: 'tv' },
      ],
    }),
  );
  assert.equal(
    mediaMove(crossShare).to,
    "/volume1/NAS-Cool Shared Drive/TV/The Handmaid's Tale (2017) {tvdb-321239}/Season 02/The Handmaid's Tale (2017) - s02e01 - June.mkv",
    'the target lives under the HOME root, not the file\'s own share',
  );
  console.log('  ✓ naming: chooseShowHomeRoots majority-bytes + cross-share consolidation target');
}

// ── buildPlexmatch ──
{
  const content = buildPlexmatch({ ratingKey: '1', title: 'Steins;Gate\nX', year: 2011, tvdbId: 244061, tmdbId: 42509, imdbId: 'tt1910272' });
  assert.equal(content, 'title: Steins;Gate X\nyear: 2011\ntvdbid: 244061\ntmdbid: 42509\nimdbid: tt1910272\n', 'raw title (newlines stripped only) + all ids');
  const minimal = buildPlexmatch({ ratingKey: '1', title: 'Show', tvdbId: 5 });
  assert.equal(minimal, 'title: Show\ntvdbid: 5\n', 'unknown fields omitted');
  console.log('  ✓ naming: buildPlexmatch content');
}

// ── finalizePlan ──
{
  const a = movieInput({ file: '/volume1/NAS-Cool Shared Drive/Movies/CopyA/m.mkv' });
  const b = movieInput({ file: '/volume1/NAS-Cool Shared Drive/Movies/CopyB/m.mkv' });
  const entries: PlanEntry[] = [
    { key: 'a', decision: decideRename(a) },
    { key: 'b', decision: decideRename(b) },
  ];
  const out = finalizePlan(entries, new Set([pathKey(a.file), pathKey(b.file)]));
  for (const e of out) {
    assert.equal(e.decision.kind, 'skip', 'both same-target items downgraded');
    assert.equal((e.decision as Extract<RenameDecision, { kind: 'skip' }>).reason, 'target-collision');
  }

  // Target already on disk → skip; own current path (caseOnly) is NOT a collision.
  const solo = movieInput({});
  const soloDecision = decideRename(solo);
  const targetKey = pathKey((soloDecision as Extract<RenameDecision, { kind: 'rename' }>).targetPath);
  const clash = finalizePlan([{ key: 's', decision: soloDecision }], new Set([pathKey(solo.file), targetKey]));
  assert.equal((clash[0].decision as Extract<RenameDecision, { kind: 'skip' }>).reason, 'target-collision');

  const caseVariantFile =
    '/volume1/NAS-Cool Shared Drive/Movies/10 Cloverfield Lane (2016) {tmdb-333371}/10 cloverfield lane (2016) {tmdb-333371}.mkv';
  const caseInput = movieInput({ file: caseVariantFile, siblings: [{ name: posixBasename(caseVariantFile), isDir: false }] });
  const caseDecision = decideRename(caseInput);
  const caseOut = finalizePlan([{ key: 'c', decision: caseDecision }], new Set([pathKey(caseVariantFile)]));
  assert.equal(caseOut[0].decision.kind, 'rename', 'a caseOnly rename is not misread as a disk collision');

  // plexmatch dedup: two episodes of one show → exactly one write-plexmatch op.
  const ep1 = decideRename(episodeInput({}));
  const ep2 = decideRename(
    episodeInput({
      file: '/volume1/NAS-Cool Shared Drive/TV/[Erai-raws] Mob Psycho 100 II - 01 ~ 13 [1080p]/[Erai-raws] Mob Psycho 100 II - 06 [1080p].mkv',
      episodes: [{ ratingKey: '23', season: 2, episode: 6, title: 'Poor Lonely Whitey' }],
    }),
  );
  const epOut = finalizePlan(
    [
      { key: 'e1', decision: ep1 },
      { key: 'e2', decision: ep2 },
    ],
    new Set(),
  );
  const pmCount = epOut
    .flatMap((e) => (e.decision.kind === 'rename' ? e.decision.ops : []))
    .filter((o) => o.op === 'write-plexmatch').length;
  assert.equal(pmCount, 1, 'one .plexmatch per show folder across the whole plan');

  // Determinism: shuffled input order → same decision per key.
  const shuffled = finalizePlan(
    [
      { key: 'e2', decision: ep2 },
      { key: 'e1', decision: ep1 },
    ],
    new Set(),
  );
  const kindsA = new Map(epOut.map((e) => [e.key, e.decision.kind]));
  const kindsB = new Map(shuffled.map((e) => [e.key, e.decision.kind]));
  assert.deepEqual(Object.fromEntries(kindsA), Object.fromEntries(kindsB), 'input order never changes decisions');
  console.log('  ✓ naming: finalizePlan (collisions, disk clash, caseOnly exemption, plexmatch dedup, determinism)');
}


// ── Nested release-layout subtitles (2026-08) ─────────────────────────────────
// Videos were moved out from under `Subs/<media stem>/2_eng.srt` trees during the
// backlog sweep, orphaning thousands of subtitle files. These lock in the mapping.
{
  assert.equal(subtitleSuffix('2_eng.srt'), '.eng.srt');
  assert.equal(subtitleSuffix('3_English.srt'), '.eng.srt');
  assert.equal(subtitleSuffix('English.forced.srt'), '.eng.forced.srt');
  assert.equal(subtitleSuffix('4_spa.ass'), '.spa.ass');
  assert.equal(subtitleSuffix('12_eng_sdh.srt'), '.eng.sdh.srt');
  assert.equal(subtitleSuffix('10_fre,Français.srt'), '.fre.srt', 'comma-joined native names still declare a code');
  assert.equal(subtitleSuffix('2_eng,English (SDH).srt'), '.eng.sdh.srt', 'bracketed modifiers are preserved');
  assert.equal(subtitleSuffix('2_und.srt'), null, 'unknown language is never guessed');
  assert.equal(subtitleSuffix('readme.txt'), null, 'not a subtitle at all');
  assert.equal(subtitleSuffix('eng.mkv'), null, 'never a video container');

  const mapped = planNestedSubtitles(
    '/lib/Rel',
    'Show.S01E01.REL',
    '/lib/Show (2019) {tvdb-1}/Season 01',
    'Show (2019) - s01e01 - Pilot',
    [
      { relPath: 'Subs/Show.S01E01.REL/2_eng.srt' },
      { relPath: 'Subs/Show.S01E01.REL/3_spa.srt' },
      { relPath: 'Subs/2_eng.srt' },
    ],
  );
  assert.deepEqual(
    mapped.moves.map((m) => m.to),
    [
      '/lib/Show (2019) {tvdb-1}/Season 01/Show (2019) - s01e01 - Pilot.eng.srt',
      '/lib/Show (2019) {tvdb-1}/Season 01/Show (2019) - s01e01 - Pilot.spa.srt',
      '/lib/Show (2019) {tvdb-1}/Season 01/Show (2019) - s01e01 - Pilot.eng.2_eng.srt',
    ],
  );
  assert.equal(
    mapped.moves.every((m) => m.role === 'sidecar'),
    true,
  );

  // Flat Subs/ holding files NAMED for the media (the .idx/.sub release layout).
  const named = planNestedSubtitles('/lib/Rel', 'Killing.Eve.S02E03.REL', '/lib/KE/Season 02', 'Killing Eve - s02e03', [
    { relPath: 'Subs/Killing.Eve.S02E03.REL.idx' },
    { relPath: 'Subs/Killing.Eve.S02E03.REL.sub' },
    { relPath: 'Subs/Killing.Eve.S02E03.REL.en.forced.srt' },
  ]);
  assert.deepEqual(
    named.moves.map((m) => m.to),
    [
      '/lib/KE/Season 02/Killing Eve - s02e03.idx',
      '/lib/KE/Season 02/Killing Eve - s02e03.sub',
      '/lib/KE/Season 02/Killing Eve - s02e03.en.forced.srt',
    ],
  );

  const refused = planNestedSubtitles('/lib/Rel', 'Show.S01E01.REL', '/lib/New', 'New Name', [
    { relPath: 'Subs/Some.Other.Episode/2_eng.srt' },
    { relPath: 'Subs/Show.S01E01.REL/unknown.srt' },
    { relPath: 'Extras/clip.srt' },
    { relPath: 'Subs/a/b/c/2_eng.srt' },
  ]);
  assert.equal(refused.moves.length, 0, 'nothing ambiguous is ever moved');
  assert.deepEqual(refused.leftBehind.sort(), [
    '/lib/Rel/Subs/Show.S01E01.REL/unknown.srt',
    '/lib/Rel/Subs/Some.Other.Episode/2_eng.srt',
    '/lib/Rel/Subs/a/b/c/2_eng.srt',
  ]);
  console.log('  ✓ naming: nested release-layout subtitles (Subs/<stem>/<lang>) map beside the media');
}

console.log('  ✓ plex-rename naming engine tests passed');
