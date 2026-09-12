// The phone's side of "why is there no sound?" — one probe in, a sentence the
// user can act on out. Run with:
//   cd app && node --test src/stream/audio-capability.test.mjs

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { audioDockLabel, audioSupportFrom, HOST_TOO_OLD } from './audio-capability.ts';

test('a host that answers 200 is simply supported', () => {
  const s = audioSupportFrom({ status: 200 });
  assert.equal(s.supported, true);
  assert.equal(s.message, '');
  assert.equal(s.kind, '');
});

test('a missing /audio/status route means the host software is out of date', () => {
  const s = audioSupportFrom({ status: 404 });
  assert.deepEqual(s, HOST_TOO_OLD);
  assert.match(s.hint, /Update Belay/);
});

test('a 501 carries the host’s own reason and fix through verbatim', () => {
  const s = audioSupportFrom({
    status: 501,
    kind: 'permission',
    error: 'The operating system refused Belay permission to record system audio.',
    hint: 'System Settings → Privacy & Security → Screen & System Audio Recording',
  });
  assert.equal(s.supported, false);
  assert.equal(s.kind, 'permission');
  assert.match(s.message, /refused Belay permission/);
  assert.match(s.hint, /Screen & System Audio Recording/);
});

test('a 501 with an empty body still says something true', () => {
  const s = audioSupportFrom({ status: 501 });
  assert.equal(s.supported, false);
  assert.equal(s.kind, 'unknown');
  assert.match(s.message, /cannot capture/);
  assert.equal(s.hint, '');
});

test('an auth failure or an unreachable host is never reported as unsupported', () => {
  for (const status of [0, 401, 403, 500, 502]) {
    const s = audioSupportFrom({ status });
    assert.equal(s.supported, false);
    assert.equal(s.kind, 'unreachable');
    assert.match(s.message, /Could not ask/);
  }
});

test('the dock label names the fault class, never a bare "unavailable"', () => {
  assert.equal(audioDockLabel(false, 'off'), 'Audio off');
  assert.equal(audioDockLabel(true, 'playing'), 'Audio on');
  assert.equal(audioDockLabel(true, 'connecting'), 'Connecting audio');
  assert.equal(audioDockLabel(true, 'off'), 'Connecting audio');
  assert.equal(audioDockLabel(true, 'error', 'host-too-old'), 'Host needs update');
  assert.equal(audioDockLabel(true, 'error', 'unsupported-helper'), 'Helper needs rebuild');
  assert.equal(audioDockLabel(true, 'error', 'permission'), 'Audio needs permission');
  assert.equal(audioDockLabel(true, 'error', 'no-device'), 'No audio device');
  assert.equal(audioDockLabel(true, 'error'), 'Audio error');
  assert.equal(audioDockLabel(true, 'error', 'something-new'), 'Audio error');
});
