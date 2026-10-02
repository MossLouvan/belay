// Which host route the Changes screen asks: per Belay session, or per folder
// for a plain terminal session's done notice (#127).
//
//   cd app && node --test src/changes/changes-api.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { changesPath } from './changes-api.ts';

test('a session id wins and is encoded', () => {
  assert.equal(changesPath({ session: 'a/b', cwd: '/p' }), '/agent/sessions/a%2Fb/changes');
});

test('a folder alone goes to the by-folder route, encoded', () => {
  assert.equal(changesPath({ cwd: '/Users/me/my repo&x' }), '/agent/changes?cwd=%2FUsers%2Fme%2Fmy%20repo%26x');
});

test('neither is null, so the screen can say so instead of asking', () => {
  assert.equal(changesPath({}), null);
  assert.equal(changesPath({ session: '', cwd: '' }), null);
});
