// Guards the honest handling of empty Fragrantica notes pyramids. Some pages
// come back with no notes breakdown; the build stage must reflect that without
// fabricating notes (and without silently dropping the section). Covers the
// parse-side normalization (empty stays explicitly empty arrays) and the
// build-prompt clause that branches empty vs. populated.
import assert from 'node:assert/strict';
import { notesMappingClause } from './build.js';
import { normalizeNotes, notesEmpty } from './parse.js';

// ── normalizeNotes: canonical shape; entries trimmed; empty stays empty. ──
{
  const n = normalizeNotes({ top: ['Bergamot', '  Pink   Pepper '], heart: null, base: ['Cedar'] });
  assert.deepEqual(
    n,
    { top: ['Bergamot', 'Pink Pepper'], heart: [], base: ['Cedar'] },
    'tiers coerce to arrays, whitespace collapses, missing tiers become []',
  );
  assert.equal(notesEmpty(n), false, 'a pyramid with any tier populated is not empty');
}

// ── A missing / undefined notes object normalizes to an explicitly-empty pyramid. ──
{
  const n = normalizeNotes(undefined);
  assert.deepEqual(n, { top: [], heart: [], base: [] }, 'absent notes → all tiers explicitly []');
  assert.equal(notesEmpty(n), true);
}

// ── All-empty tiers count as empty; one note anywhere makes it populated. ──
{
  assert.equal(notesEmpty(normalizeNotes({ top: [], heart: [], base: [] })), true);
  assert.equal(notesEmpty(normalizeNotes({ top: ['vanilla'] })), false);
}

// ── EMPTY-SECTION FIXTURE: build clause must mark it empty, never fabricate. ──
{
  const clause = notesMappingClause(JSON.stringify({ notes: { top: [], heart: [], base: [] } }));
  assert.match(clause, /EMPTY/, 'empty pyramid → explicit EMPTY directive');
  assert.match(clause, /empty arrays/, 'tells Claude to keep the tiers as empty arrays');
  assert.match(clause, /do NOT fabricate/i, 'forbids fabricating a substitute pyramid');
  assert.match(clause, /unavailable/i, 'asks the prose to state the breakdown was unavailable');
}

// ── POPULATED FIXTURE: normal mapping clause, not the empty branch. ──
{
  const clause = notesMappingClause(
    JSON.stringify({ notes: { top: ['bergamot'], heart: ['rose'], base: ['musk'] } }),
  );
  assert.match(clause, /from the notes pyramid/, 'populated pyramid → normal map-through clause');
  assert.doesNotMatch(clause, /EMPTY/, 'populated pyramid must not get the empty directive');
}

// ── Malformed JSON is treated as empty (honest fallback) and never throws. ──
{
  const clause = notesMappingClause('not-json{');
  assert.match(clause, /EMPTY/, 'unparseable frag JSON falls back to the empty directive');
}

console.log('  ✓ perfumes empty notes-pyramid handled honestly (normalize + build clause)');
