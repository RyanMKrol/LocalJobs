// Regression guard for accord percentages: the parse stage must lift each
// "main accord" bar's width % off the cached Fragrantica HTML (the captured page
// *text* drops these widths). Asserts the parser against a synthetic fixture that
// mirrors Fragrantica's real markup — a `<div style="...width: NN%...">` wrapping
// a `<span class="truncate">NAME</span>`, strongest accord at 100%.
import assert from 'node:assert/strict';
import { parseAccordPercents } from './parse.js';

/** Build one accord bar exactly like Fragrantica renders it. */
const bar = (name: string, width: string) =>
  `<div class="w-full"><div class="h-5 md:h-7 rounded-br-lg flex items-center justify-center px-2 md:px-3 text-xs md:text-sm font-medium transition-all duration-200 hover:scale-[1.02]" style="color: rgb(255, 255, 255); background: rgb(14, 140, 29); opacity: 1; width: ${width};"><span class="truncate">${name}</span></div></div>`;

const fixture = (...bars: string[]) =>
  `<div class="flex flex-col items-center pb-4"><h6 class="text-sm font-semibold">main accords</h6>` +
  `<div class="flex flex-col w-full max-w-[280px]">${bars.join('')}</div></div>` +
  // trailing width-styled element WITHOUT the accord-bar's `truncate` span — the
  // parser must reject it (other page widgets also use width %, only accord bars
  // wrap their label in a `<span class="truncate">`).
  `<div style="width: 42%"><span class="other">not-an-accord</span></div>`;

// ── Strengths come straight off the bar widths, page order preserved, rounded. ──
{
  const html = fixture(
    bar('green', '100%'),
    bar('woody', '82.7601%'),
    bar('sweet', '61.3664%'),
    bar('fresh spicy', '50.4%'),
  );
  const accords = parseAccordPercents(html);
  assert.deepEqual(
    accords,
    [
      { name: 'green', pct: 100 },
      { name: 'woody', pct: 83 },
      { name: 'sweet', pct: 61 },
      { name: 'fresh spicy', pct: 50 },
    ],
    'accord percentages should be parsed + rounded from bar widths, strongest first',
  );
  // The width bar that lacks a `truncate` label must not be mistaken for an accord.
  assert.ok(!accords.some((a) => a.name === 'not-an-accord'), 'must not pick up width bars without a truncate label');
}

// ── Multi-word names are normalised; the strongest is always 100. ──
{
  const accords = parseAccordPercents(fixture(bar('warm spicy', '100%'), bar('amber', '47.5%')));
  assert.deepEqual(accords, [
    { name: 'warm spicy', pct: 100 },
    { name: 'amber', pct: 48 },
  ]);
}

// ── A page with no accords block yields nothing (so pct stays genuinely null). ──
assert.deepEqual(parseAccordPercents('<html><body>no accords here</body></html>'), [], 'no "main accords" block → []');

// ── Duplicate names collapse to the first (strongest) occurrence. ──
{
  const accords = parseAccordPercents(fixture(bar('woody', '100%'), bar('woody', '30%')));
  assert.deepEqual(accords, [{ name: 'woody', pct: 100 }], 'duplicate accord names dedupe to the strongest');
}

console.log('  ✓ perfumes accord percentages parse from bar widths (synthetic fixture)');
