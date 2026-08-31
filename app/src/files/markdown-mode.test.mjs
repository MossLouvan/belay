// Unit tests for the markdown viewer's rendered/source toggle state — the
// owner's explicit requirement, so its logic gets its own pure module.
//
//   cd app && node --test src/files/markdown-mode.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeMarkdownMode, toggledMarkdownMode, MARKDOWN_MODE_KEY } from './markdown-mode.ts';

test('rendered is the default: an empty or unreadable store means fancy', () => {
  assert.equal(normalizeMarkdownMode(null), 'fancy');
  assert.equal(normalizeMarkdownMode(undefined), 'fancy');
  assert.equal(normalizeMarkdownMode(''), 'fancy');
});

test('a saved raw survives the round trip', () => {
  assert.equal(normalizeMarkdownMode('raw'), 'raw');
  assert.equal(normalizeMarkdownMode('fancy'), 'fancy');
});

test('garbage in storage falls back to fancy rather than crashing the viewer', () => {
  assert.equal(normalizeMarkdownMode('yaml'), 'fancy');
  assert.equal(normalizeMarkdownMode(42), 'fancy');
  assert.equal(normalizeMarkdownMode({}), 'fancy');
});

test('the toggle flips and flips back', () => {
  assert.equal(toggledMarkdownMode('fancy'), 'raw');
  assert.equal(toggledMarkdownMode('raw'), 'fancy');
  assert.equal(toggledMarkdownMode(toggledMarkdownMode('fancy')), 'fancy');
});

test('the storage key is namespaced like the rest of the app', () => {
  assert.match(MARKDOWN_MODE_KEY, /^tether\./);
});
