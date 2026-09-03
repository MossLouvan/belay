// Unit tests for the Files tab's hidden-file (dotfile) toggle — the filter
// itself plus the persisted-choice state logic, kept pure so node can run it.
//
//   cd app && node --test src/files/hidden.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HIDDEN_MODE_KEY,
  hiddenCount,
  isHiddenName,
  normalizeHiddenMode,
  toggledHiddenMode,
  withoutHidden,
} from './hidden.ts';

const entry = (name, over = {}) => ({ name, path: `/x/${name}`, dir: false, size: 0, mtime: 0, ...over });
const names = (entries) => entries.map((e) => e.name);

// --- what counts as hidden ---------------------------------------------------

test('a leading dot marks a name hidden, wherever else dots appear', () => {
  assert.equal(isHiddenName('.zshrc'), true);
  assert.equal(isHiddenName('.git'), true);
  assert.equal(isHiddenName('..config'), true);
  assert.equal(isHiddenName('notes.txt'), false);
  assert.equal(isHiddenName('archive.tar.gz'), false);
  assert.equal(isHiddenName('dotless'), false);
});

test('a bare dot in the middle or a dotless name is never hidden', () => {
  assert.equal(isHiddenName('a.b'), false);
  assert.equal(isHiddenName(''), false);
});

// --- the filter --------------------------------------------------------------

test('withoutHidden drops dotfiles and dotfolders alike', () => {
  const entries = [
    entry('.git', { dir: true }),
    entry('Documents', { dir: true }),
    entry('.zshrc'),
    entry('notes.txt'),
  ];
  assert.deepEqual(names(withoutHidden(entries)), ['Documents', 'notes.txt']);
});

test('withoutHidden returns a new array and never mutates its input', () => {
  const entries = Object.freeze([entry('.env'), entry('README.md')]);
  const filtered = withoutHidden(entries);
  assert.deepEqual(names(filtered), ['README.md']);
  assert.notEqual(filtered, entries);
  assert.deepEqual(names(entries), ['.env', 'README.md']);
});

test('a listing with nothing hidden passes through intact', () => {
  const entries = [entry('a.txt'), entry('b.txt')];
  assert.deepEqual(names(withoutHidden(entries)), ['a.txt', 'b.txt']);
});

test('hiddenCount says how many entries the filter would drop', () => {
  assert.equal(hiddenCount([entry('.git', { dir: true }), entry('.env'), entry('a.txt')]), 2);
  assert.equal(hiddenCount([entry('a.txt')]), 0);
  assert.equal(hiddenCount([]), 0);
});

// --- the persisted choice ----------------------------------------------------

test('hide is the default: an empty or unreadable store means hide', () => {
  assert.equal(normalizeHiddenMode(null), 'hide');
  assert.equal(normalizeHiddenMode(undefined), 'hide');
  assert.equal(normalizeHiddenMode(''), 'hide');
});

test('a saved show survives the round trip', () => {
  assert.equal(normalizeHiddenMode('show'), 'show');
  assert.equal(normalizeHiddenMode('hide'), 'hide');
});

test('garbage in storage falls back to hide rather than crashing the tab', () => {
  assert.equal(normalizeHiddenMode('yes'), 'hide');
  assert.equal(normalizeHiddenMode(1), 'hide');
  assert.equal(normalizeHiddenMode({}), 'hide');
});

test('the toggle flips and flips back', () => {
  assert.equal(toggledHiddenMode('hide'), 'show');
  assert.equal(toggledHiddenMode('show'), 'hide');
});

test('the storage key carries the belay prefix like every other choice', () => {
  assert.match(HIDDEN_MODE_KEY, /^belay\./);
});
