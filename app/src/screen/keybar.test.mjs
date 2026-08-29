// Unit tests for the key-bar layout data and paging math.
//
//   cd app && node --test src/screen/keybar.test.mjs
//
// Same shape as the other suites here: no framework, plain assertions, only
// JSX-free modules.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildKeyPages, cellsOf, pageIndexFor } from './keybar.ts';
import { KEYS } from './model.ts';
import { STICKY_MODS } from './mods.ts';

const KEY_PAGES = buildKeyPages(KEYS);
const allCells = KEY_PAGES.flatMap((page) => cellsOf(page));

test('an unknown key id fails loudly at build time, not as a dead cap', () => {
  assert.throws(() => buildKeyPages(KEYS.filter((spec) => spec.id !== 'Esc')), /unknown key "Esc"/);
});

test('every page keeps rows at 44pt-friendly widths (at most 4 caps per row)', () => {
  for (const page of KEY_PAGES) {
    assert.ok(page.top.length >= 1 && page.top.length <= 4);
    assert.ok(page.bottom.length >= 1 && page.bottom.length <= 4);
  }
});

test('no key appears twice across the bar', () => {
  const ids = allCells.map((cell) => (cell.kind === 'key' ? `key:${cell.spec.id}` : `mod:${cell.mod}`));
  assert.equal(new Set(ids).size, ids.length, `duplicate cells in ${ids.join(', ')}`);
});

test('every key cell points at a real KeySpec from the model', () => {
  const known = new Set(KEYS.map((spec) => spec.id));
  for (const cell of allCells) {
    if (cell.kind === 'key') assert.ok(known.has(cell.spec.id), `unknown key ${cell.spec.id}`);
  }
});

test('all four sticky modifiers are on the bar exactly once, with mac labels', () => {
  const mods = allCells.filter((cell) => cell.kind === 'mod');
  assert.deepEqual(
    mods.map((cell) => cell.mod).sort(),
    [...STICKY_MODS].sort()
  );
  for (const cell of mods) {
    assert.ok(cell.label.length > 0);
    assert.ok(cell.macLabel.length > 0);
  }
});

test('the four arrows are chevron glyphs, and nothing else is', () => {
  const glyphs = new Map();
  for (const cell of allCells) {
    if (cell.kind === 'key' && cell.glyph) glyphs.set(cell.spec.id, cell.glyph);
  }
  assert.deepEqual(
    Object.fromEntries(glyphs),
    { Up: 'up', Left: 'left', Down: 'down', Right: 'right' },
    'exactly the arrow keys carry glyphs, each pointing its own way'
  );
});

test('every quick key from the old single-row bar is still reachable (Win became the sticky modifier)', () => {
  const onBar = new Set(allCells.filter((c) => c.kind === 'key').map((c) => c.spec.id));
  for (const spec of KEYS) {
    if (spec.id === 'Win') continue; // covered by the sticky Win/Cmd cap
    assert.ok(onBar.has(spec.id), `${spec.id} fell off the key bar`);
  }
});

test('pageIndexFor rounds to the nearest page and clamps both ends', () => {
  const pages = KEY_PAGES.length;
  assert.equal(pageIndexFor(0, 320, pages), 0);
  assert.equal(pageIndexFor(319, 320, pages), 1, 'nearly one page over rounds forward');
  assert.equal(pageIndexFor(321, 320, pages), 1);
  assert.equal(pageIndexFor(120, 320, pages), 0, 'under half a page stays put');
  // Rubber-banding past the last page clamps.
  assert.equal(pageIndexFor(320 * (pages + 3), 320, pages), pages - 1);
  assert.equal(pageIndexFor(-45, 320, pages), 0, 'over-scroll before page 0 clamps');
});

test('pageIndexFor is defensive about degenerate layout values', () => {
  assert.equal(pageIndexFor(500, 0, 3), 0, 'unmeasured width');
  assert.equal(pageIndexFor(500, -10, 3), 0);
  assert.equal(pageIndexFor(NaN, 320, 3), 0);
  assert.equal(pageIndexFor(500, 320, 0), 0, 'no pages at all');
});
