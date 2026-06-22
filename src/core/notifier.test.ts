// Unit tests for the notifier's HTTP-header sanitiser. ntfy header fields must be
// Latin-1, so emoji/Unicode/control chars have to be stripped before they reach a
// `fetch` header (which would otherwise throw). Pure function — no network/DB.
import assert from 'node:assert/strict';
import { sanitizeHeader } from './notifier.js';

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  }
}

test('plain ASCII passes through unchanged', () => {
  assert.equal(sanitizeHeader('places-workflow'), 'places-workflow');
  assert.equal(sanitizeHeader('demo job - failed'), 'demo job - failed');
});

test('emoji are stripped (they belong in Tags, not the header)', () => {
  assert.equal(sanitizeHeader('✅ demo — success'), 'demo  success');
  assert.equal(sanitizeHeader('❌'), '');
  // every byte of a stripped title is gone, leaving only printable ASCII
  assert.ok(/^[\x20-\x7E]*$/.test(sanitizeHeader('⏱️ timeout 🚨')));
});

test('non-Latin1 / accented Unicode is stripped', () => {
  assert.equal(sanitizeHeader('café'), 'caf'); // é removed
  assert.equal(sanitizeHeader('日本語 job'), 'job'); // CJK removed, leading space trimmed
});

test('control characters (newline/tab) are stripped', () => {
  assert.equal(sanitizeHeader('line1\nline2\ttab'), 'line1line2tab');
});

test('result is trimmed of surrounding whitespace', () => {
  assert.equal(sanitizeHeader('   spaced   '), 'spaced');
  assert.equal(sanitizeHeader('\t  emoji-only-prefix 🚀  '), 'emoji-only-prefix'); // trailing emoji+space gone
});

test('a header that is entirely non-ASCII collapses to empty (caller falls back)', () => {
  assert.equal(sanitizeHeader('🎉🎊✨'), '');
  // the sendNtfy caller uses `|| 'localjobs'` so an empty Title is never sent.
});

test('printable ASCII boundary chars are preserved', () => {
  // space (0x20) through tilde (0x7E) are all kept.
  const all = Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) => String.fromCharCode(0x20 + i)).join('');
  assert.equal(sanitizeHeader(`x${all}x`), `x${all}x`.trim());
});

console.log(`\n${passed} notifier test(s) passed.`);
