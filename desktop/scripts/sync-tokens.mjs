#!/usr/bin/env node
// Regenerate the desktop's token files from the phone app's theme:
//
//   renderer/tokens.css   every colour, type, spacing, radius, layout,
//                         motion and HUD token as CSS custom properties
//   src/ground.js         the window ground colours main.js paints before
//                         the renderer has loaded (bg per scheme + machine)
//
// Usage: npm run sync-tokens          (from desktop/)
// test/tokens.test.mjs regenerates both in memory and fails when they drift.

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderGroundJs } from './ground-js.mjs';
import { loadHud } from './hud-source.mjs';
import { loadDarkFirst, loadTheme } from './theme-source.mjs';
import { renderTokensCss } from './tokens-css.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/** The generated files, relative to desktop/. */
export const OUTPUTS = Object.freeze({
  css: resolve(here, '..', 'renderer', 'tokens.css'),
  ground: resolve(here, '..', 'src', 'ground.js'),
});

/** Both generated sources, from the theme on disk. */
export async function generate() {
  const theme = await loadTheme();
  const hud = loadHud();
  const darkFirst = loadDarkFirst();
  return Object.freeze({
    css: renderTokensCss(theme, hud),
    ground: renderGroundJs(theme, darkFirst),
    darkFirst,
  });
}

const isMain = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const generated = await generate();
  writeFileSync(OUTPUTS.css, generated.css);
  writeFileSync(OUTPUTS.ground, generated.ground);
  process.stdout.write(`[belay] wrote ${OUTPUTS.css}\n[belay] wrote ${OUTPUTS.ground}\n`);
}
