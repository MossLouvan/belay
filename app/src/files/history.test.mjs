// Unit tests for the Files tab's back/forward history.
//
//   cd app && node --test src/files/history.test.mjs
//
// Same shape as the other suites here: no framework, plain assertions, only
// JSX-free modules.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canGoBack,
  canGoForward,
  currentPath,
  emptyHistory,
  goBack,
  goForward,
  visitPath,
} from './history.ts';

const visitAll = (...paths) => paths.reduce(visitPath, emptyHistory);

test('a fresh history has nowhere to go, so neither arrow can light up', () => {
  assert.equal(currentPath(emptyHistory), null);
  assert.equal(canGoBack(emptyHistory), false);
  assert.equal(canGoForward(emptyHistory), false);
});

test('visiting records the path and moves the cursor with it', () => {
  const h = visitAll('/a', '/a/b');
  assert.equal(currentPath(h), '/a/b');
  assert.equal(canGoBack(h), true);
  assert.equal(canGoForward(h), false);
});

test('re-visiting the current folder is a no-op, so Back never needs two presses', () => {
  const h = visitAll('/a', '/a/b');
  const again = visitPath(h, '/a/b');
  assert.equal(again, h, 'a refresh must not grow the stack');
});

test('back and forward walk the trail without losing it', () => {
  const h = visitAll('/a', '/a/b', '/a/b/c');
  const back = goBack(h);
  assert.equal(currentPath(back), '/a/b');
  assert.equal(canGoForward(back), true);
  assert.equal(currentPath(goForward(back)), '/a/b/c');
});

test('branching off after going back truncates the forward trail, like every browser', () => {
  const h = goBack(visitAll('/a', '/a/b', '/a/b/c'));
  const branched = visitPath(h, '/a/x');
  assert.equal(currentPath(branched), '/a/x');
  assert.equal(canGoForward(branched), false, '/a/b/c must be gone');
  assert.deepEqual(branched.stack, ['/a', '/a/b', '/a/x']);
});

test('back at the start and forward at the end are safe no-ops', () => {
  const h = visitPath(emptyHistory, '/a');
  assert.equal(goBack(h), h);
  assert.equal(goForward(h), h);
  assert.equal(goBack(emptyHistory), emptyHistory);
});

test('every operation returns a new object and never mutates its input', () => {
  const h = visitAll('/a', '/a/b');
  const frozen = Object.freeze({ stack: Object.freeze([...h.stack]), index: h.index });
  assert.notEqual(visitPath(frozen, '/c'), frozen);
  assert.notEqual(goBack(frozen), frozen);
  assert.deepEqual(frozen.stack, ['/a', '/a/b'], 'input left untouched');
});
