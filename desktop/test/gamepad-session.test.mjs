import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptySender, nextSample, parseMessage, rumbleEffect, controllerLabel, streamConfig } from '../src/gamepad-session.js';

const neutral = Object.freeze({ buttons: 0, lt: 0, rt: 0, lx: 0, ly: 0, rx: 0, ry: 0 });
test('active samples repeat for 100 ms then use a 250 ms keepalive', () => {
  let s = nextSample(emptySender(), neutral, 0);
  assert.equal(s.seq, 1);
  s = nextSample(s, neutral, 96);
  assert.equal(s.seq, 2);
  assert.equal(nextSample(s, neutral, 101), s);
  assert.equal(nextSample(s, neutral, 345), s);
  s = nextSample(s, neutral, 346);
  assert.equal(s.seq, 3);
  const changed = nextSample(s, { ...neutral, buttons: 4096 }, 347);
  assert.equal(changed.seq, 4);
  assert.equal(nextSample(changed, neutral, 348).sample.buttons, 0);
});
test('backpressure drops intermediate states without advancing sequence or losing release', () => {
  const s = Object.freeze({ ...nextSample(emptySender(), neutral, 0), seq: 0xffffffff });
  assert.equal(nextSample(s, { ...neutral, lt: 255 }, 4, 35), s);
  const next = nextSample(s, { ...neutral, rt: 255 }, 8, 0);
  assert.equal(next.sample.lt, 0);
  assert.equal(next.sample.rt, 255);
  assert.equal(next.seq, 0);
});
test('host messages validate normalized rumble and consistent hello', () => {
  assert.deepEqual(parseMessage('{"type":"rumble","low":0.5,"high":1}'), { type: 'rumble', low: 127.5, high: 255 });
  assert.equal(parseMessage('{"type":"hello","available":true,"backend":"vigem"}').backend, 'vigem');
  for (const raw of [null, 'null', '{}', 'oops', '{"type":"rumble","low":255,"high":0}', '{"type":"hello","available":true,"backend":"unavailable"}', 'x'.repeat(4097)]) assert.equal(parseMessage(raw), null);
});
test('rumble bytes scale independently and expire before the host watchdog', () => {
  assert.deepEqual(rumbleEffect(127.5, 255), { duration: 500, startDelay: 0, strongMagnitude: 0.5, weakMagnitude: 1 });
  assert.equal(rumbleEffect(0, 0).strongMagnitude, 0);
  assert.equal(rumbleEffect(NaN, 0), null);
  assert.equal(rumbleEffect(-1, 0), null);
});
test('chrome labels and JPEG gaming config preserve display identity and defaults', () => {
  assert.match(controllerLabel('dualsense', 'vigem'), /DualSense · ✕ ○ □ △ · Xbox controller/);
  assert.match(controllerLabel('dualshock', 'keymap'), /Keyboard \/ mouse fallback/);
  assert.match(controllerLabel('generic', 'unavailable'), /ABXY · unavailable/);
  const defaults = Object.freeze({ w: 1600, q: 62, fps: 24 });
  assert.deepEqual(streamConfig(true, defaults, 2), { type: 'config', w: 1024, q: 35, fps: 30, screen: 2 });
  assert.deepEqual(streamConfig(false, defaults), { type: 'config', ...defaults });
});
