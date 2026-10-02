// WCAG AA for the two shipped looks (#71). Text tokens must clear 4.5:1 on
// every page backdrop they sit on; the danger button's ink must clear it on
// its fill. Same maths as docs/DESIGN-TOKENS.md §9.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ponytail: theme.ts imports react-native, which node cannot load, so the
// palettes are read out of the source text. Lift them into an import-free
// module if this regex ever breaks.
const src = readFileSync(new URL('./theme.ts', import.meta.url), 'utf8');

function palette(name) {
  const block = src.match(new RegExp(`export const ${name}: Palette = Object.freeze\\(\\{([\\s\\S]*?)\\n\\}\\);`));
  assert.ok(block, `${name} not found in theme.ts`);
  const spread = block[1].match(/\.\.\.(\w+Palette)/);
  const own = Object.fromEntries(
    [...block[1].matchAll(/(\w+): '(#[0-9A-Fa-f]{6})'/g)].map((m) => [m[1], m[2]]),
  );
  return spread ? { ...palette(spread[1]), ...own } : own;
}

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a, b) => {
  const [hi, lo] = [lum(hex(a)), lum(hex(b))].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
};

const AA_TEXT = 4.5;
const TEXT = ['text', 'textDim', 'textFaint'];
const BACKDROPS = ['bg', 'surface', 'surfaceAlt'];

for (const name of ['currentPalette', 'fieldworkPalette']) {
  const p = palette(name);

  test(`${name}: text tokens meet AA on every backdrop`, () => {
    for (const t of TEXT) for (const b of BACKDROPS) {
      const r = ratio(p[t], p[b]);
      assert.ok(r >= AA_TEXT, `${t} ${p[t]} on ${b} ${p[b]} = ${r.toFixed(2)}`);
    }
  });

  test(`${name}: danger button ink meets AA on its fill`, () => {
    const r = ratio(p.onDanger, p.bad);
    assert.ok(r >= AA_TEXT, `onDanger ${p.onDanger} on bad ${p.bad} = ${r.toFixed(2)}`);
  });
}
