// Newest-wins frame scheduling: payloads offered between two animation frames
// collapse to the newest, and the stale ones are never handled (so they are
// never base64-encoded). Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newestWins } from './newest-wins.ts';

/** A manual animation-frame clock. */
const fakeFrames = () => {
  const queue = [];
  return { schedule: (cb) => { queue.push(cb); }, tick: () => { const cbs = queue.splice(0); for (const cb of cbs) cb(); }, pending: () => queue.length };
};

test('only the newest payload offered before a frame is handled', () => {
  const frames = fakeFrames();
  const handled = [];
  const offer = newestWins((p) => handled.push(p), frames.schedule);
  offer('a');
  offer('b');
  offer('c');
  assert.deepEqual(handled, [], 'nothing is handled synchronously');
  assert.equal(frames.pending(), 1, 'one frame callback, however many offers');
  frames.tick();
  assert.deepEqual(handled, ['c']);
});

test('a payload offered after the frame fires gets its own frame', () => {
  const frames = fakeFrames();
  const handled = [];
  const offer = newestWins((p) => handled.push(p), frames.schedule);
  offer(1);
  frames.tick();
  offer(2);
  frames.tick();
  assert.deepEqual(handled, [1, 2]);
});

test('an empty frame handles nothing and holds no reference', () => {
  const frames = fakeFrames();
  const handled = [];
  const offer = newestWins((p) => handled.push(p), frames.schedule);
  offer('x');
  frames.tick();
  frames.tick();
  assert.deepEqual(handled, ['x']);
});
