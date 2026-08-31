// Unit tests for the "New project" sheet's pure logic: name validation, the
// parent-folder suggestions, the path preview, and the old-host error mapping.
//
//   cd app && node --test src/agent/new-project.test.mjs
//
// Same shape as the other suites here: no framework, plain assertions. Only
// JSX-free modules are imported, since Node strips types but does not compile
// JSX.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_NAME_LENGTH, mapCreateError, parentOf, previewPath, suggestParents, validateProjectName,
} from './new-project.ts';

// ---- name validation -------------------------------------------------------

test('a plain name passes and comes back trimmed', () => {
  assert.deepEqual(validateProjectName('my-app'), { ok: true, name: 'my-app' });
  assert.deepEqual(validateProjectName('  padded  '), { ok: true, name: 'padded' });
  assert.deepEqual(validateProjectName('My App 2'), { ok: true, name: 'My App 2' });
  assert.deepEqual(validateProjectName('über_søt'), { ok: true, name: 'über_søt' }, 'non-ASCII names are fine');
});

test('empty and whitespace-only names are refused', () => {
  assert.equal(validateProjectName('').ok, false);
  assert.equal(validateProjectName('   ').ok, false);
  assert.equal(validateProjectName('\n\t').ok, false);
});

test('path separators are refused — a name must not become a path', () => {
  // Either separator would let "a/b" silently create a nested folder, or
  // worse, "../x" escape the parent entirely.
  assert.equal(validateProjectName('a/b').ok, false);
  assert.equal(validateProjectName('a\\b').ok, false);
  assert.equal(validateProjectName('/etc').ok, false);
  assert.equal(validateProjectName('C:\\evil').ok, false);
});

test('traversal and hidden-folder names are refused', () => {
  assert.equal(validateProjectName('..').ok, false);
  assert.equal(validateProjectName('a..b').ok, false, 'any ".." is suspicious enough to refuse');
  assert.equal(validateProjectName('.git').ok, false);
  assert.equal(validateProjectName('.').ok, false);
});

test('names Windows cannot store are refused on every platform', () => {
  // Created on a Mac, these wedge any Windows machine that later clones them.
  for (const bad of ['a<b', 'a>b', 'a:b', 'a"b', 'a|b', 'a?b', 'a*b']) {
    assert.equal(validateProjectName(bad).ok, false, bad);
  }
  assert.equal(validateProjectName('con').ok, false);
  assert.equal(validateProjectName('COM1').ok, false);
  assert.equal(validateProjectName('NUL').ok, false);
  assert.equal(validateProjectName('lpt9').ok, false);
  assert.equal(validateProjectName('console').ok, true, 'only the exact device names are reserved');
});

test('trailing dots and control characters are refused', () => {
  assert.equal(validateProjectName('name.').ok, false, 'Windows strips trailing dots, silently renaming the folder');
  assert.equal(validateProjectName('a\u0000b').ok, false);
  assert.equal(validateProjectName('a\nb').ok, false);
});

test('absurd lengths are refused, the limit itself is not', () => {
  assert.equal(validateProjectName('x'.repeat(MAX_NAME_LENGTH)).ok, true);
  assert.equal(validateProjectName('x'.repeat(MAX_NAME_LENGTH + 1)).ok, false);
});

test('every refusal explains the rule', () => {
  for (const bad of ['', 'a/b', '..', '.hidden', 'con', 'x'.repeat(99), 'a|b', 'end.']) {
    const check = validateProjectName(bad);
    assert.equal(check.ok, false, bad);
    assert.ok(check.reason.length > 10, `"${bad}" needs a human-readable reason`);
  }
});

// ---- path preview ----------------------------------------------------------

test('the preview joins with the parent\'s own separator', () => {
  assert.equal(previewPath('/Users/me/code', 'app'), '/Users/me/code/app');
  assert.equal(previewPath('C:\\Users\\me', 'app'), 'C:\\Users\\me\\app');
  assert.equal(previewPath('~', 'app'), '~/app');
});

test('a trailing separator on the parent does not double up', () => {
  assert.equal(previewPath('/Users/me/code/', 'app'), '/Users/me/code/app');
  assert.equal(previewPath('C:\\Users\\me\\', 'app'), 'C:\\Users\\me\\app');
});

// ---- parent suggestions ----------------------------------------------------

test('parentOf strips the last segment in either separator style', () => {
  assert.equal(parentOf('/Users/me/code/app'), '/Users/me/code');
  assert.equal(parentOf('C:\\Users\\me\\app'), 'C:\\Users\\me');
  assert.equal(parentOf('/Users/me/code/app/'), '/Users/me/code');
  assert.equal(parentOf('C:\\x'), 'C:\\', 'a bare drive letter is not a real location');
});

test('the busiest parent folder is suggested first', () => {
  const parents = suggestParents([
    { path: '/Users/me/code/a', name: 'a', recent: true },
    { path: '/Users/me/Documents/b', name: 'b', recent: false },
    { path: '/Users/me/code/c', name: 'c', recent: false },
  ]);
  assert.deepEqual(parents, ['/Users/me/code', '/Users/me/Documents']);
});

test('with nothing to learn from, home is the fallback', () => {
  assert.deepEqual(suggestParents([]), ['~']);
});

test('case-variant duplicates collapse but keep the first spelling', () => {
  // Windows paths compare case-insensitively; suggesting both spellings of
  // the same folder would present a meaningless choice.
  const parents = suggestParents([
    { path: 'C:\\Users\\Me\\code\\a', name: 'a', recent: false },
    { path: 'c:\\users\\me\\code\\b', name: 'b', recent: false },
  ]);
  assert.deepEqual(parents, ['C:\\Users\\Me\\code']);
});

// ---- error mapping ---------------------------------------------------------

test('a 404 from an old host becomes advice, not a dead end', () => {
  const mapped = mapCreateError('request failed (404)');
  assert.match(mapped, /too old/);
  assert.match(mapped, /pick it from the list/i, 'the fallback path must be spelled out');
});

test('a real server complaint passes through untouched', () => {
  // "already exists", "not writable", "not allowed" arrive pre-worded by the
  // host; rewording them here would drift from what actually went wrong.
  assert.equal(mapCreateError('a folder named "app" already exists there'), 'a folder named "app" already exists there');
  assert.equal(mapCreateError('that folder is not writable'), 'that folder is not writable');
});
