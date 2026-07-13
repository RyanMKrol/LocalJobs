// Pure-function coverage for parseFrontmatter (MarkdownModal.tsx) — no browser/
// React rendering needed, this only exercises the frontmatter stripping/parsing.
//
// Self-running (mirrors the other dashboard test suites): run directly with
//   npx tsx dashboard/app/components/MarkdownModal.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter } from './MarkdownModal.js';

async function main() {
  await test('parseFrontmatter: content with no frontmatter is returned unchanged', () => {
    const result = parseFrontmatter('# Just a heading\n\nSome body text.');
    assert.deepEqual(result.fields, []);
    assert.equal(result.body, '# Just a heading\n\nSome body text.');
  });

  await test('parseFrontmatter: valid frontmatter is parsed into key/value fields and stripped from the body', () => {
    const content = '---\nname: Some Place\nrating: 4.5\n---\n# Body heading\n\nBody text.';
    const result = parseFrontmatter(content);
    assert.deepEqual(result.fields, [['name', 'Some Place'], ['rating', '4.5']]);
    assert.equal(result.body, '# Body heading\n\nBody text.');
  });

  await test('parseFrontmatter: quoted values have surrounding quotes stripped', () => {
    const content = '---\ntitle: "A Quoted Title"\n---\nBody.';
    const result = parseFrontmatter(content);
    assert.deepEqual(result.fields, [['title', 'A Quoted Title']]);
  });

  await test('parseFrontmatter: unterminated frontmatter (no closing ---) is returned unchanged', () => {
    const content = '---\nname: Some Place\nno closing marker here';
    const result = parseFrontmatter(content);
    assert.deepEqual(result.fields, []);
    assert.equal(result.body, content);
  });

  await test('parseFrontmatter: the newline right after the closing marker is trimmed from the body', () => {
    const content = '---\nname: X\n---\nBody starts here.';
    const result = parseFrontmatter(content);
    assert.equal(result.body, 'Body starts here.');
  });
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
