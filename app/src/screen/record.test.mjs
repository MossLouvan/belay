// The recording strip is the privacy surface — while the computer's screen is
// being captured, these strings are how the user knows. So the parser must
// never surface garbage as a live-looking status, and the labels must track
// the phase exactly.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  IDLE_RECORDING,
  autoStopMessage,
  formatClock,
  parseRecordingStatus,
  recordKeyLabel,
  stripText,
} from './record.ts';

test('garbage payloads collapse to idle, never to a live-looking state', () => {
  for (const raw of [null, undefined, 'recording', 42, [], {}, { state: 'REC' }, { state: 7 }]) {
    assert.deepEqual(parseRecordingStatus(raw), IDLE_RECORDING, JSON.stringify(raw));
  }
});

test('a well-formed status parses with its counters floored and bounded', () => {
  const status = parseRecordingStatus({
    state: 'recording', seconds: 14.9, frames: 9, dropped: 3, bytes: 812000,
  });
  assert.equal(status.state, 'recording');
  assert.equal(status.seconds, 14);
  assert.equal(status.frames, 9);
  assert.equal(status.dropped, 3);
});

test('negative, NaN and non-number counters become zero', () => {
  const status = parseRecordingStatus({ state: 'ready', seconds: -3, frames: NaN, dropped: 'x', bytes: null });
  assert.deepEqual(status, { state: 'ready', seconds: 0, frames: 0, dropped: 0, bytes: 0 });
});

test('unknown autoStopped reasons and empty errors are dropped, known ones kept', () => {
  assert.equal(parseRecordingStatus({ state: 'ready', autoStopped: 'meteor' }).autoStopped, undefined);
  assert.equal(parseRecordingStatus({ state: 'ready', autoStopped: 'frames' }).autoStopped, 'frames');
  assert.equal(parseRecordingStatus({ state: 'ready', lastError: '' }).lastError, undefined);
  assert.equal(parseRecordingStatus({ state: 'ready', lastError: 'boom' }).lastError, 'boom');
});

test('the clock formats like a recording timer', () => {
  assert.equal(formatClock(0), '0:00');
  assert.equal(formatClock(7), '0:07');
  assert.equal(formatClock(83), '1:23');
  assert.equal(formatClock(725), '12:05');
  assert.equal(formatClock(-4), '0:00');
});

test('the strip names the state and shows the two live numbers', () => {
  assert.equal(
    stripText({ state: 'recording', seconds: 14, frames: 9, dropped: 0, bytes: 0 }),
    'Recording · 0:14 · 9 frames',
  );
  assert.equal(
    stripText({ state: 'ready', seconds: 38, frames: 1, dropped: 0, bytes: 0 }),
    'Recorded · 0:38 · 1 frame',
  );
});

test('the dock key names what pressing it does next', () => {
  assert.equal(recordKeyLabel('idle'), 'Rec');
  assert.equal(recordKeyLabel('recording'), 'Stop');
  assert.equal(recordKeyLabel('ready'), 'Send');
});

test('every auto-stop reason has a message; none is invented for undefined', () => {
  for (const reason of ['duration', 'frames', 'bytes', 'errors']) {
    assert.match(autoStopMessage(reason) ?? '', /Stopped/);
  }
  assert.equal(autoStopMessage(undefined), null);
});
