// The stream HUD's floating inks live next to the phone's HUD component
// (app/src/screen/parts.tsx) as `export const HUD = Object.freeze({...})`.
// That file is React Native UI and cannot be evaluated under node, so the
// literal is lifted out with a small parser instead.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Where the HUD ink set is declared. */
export const HUD_PATH = resolve(here, '..', '..', 'app', 'src', 'screen', 'parts.tsx');

/** The inks the desktop chrome expects to find. */
export const HUD_KEYS = Object.freeze(['scrim', 'ink', 'inkDim', 'hairline']);

const HUD_LITERAL = /export const HUD = Object\.freeze\(\{([\s\S]*?)\}\)/;
const ENTRY = /(\w+):\s*'([^']*)'/g;

/**
 * Parse the `HUD` literal out of the parts module source. Pure: takes the
 * source text, returns `{ scrim, ink, inkDim, hairline }`. Throws when the
 * literal moves or loses a key — silently defaulting would hide the drift
 * the whole sync exists to catch.
 */
export function parseHud(source) {
  const match = source.match(HUD_LITERAL);
  if (!match) throw new Error('parts.tsx no longer declares `export const HUD = Object.freeze({...})`');
  const hud = Object.freeze(
    Object.fromEntries([...match[1].matchAll(ENTRY)].map(([, key, value]) => [key, value])),
  );
  const missing = HUD_KEYS.filter((key) => hud[key] === undefined);
  if (missing.length > 0) throw new Error(`HUD in parts.tsx is missing: ${missing.join(', ')}`);
  return hud;
}

/** The HUD ink set from the app source on disk. */
export const loadHud = () => parseHud(readFileSync(HUD_PATH, 'utf8'));
