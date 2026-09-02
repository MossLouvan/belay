// The three-data-channel policy — routing and reliability (PERFORMANCE-PLAN §3).
//
//   cd app && node --test src/stream/webrtc/channels.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CHANNELS, channelFor, isUnreliable } from './channels.ts';

test('keys and clicks go on the reliable+ordered input channel', () => {
  for (const kind of ['key', 'text', 'click', 'down', 'up']) {
    assert.equal(channelFor(kind), 'input');
  }
  assert.equal(CHANNELS.input.ordered, true);
  assert.equal(CHANNELS.input.maxRetransmits, undefined, 'input is fully reliable');
});

test('a dropped key-up must never be possible: up rides the reliable channel', () => {
  // The stuck-key guarantee stated in the plan, asserted directly.
  const spec = CHANNELS[channelFor('up')];
  assert.equal(isUnreliable(spec), false);
});

test('pointer motion and scroll go on the unreliable newest-wins channel', () => {
  for (const kind of ['move', 'scroll']) {
    assert.equal(channelFor(kind), 'cursor');
  }
  assert.equal(CHANNELS.cursor.ordered, false);
  assert.equal(CHANNELS.cursor.maxRetransmits, 0);
  assert.equal(isUnreliable(CHANNELS.cursor), true);
});

test('control traffic gets its own reliable channel', () => {
  for (const kind of ['config', 'keyframe', 'ping', 'stats']) {
    assert.equal(channelFor(kind), 'control');
  }
  assert.equal(CHANNELS.control.ordered, true);
  assert.equal(isUnreliable(CHANNELS.control), false);
});

test('an unknown event kind fails safe onto the reliable control channel', () => {
  assert.equal(channelFor('totally-new-verb'), 'control');
  assert.equal(channelFor(''), 'control');
});

test('only the cursor channel is unreliable', () => {
  const unreliable = Object.values(CHANNELS).filter(isUnreliable).map((c) => c.id);
  assert.deepEqual(unreliable, ['cursor']);
});
