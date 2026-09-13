// The contrast argument behind machine-ink.ts.
//
//   cd app && node --test src/ui/machine-ink.test.mjs
//
// theme.ts imports react-native and so cannot be loaded by the node test
// runner — no suite in this repo imports it. The hexes below are therefore
// copied from it deliberately, and this file exists to guard the REASONING,
// not the wiring: that both appearances keep their own hue on the glass, and
// that each dark-ground accent is comfortably clear of the 3:1 mark bar rather
// than scraping it the way a paper accent does. If a palette changes, re-run
// docs/DESIGN-TOKENS.md §9 and update these.

import { test } from 'node:test';
import assert from 'node:assert/strict';

/** theme.ts — `machine` is near-black in BOTH appearances. */
const GLASS = '#000000';
/** theme.ts `lightPalette.accentGraphic` — tuned against paper. */
const PAPER_BLUE = '#245CCC';
/** theme.ts `darkPalette.accentGraphic` — the blue tuned for a dark ground. */
const GLASS_BLUE = '#5B9CF8';
/** theme.ts `fieldworkPalette.accentGraphic`. */
const GLASS_ORANGE = '#F99657';
/** theme.ts `darkPalette.onMachine`. */
const GLASS_TEXT = '#F5F5F7';

/** WCAG 2.1 relative luminance. */
function luminance(hex) {
  const channel = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('the dark-ground blue is a real improvement on reaching for the paper accent', () => {
  const paper = contrast(PAPER_BLUE, GLASS);
  const glass = contrast(GLASS_BLUE, GLASS);
  assert.ok(paper >= 3, `the paper blue does clear the bar (${paper.toFixed(2)}:1) — just barely`);
  assert.ok(glass > paper * 1.5, `the dark-ground blue is far clearer: ${glass.toFixed(2)}:1 vs ${paper.toFixed(2)}:1`);
});

test('both appearances clear 3:1 for a non-text mark on the glass', () => {
  for (const [name, hex] of [['Current', GLASS_BLUE], ['Fieldwork', GLASS_ORANGE]]) {
    const ratio = contrast(hex, GLASS);
    assert.ok(ratio >= 3, `${name}: ${hex} on glass is ${ratio.toFixed(2)}:1`);
  }
});

test('machine text clears 4.5:1 on the glass', () => {
  assert.ok(contrast(GLASS_TEXT, GLASS) >= 4.5);
});

test('the two glass accents are different hues — a blue app must not go orange', () => {
  assert.notEqual(GLASS_BLUE, GLASS_ORANGE);
});
