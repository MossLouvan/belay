import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldMountAudioSink } from './audio-sink-policy.ts';

test('native audio sink stays mounted for the whole connected session', () => {
  assert.equal(shouldMountAudioSink('ios', true), true);
  assert.equal(shouldMountAudioSink('android', true), true);
});

test('audio sink is absent when disconnected or on web', () => {
  assert.equal(shouldMountAudioSink('ios', false), false);
  assert.equal(shouldMountAudioSink('web', true), false);
});
