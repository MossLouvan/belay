// Load app/src/theme.ts — the source of truth for every token — under node.
//
// The desktop renderer is sandboxed plain CSS and cannot import the theme, so
// its tokens.css is GENERATED from this module (sync-tokens.mjs) and a test
// (test/tokens.test.mjs) fails the suite if the two ever drift. Node strips
// the TypeScript itself; the only obstacle is that theme.ts imports react and
// react-native, which are redirected to the two tiny stubs in ./stubs.

import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** The theme module, relative to the desktop package. */
export const THEME_PATH = resolve(here, '..', '..', 'app', 'src', 'theme.ts');

/** Every export the desktop tokens are built from. */
export const THEME_EXPORTS = Object.freeze([
  'lightPalette', 'darkPalette', 'radius', 'space', 'font', 'type', 'layout', 'motion', 'easing',
]);

const THEME_URL = pathToFileURL(THEME_PATH).href;

const STUBS = Object.freeze({
  react: pathToFileURL(resolve(here, 'stubs', 'react.mjs')).href,
  'react-native': pathToFileURL(resolve(here, 'stubs', 'react-native.mjs')).href,
});

let registered = false;

function registerStubs() {
  if (registered) return;
  registered = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const stub = STUBS[specifier];
      if (stub) return { url: stub, shortCircuit: true };
      const resolved = nextResolve(specifier, context);
      // The app package has no "type" field; say the theme is ESM TypeScript
      // outright so node does not warn while guessing.
      return resolved.url === THEME_URL ? { ...resolved, format: 'module-typescript' } : resolved;
    },
  });
}

/**
 * The evaluated theme module: `lightPalette`, `darkPalette`, `radius`,
 * `space`, `font`, `type`, `layout`, `motion`, `easing`. Throws if the file
 * is missing or no longer evaluates — a broken theme must break the build,
 * not silently freeze the desktop on stale tokens.
 */
export async function loadTheme() {
  registerStubs();
  const theme = await import(pathToFileURL(THEME_PATH).href);
  const missing = THEME_EXPORTS.filter((key) => theme[key] === undefined);
  if (missing.length > 0) throw new Error(`theme.ts no longer exports: ${missing.join(', ')}`);
  return theme;
}

const DARK_FIRST_LITERAL = /^const DARK_FIRST = (true|false);$/m;

/**
 * Whether the app commits to dark regardless of the OS (`DARK_FIRST` in
 * theme.ts, a module-private const, so it is read from the source text).
 * Throws when the declaration moves: the desktop's windows pin their theme
 * on this, and guessing would let the two products drift apart quietly.
 */
export function parseDarkFirst(source) {
  const match = source.match(DARK_FIRST_LITERAL);
  if (!match) throw new Error('theme.ts no longer declares `const DARK_FIRST = true|false;`');
  return match[1] === 'true';
}

/** `DARK_FIRST` from the theme on disk. */
export const loadDarkFirst = () => parseDarkFirst(readFileSync(THEME_PATH, 'utf8'));
