// The renderer is sandboxed static files: a stylesheet, font or image that
// is not on disk fails silently in Electron (a blocked request, no error).
// So the references are checked here instead — every href/src in the pages,
// every url() in the stylesheets, and every var(--token) the page CSS reads,
// which must be one tokens.css actually defines.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { parseTokensCss } from '../scripts/tokens-css.mjs';

const rendererDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'renderer');
const read = (file) => readFileSync(resolve(rendererDir, file), 'utf8');

const PAGES = Object.freeze(['connect.html', 'display.html', 'seamless.html']);
const PAGE_CSS = Object.freeze(['style.css', 'display.css', 'seamless.css']);

/** Local `href`/`src` values in a page — everything that is not a URL. */
export const localReferences = (html) =>
  [...html.matchAll(/\b(?:href|src)="([^"]+)"/g)]
    .map(([, value]) => value)
    .filter((value) => !/^(?:[a-z]+:|#)/i.test(value));

/** Local `url(...)` targets in a stylesheet. */
export const cssUrls = (css) =>
  [...css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)]
    .map(([, value]) => value)
    .filter((value) => !/^(?:data:|[a-z]+:\/\/)/i.test(value));

/** Every custom property a stylesheet reads through var(). */
export const varsRead = (css) => new Set([...css.matchAll(/var\(--([a-z0-9-]+)/g)].map(([, name]) => name));

test('every page links files that exist', () => {
  for (const page of PAGES) {
    for (const reference of localReferences(read(page))) {
      assert.ok(existsSync(resolve(rendererDir, reference)), `${page} → ${reference}`);
    }
  }
});

test('every url() in the stylesheets resolves to a file', () => {
  for (const file of ['tokens.css', ...PAGE_CSS]) {
    for (const target of cssUrls(read(file))) {
      assert.ok(existsSync(resolve(rendererDir, target)), `${file} → ${target}`);
    }
  }
});

test('page stylesheets only read tokens that tokens.css defines', () => {
  const defined = new Set(Object.keys(parseTokensCss(read('tokens.css'))[':root']));
  for (const file of PAGE_CSS) {
    for (const name of varsRead(read(file))) {
      assert.ok(defined.has(name), `${file} reads --${name}, which tokens.css does not define`);
    }
  }
});

test('every page allows fonts from itself, since Outfit is bundled', () => {
  for (const page of PAGES) {
    assert.match(read(page), /Content-Security-Policy[^>]*font-src 'self'/, `${page} font-src`);
  }
});

test('no page carries inline styles, per the renderer CSP', () => {
  for (const page of PAGES) {
    assert.doesNotMatch(read(page), /<style|style="/, `${page} inline style`);
  }
});

test('the bundled font directory holds only the four faces and the licence', () => {
  const files = readdirSync(resolve(rendererDir, 'fonts')).sort();
  assert.deepEqual(files, [
    'LICENSE-OFL.txt',
    'Outfit_400Regular.ttf',
    'Outfit_500Medium.ttf',
    'Outfit_600SemiBold.ttf',
    'Outfit_700Bold.ttf',
  ]);
});
