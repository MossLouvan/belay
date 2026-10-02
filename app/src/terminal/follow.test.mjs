// Following the transcript (#138): only the reader scrolling UP lets go of the
// end. Output arriving, the list shrinking (candidate row, keyboard, rotation)
// or a late scroll event must never stop the follow.
//
//   cd app && node --test src/terminal/follow.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FOLLOW_SLACK_PX, nextFollowing } from './follow.ts';

test('at the end, it follows', () => {
  assert.equal(nextFollowing(false, { distance: 0, y: 500, lastY: 300 }), true);
  assert.equal(nextFollowing(false, { distance: FOLLOW_SLACK_PX, y: 500, lastY: 500 }), true);
});

test('scrolling up lets go', () => {
  assert.equal(nextFollowing(true, { distance: 200, y: 300, lastY: 500 }), false);
});

test('new output or a shorter list (offset unchanged, end further away) keeps following', () => {
  assert.equal(nextFollowing(true, { distance: 384, y: 1552, lastY: 1552 }), true);
});

test('away from the end without moving up keeps whatever it was', () => {
  assert.equal(nextFollowing(false, { distance: 300, y: 700, lastY: 600 }), false);
});
