// The Files session store (#141): the folder, history, viewer and scroll live
// at module level, keyed on the host, so a tab switch (which unmounts the
// route) comes back exactly where it was.
//
//   cd app && node --test src/files/session-store.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getFilesSession, saveFilesSession } from './session-store.ts';

test('a fresh host starts empty', () => {
  const s = getFilesSession('fresh');
  assert.equal(s.path, '');
  assert.equal(s.viewer, null);
  assert.equal(s.scroll.y, 0);
  assert.deepEqual(s.history.stack, []);
});

test('what was saved for a host comes back for the same host', () => {
  saveFilesSession('a', { path: '/home/me/work', scroll: { path: '/home/me/work', y: 120 } });
  saveFilesSession('a', { viewer: { name: 'x.txt', path: '/home/me/work/x.txt', size: 1, kind: 'text' } });
  const s = getFilesSession('a');
  assert.equal(s.path, '/home/me/work');
  assert.equal(s.scroll.y, 120, 'a later save merges, it does not reset');
  assert.equal(s.viewer?.name, 'x.txt');
});

test('a different host never sees the last one\'s folder', () => {
  saveFilesSession('a', { path: '/home/me/work' });
  assert.equal(getFilesSession('b').path, '');
  saveFilesSession('b', { path: '/b' });
  assert.equal(getFilesSession('a').path, '', 'switching hosts drops the old session');
});

test('the snapshot is frozen, so a caller cannot mutate the store', () => {
  saveFilesSession('c', { path: '/c' });
  assert.throws(() => { getFilesSession('c').path = '/x'; });
});
