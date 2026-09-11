// The controller's UDP fast path crosses two Expo modules that do not, and
// must not, depend on each other: the controller module posts its encoded
// reports on a notification, and the stream module's live session observes it.
//
//   cd app && node --test src/gamepad/bridge.test.mjs
//
// A notification channel is a string in two files, and a typo in either is
// silent: the controller keeps working, the reports simply never take the UDP
// channel and nobody can tell from the app. Neither file can be compiled here,
// so this pins the one thing that can be checked — that they still agree.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

const CHANNEL = /Notification\.Name\("([^"]+)"\)/;

test('the controller module and the stream module name the same channel', () => {
  const poster = read('../../modules/belay-gamepad/ios/GamepadSession.swift').match(CHANNEL);
  const observer = read('../../modules/belay-stream/ios/BelayStreamView.swift').match(CHANNEL);
  assert.ok(poster, 'GamepadSession.swift declares the channel');
  assert.ok(observer, 'BelayStreamView.swift declares the channel');
  assert.equal(poster[1], observer[1]);
});

test('the report cap the view enforces is the transport limit in the C header', () => {
  const header = read('../../modules/belay-stream/ios/include/belay_client.h');
  const limit = header.match(/#define BELAY_INPUT_MAX_LEN (\d+)/);
  const view = read('../../modules/belay-stream/ios/BelayStreamView.swift').match(/maxInputBytes = (\d+)/);
  assert.ok(limit, 'the header defines the limit');
  assert.ok(view, 'the view pins a limit');
  assert.equal(view[1], limit[1]);
});

test('a 17-byte controller report fits the channel with room to spare', () => {
  const header = read('../../modules/belay-stream/ios/include/belay_client.h');
  const limit = Number(header.match(/#define BELAY_INPUT_MAX_LEN (\d+)/)[1]);
  assert.ok(limit >= 17, 'the wire frame must fit in one input report');
});
