// The data the perfumes stages hand to each other.
//
//   find-url ──urls──▶ fetch ──pages──▶ parse ──data──▶ build ──▶ profiles
//      └──────────────────urls───────────────────────────▲
//
// Every one of these is a CUMULATIVE store: a perfume is resolved, fetched,
// parsed and built once, and each stage adds its result to what earlier runs
// left. So a check here is about SHAPE, not about there being something new: an
// empty store is a legitimate state (nothing resolved yet, or a run that was
// rate-limited before its first item), while a store holding the wrong kind of
// thing is drift (Fragrantica changed its page, a parse produced shapeless
// blobs) and fails at the boundary where it appears.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { dirArtifact, fromChecks, jsonArtifact } from '../../engine/index.js';
import type { DirListing, ExpectationResult } from '../../engine/index.js';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const withExt = (d: DirListing, ext: string) => d.files.filter((f) => f.endsWith(ext));
const idOf = (file: string) => file.replace(/\.[^.]+$/, '');

export const FRAGRANTICA_URL = /^https?:\/\/[^\s]*fragrantica\.com\//i;

/** find-url's store: perfume id → Fragrantica page URL. */
export const fragranticaUrls = jsonArtifact<Record<string, string>>({
  key: 'fragrantica-urls',
  description: 'Each perfume id mapped to its Fragrantica page URL. Grows as perfumes are resolved.',
  shape: {
    summary: 'A lookup of each perfume id to its Fragrantica page URL.',
    format: 'JSON object { perfumeId: url }',
    expectations: [
      { label: 'A JSON object', detail: 'The file parses as an object of id to URL.' },
      { label: 'Every value is a Fragrantica URL', detail: 'Each value points at fragrantica.com. A lookup that stops producing real URLs is caught here.' },
    ],
  },
  check(v) {
    const isObj = v !== null && typeof v === 'object' && !Array.isArray(v);
    const checks: ExpectationResult[] = [{ label: 'A JSON object', ok: isObj, actual: isObj ? 'valid JSON object' : 'not a JSON object of id to url' }];
    if (!isObj) return fromChecks(checks);
    const entries = Object.entries(v as Record<string, unknown>);
    const bad = entries.find(([, url]) => typeof url !== 'string' || !FRAGRANTICA_URL.test(url));
    checks.push({
      label: 'Every value is a Fragrantica URL',
      ok: !bad,
      actual: bad ? `entry "${bad[0]}" is not a Fragrantica URL: ${JSON.stringify(bad[1])}` : `${entries.length} Fragrantica URL(s)`,
    });
    return fromChecks(checks, `${entries.length} URL(s)`);
  },
  summary: (v) => `${Object.keys(v).length} URL(s)`,
  items: (v) => Object.entries(v).map(([id, url]) => ({ id, title: id, fields: [{ label: 'URL', value: url }] })),
});

/** fetch's store: the captured text (and raw HTML) of each perfume's page. */
export const fragranticaPages = dirArtifact({
  key: 'fragrantica-pages',
  description: 'The captured Fragrantica page of each perfume: <id>.txt (the text) and <id>.html (the raw page).',
  format: 'text',
  shape: {
    summary: 'The raw Fragrantica page text captured for each perfume.',
    format: 'Folder of <id>.txt page captures',
    expectations: [
      { label: 'No captured page is empty', detail: 'A blocked or empty scrape is kept out of this folder, so an empty capture here means the fetch stage is broken.' },
    ],
  },
  check(d) {
    const txts = withExt(d, '.txt');
    const empty = txts.filter((f) => statSync(join(d.path, f)).size === 0);
    return fromChecks(
      [{ label: 'No captured page is empty', ok: empty.length === 0, actual: empty.length ? `${empty.length} empty capture(s), e.g. ${empty[0]}` : `${txts.length} captured page(s)` }],
      `${txts.length} captured page(s)`,
    );
  },
  count: (d) => withExt(d, '.txt').length,
  summary: (d) => `${withExt(d, '.txt').length} captured page(s)`,
  items: (d) => withExt(d, '.txt').map((f) => ({ id: idOf(f), title: idOf(f), preview: { path: join(d.path, f), format: 'text' } })),
});

/** parse's store: one structured record per perfume. */
export const fragranticaData = dirArtifact({
  key: 'fragrantica-data',
  description: 'Each captured page parsed into a structured record: <id>.json with the name, notes, accords and community votes.',
  format: 'json',
  shape: {
    summary: 'Each captured page parsed into a structured perfume record.',
    format: 'Folder of <id>.json parsed perfumes',
    expectations: [
      { label: 'A parsed perfume has a name and a notes object', detail: 'A representative record has a text name and a notes object. A parse that yields shapeless blobs is caught here.' },
    ],
  },
  check(d) {
    const jsons = withExt(d, '.json');
    const label = 'A parsed perfume has a name and a notes object';
    if (jsons.length === 0) return fromChecks([{ label, ok: true, actual: 'nothing parsed yet' }], '0 parsed perfume(s)');
    // A format drift is systemic, so one well-formed record is enough: pass if ANY
    // parsed file has the expected shape, otherwise say why the first one did not.
    let firstReason = '';
    for (const f of jsons) {
      let rec: Record<string, unknown> | null;
      try {
        rec = JSON.parse(readFileSync(join(d.path, f), 'utf8')) as Record<string, unknown> | null;
      } catch (e) {
        firstReason ||= `${f}: not valid JSON (${errMsg(e)})`;
        continue;
      }
      if (!rec || typeof rec.name !== 'string' || !rec.name.trim()) { firstReason ||= `${f}: missing or empty "name"`; continue; }
      if (!rec.notes || typeof rec.notes !== 'object' || Array.isArray(rec.notes)) { firstReason ||= `${f}: missing "notes" object`; continue; }
      return fromChecks([{ label, ok: true, actual: `e.g. "${rec.name}" with notes` }], `${jsons.length} parsed perfume(s)`);
    }
    return fromChecks([{ label, ok: false, actual: `no record has the expected shape: ${firstReason}` }]);
  },
  count: (d) => withExt(d, '.json').length,
  summary: (d) => `${withExt(d, '.json').length} parsed perfume(s)`,
  items: (d) => withExt(d, '.json').map((f) => ({ id: idOf(f), title: idOf(f), preview: { path: join(d.path, f), format: 'json' } })),
});

/** build's store, and the workflow's product: one markdown profile per perfume. */
export const perfumeProfiles = dirArtifact({
  key: 'perfume-profiles',
  description: 'The finished markdown profile of each perfume: <id>.md.',
  format: 'markdown',
  shape: {
    summary: 'One markdown profile per perfume, following the profile template.',
    format: 'Folder of <id>.md profiles',
    expectations: [
      { label: 'Every profile starts with frontmatter', detail: 'Each file opens with the template\'s YAML frontmatter block.' },
    ],
  },
  check(d) {
    const mds = withExt(d, '.md');
    // Read only the first bytes of each: enough to see the frontmatter opener.
    const bad = mds.find((f) => !readFileSync(join(d.path, f), 'utf8').startsWith('---'));
    return fromChecks(
      [{ label: 'Every profile starts with frontmatter', ok: !bad, actual: bad ? `${bad} does not start with ---` : `${mds.length} profile(s)` }],
      `${mds.length} profile(s)`,
    );
  },
  count: (d) => withExt(d, '.md').length,
  summary: (d) => `${withExt(d, '.md').length} profile(s)`,
  items: (d) => withExt(d, '.md').map((f) => ({ id: idOf(f), title: idOf(f), preview: { path: join(d.path, f), format: 'markdown' } })),
});
