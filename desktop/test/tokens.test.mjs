// The desktop's tokens are generated from app/src/theme.ts. These tests
// regenerate them and compare with what is committed, so a theme change
// that is not followed by `npm run sync-tokens` fails the suite and names
// the token that moved.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { groundFromTheme, renderGroundJs } from '../scripts/ground-js.mjs';
import { HUD_KEYS, loadHud, parseHud } from '../scripts/hud-source.mjs';
import { OUTPUTS, generate } from '../scripts/sync-tokens.mjs';
import { loadDarkFirst, loadTheme, parseDarkFirst } from '../scripts/theme-source.mjs';
import { OUTFIT_FACES, kebab, parseTokensCss, renderTokensCss } from '../scripts/tokens-css.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const rendererDir = resolve(here, '..', 'renderer');

const onDisk = Object.freeze({
  css: readFileSync(OUTPUTS.css, 'utf8'),
  ground: readFileSync(OUTPUTS.ground, 'utf8'),
});

const theme = await loadTheme();
const hud = loadHud();
const generated = await generate();

const DARK_SELECTORS = Object.freeze([':root:not([data-theme="light"])', ':root[data-theme="dark"]']);

test('renderer/tokens.css is exactly what theme.ts generates', () => {
  assert.equal(onDisk.css, generated.css, 'tokens.css drifted from app/src/theme.ts — run `npm run sync-tokens`');
});

test('src/ground.js is exactly what theme.ts generates', () => {
  assert.equal(onDisk.ground, generated.ground, 'ground.js drifted from app/src/theme.ts — run `npm run sync-tokens`');
});

test('every light palette role is a bare property on :root', () => {
  const root = parseTokensCss(onDisk.css)[':root'];
  for (const [role, value] of Object.entries(theme.lightPalette)) {
    assert.equal(root[kebab(role)], value, `--${kebab(role)} on :root`);
  }
});

test('the dark palette applies under prefers-color-scheme and under data-theme="dark"', () => {
  const blocks = parseTokensCss(onDisk.css);
  for (const selector of DARK_SELECTORS) {
    assert.ok(blocks[selector], `${selector} block present`);
    for (const [role, value] of Object.entries(theme.darkPalette)) {
      assert.equal(blocks[selector][kebab(role)], value, `--${kebab(role)} in ${selector}`);
    }
  }
});

test('data-theme="light" is excluded from the OS dark override', () => {
  assert.match(onDisk.css, /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\)/);
});

test('spacing, radii and layout come through in px', () => {
  const root = parseTokensCss(onDisk.css)[':root'];
  for (const [key, value] of Object.entries(theme.space)) assert.equal(root[`space-${kebab(key)}`], `${value}px`);
  for (const [key, value] of Object.entries(theme.radius)) assert.equal(root[`radius-${kebab(key)}`], `${value}px`);
  assert.equal(root['min-touch'], `${theme.layout.minTouch}px`);
  assert.equal(root.hairline, `${theme.layout.hairline}px`);
  assert.equal(root.rule, `${theme.layout.ruleEmphasis}px`);
  assert.equal(root.margin, `${theme.layout.margin}px`);
  assert.equal(root['row-height'], `${theme.layout.rowHeight}px`);
  assert.equal(root['content-max-width'], `${theme.layout.contentMaxWidth}px`);
  assert.equal(root['hit-slop'], `${theme.layout.hitSlop.top}px`);
});

test('every type variant carries size, line, weight, tracking and transform', () => {
  const root = parseTokensCss(onDisk.css)[':root'];
  for (const [variant, style] of Object.entries(theme.type)) {
    const name = `type-${kebab(variant)}`;
    assert.equal(root[`${name}-size`], `${style.fontSize}px`, `${name}-size`);
    assert.equal(root[`${name}-line`], `${style.lineHeight}px`, `${name}-line`);
    assert.equal(root[`${name}-weight`], String(style.fontWeight ?? '400'), `${name}-weight`);
    assert.equal(root[`${name}-tracking`], `${style.letterSpacing ?? 0}px`, `${name}-tracking`);
    assert.equal(root[`${name}-transform`], style.textTransform ?? 'none', `${name}-transform`);
    const expectedFamily = style.fontFamily === theme.font.sans ? 'var(--sans)' : 'var(--mono)';
    assert.equal(root[`${name}-family`], expectedFamily, `${name}-family`);
  }
});

test('font families match the theme and the Outfit faces exist on disk', () => {
  const root = parseTokensCss(onDisk.css)[':root'];
  assert.ok(root.sans.startsWith(`"${theme.font.sans}"`), '--sans leads with the app sans');
  assert.equal(root.mono, theme.font.mono);
  for (const face of OUTFIT_FACES) {
    const path = resolve(rendererDir, 'fonts', face.file);
    assert.ok(existsSync(path), `${face.file} present in renderer/fonts`);
    assert.match(onDisk.css, new RegExp(`font-weight: ${face.weight};\\s*font-display: block;\\s*src: url\\("fonts/${face.file}"\\)`));
  }
});

test('motion durations and easings match the theme', () => {
  const root = parseTokensCss(onDisk.css)[':root'];
  assert.equal(root['motion-fast'], `${theme.motion.fast}ms`);
  assert.equal(root['motion-base'], `${theme.motion.base}ms`);
  assert.equal(root['motion-slow'], `${theme.motion.slow}ms`);
  assert.equal(root['motion-draw'], `${theme.motion.draw}ms`);
  assert.equal(root['press-opacity'], String(theme.motion.pressOpacity));
  assert.equal(root['ease-standard'], `cubic-bezier(${theme.easing.standard.points.join(', ')})`);
  assert.equal(root['ease-exit'], `cubic-bezier(${theme.easing.exit.points.join(', ')})`);
  assert.equal(root['ease-linear'], 'linear');
});

test('the HUD inks come from parts.tsx', () => {
  const root = parseTokensCss(onDisk.css)[':root'];
  for (const key of HUD_KEYS) assert.equal(root[`hud-${kebab(key)}`], hud[key], `--hud-${kebab(key)}`);
});

test('parseHud lifts the literal and refuses a missing key', () => {
  const source = "export const HUD = Object.freeze({\n  scrim: 'rgba(0, 0, 0, 0.5)',\n  ink: '#FFF',\n  inkDim: '#AAA',\n  hairline: 'rgba(255, 255, 255, 0.1)',\n});";
  assert.deepEqual(parseHud(source), { scrim: 'rgba(0, 0, 0, 0.5)', ink: '#FFF', inkDim: '#AAA', hairline: 'rgba(255, 255, 255, 0.1)' });
  assert.throws(() => parseHud("export const HUD = Object.freeze({ ink: '#FFF' });"), /missing: scrim, inkDim, hairline/);
  assert.throws(() => parseHud('nothing here'), /no longer declares/);
});

test('ground colours are the page bg per scheme and the machine black', () => {
  assert.deepEqual(groundFromTheme(theme, true), {
    light: theme.lightPalette.bg,
    dark: theme.darkPalette.bg,
    machine: theme.darkPalette.machine,
    darkFirst: true,
  });
  assert.match(renderGroundJs(theme, false), /darkFirst: false,/);
});

test('parseDarkFirst reads the module-private flag and refuses its absence', () => {
  assert.equal(parseDarkFirst('const DARK_FIRST = true;'), true);
  assert.equal(parseDarkFirst('// x\nconst DARK_FIRST = false;\n'), false);
  assert.throws(() => parseDarkFirst('const DARK_FIRST = maybe;'), /no longer declares/);
});

test('every renderer page pins data-theme the way the app resolves its scheme', () => {
  const darkFirst = loadDarkFirst();
  for (const page of ['connect.html', 'display.html', 'seamless.html']) {
    const html = readFileSync(resolve(rendererDir, page), 'utf8');
    const pinned = /<html[^>]*\sdata-theme="dark"/.test(html);
    assert.equal(pinned, darkFirst, `${page} data-theme="dark" iff DARK_FIRST`);
  }
});

test('kebab turns camelCase roles into CSS names', () => {
  assert.equal(kebab('surfaceAlt'), 'surface-alt');
  assert.equal(kebab('onMachineDim'), 'on-machine-dim');
  assert.equal(kebab('bg'), 'bg');
});

test('renderTokensCss is pure and round-trips through the parser', () => {
  const css = renderTokensCss(theme, hud);
  assert.equal(css, renderTokensCss(theme, hud));
  const parsed = parseTokensCss(css);
  assert.equal(parsed[':root'].accent, theme.lightPalette.accent);
  assert.equal(parsed[':root[data-theme="dark"]'].accent, theme.darkPalette.accent);
});
