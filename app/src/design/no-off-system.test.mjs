// Guards the four looks (Harbour, Night, Current, Fieldwork): colour comes
// from theme tokens, and the app never ships the 3D beluga render (that one
// is website-only; the app draws the cartoon or the flat mark).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = fileURLToPath(new URL('../../', import.meta.url));

// The only files allowed raw hex colours, each for a reason.
const HEX_ALLOWED = new Set([
  'src/theme.ts', // the palettes themselves
  'src/ui/beluga-illustration.tsx', // the cartoon's fixed artwork colours
  'src/terminal-ansi.ts', // the ANSI 16-colour table is terminal data
  'src/screen/cursors.ts', // other users' cursor colours, chosen by the host
]);

// A quoted colour literal: '#abc', "#aabbcc", `#aabbccdd`. Issue refs in
// comments (#133) are not quoted, so they never match.
const HEX = /['"`]#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})['"`]/;

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.(ts|tsx)$/.test(e.name) && !e.name.includes('.test.') ? [p] : [];
  });
}

const files = [...sources(join(APP, 'app')), ...sources(join(APP, 'src'))]
  .map((abs) => ({ rel: relative(APP, abs), text: readFileSync(abs, 'utf8') }));

test('no app source references the 3D beluga render', () => {
  const hits = files.filter((f) => f.text.includes('beluga-cutout')).map((f) => f.rel);
  assert.deepEqual(hits, []);
});

test('raw hex colours live only in the allow-listed theme files', () => {
  const hits = files
    .filter((f) => !HEX_ALLOWED.has(f.rel))
    .flatMap((f) => f.text.split('\n').flatMap((line, i) => (HEX.test(line) ? [`${f.rel}:${i + 1}: ${line.trim()}`] : [])));
  assert.deepEqual(hits, []);
});

test('the allow-list is tight: every entry still exists and still needs it', () => {
  for (const rel of HEX_ALLOWED) {
    const f = files.find((x) => x.rel === rel);
    assert.ok(f, `${rel} is allow-listed but missing`);
    assert.ok(HEX.test(f.text), `${rel} is allow-listed but has no hex colour; drop it`);
  }
});
