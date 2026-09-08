// The two wire transports behind use-gamepad.ts.
//
//   cd app && node --test src/gamepad/transport.test.mjs
//
// Why: the native transport exists so a stalled JS thread cannot go quiet on
// the wire. These tests pin the contract both transports share — same events,
// neutral on close, suppression, mode selection — so the JS fallback and the
// native path cannot drift apart.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeGamepad, NEUTRAL } from './codec.ts';
import { jsTransport, nativeTransport } from './transport.ts';

class FakeSocket {
  static instances = [];
  static OPEN = 1;
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this.bufferedAmount = 0; FakeSocket.instances.push(this); }
  send(data) { this.sent.push(decodeGamepad(data)); }
  close() { this.readyState = 3; this.onclose?.({ code: 1000, reason: '' }); }
  open() { this.readyState = 1; }
}

const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));
const neutral = frame => ({ ...frame, seq: 0 });

test('js transport: sends only after an available hello, honours mode and suppression, neutral on close', async () => {
  globalThis.WebSocket = FakeSocket;
  const closes = [];
  const wire = jsTransport({ onMessage: () => { }, onClose: (code, reason) => closes.push([code, reason]) });
  wire.open('ws://host/ws/gamepad');
  const socket = FakeSocket.instances.at(-1);
  socket.open();
  await tick(30);
  assert.equal(socket.sent.length, 0, 'nothing before hello');
  socket.onmessage({ data: JSON.stringify({ type: 'hello', available: true, backend: 'vigem' }) });
  wire.setTouch({ ...NEUTRAL, lx: 1 });
  await tick(30);
  assert.ok(socket.sent.length > 0);
  assert.ok(socket.sent.at(-1).lx > 0.99, 'touch state on the wire in auto mode with no pad');
  wire.setPhysicalConnected(true); wire.setPhysical({ ...NEUTRAL, ly: -1 });
  await tick(30);
  assert.ok(socket.sent.at(-1).ly < -0.99, 'physical pad wins in auto mode once connected');
  wire.setInputMode('phone'); wire.setTouch({ ...NEUTRAL, rx: 1 });
  await tick(30);
  assert.ok(socket.sent.at(-1).rx > 0.99, 'phone mode ignores the pad');
  wire.setSuppressed(true);
  await tick(30);
  assert.deepEqual(neutral(socket.sent.at(-1)), { ...NEUTRAL, seq: 0 }, 'suppressed sends neutral');
  const before = socket.sent.length;
  wire.close();
  assert.deepEqual(neutral(socket.sent[before]), { ...NEUTRAL, seq: 0 }, 'one neutral frame on close');
  assert.equal(closes.length, 0, 'a deliberate close reports nothing');
});

test('js transport: a remote close surfaces code and reason once', () => {
  globalThis.WebSocket = FakeSocket;
  const closes = [];
  const wire = jsTransport({ onMessage: () => { }, onClose: (code, reason) => closes.push([code, reason]) });
  wire.open('ws://host/ws/gamepad');
  const socket = FakeSocket.instances.at(-1);
  socket.readyState = 3; socket.onclose({ code: 1001, reason: 'Controller timed out' });
  assert.deepEqual(closes, [[1001, 'Controller timed out']]);
  wire.close();
});

test('native transport: forwards state to the module and relays its events', async () => {
  const calls = [], listeners = {};
  const native = {
    addListener: (event, fn) => { listeners[event] = fn; return { remove: () => { delete listeners[event]; } }; },
    startSession: async url => { calls.push(['start', url]); },
    stopSession: async () => { calls.push(['stop']); },
    setTouchState: async state => { calls.push(['touch', state]); },
    setInputMode: async mode => { calls.push(['mode', mode]); },
    setSuppressed: async value => { calls.push(['suppress', value]); },
  };
  const messages = [], closes = [];
  const wire = nativeTransport({ onMessage: t => messages.push(t), onClose: (c, r) => closes.push([c, r]) }, native);
  wire.open('ws://host/ws/gamepad?preset=roblox');
  wire.setTouch({ ...NEUTRAL, lx: 0.5 }); wire.setInputMode('phone'); wire.setSuppressed(true);
  listeners.onSessionMessage({ text: '{"type":"hello"}' });
  listeners.onSessionClose({ code: 1008, reason: 'Controller busy' });
  listeners.onSessionClose({});
  await tick(1);
  assert.deepEqual(calls, [['start', 'ws://host/ws/gamepad?preset=roblox'], ['touch', { ...NEUTRAL, lx: 0.5 }], ['mode', 'phone'], ['suppress', true]]);
  assert.deepEqual(messages, ['{"type":"hello"}']);
  assert.deepEqual(closes, [[1008, 'Controller busy'], [1006, '']]);
  wire.close();
  await tick(1);
  assert.deepEqual(calls.at(-1), ['stop']);
  assert.equal(listeners.onSessionMessage, undefined, 'listeners removed on close');
});

test('native transport: a failed native start reports a close so the hook retries', async () => {
  const native = {
    addListener: () => ({ remove() { } }), startSession: async () => { throw new Error('bad url'); }, stopSession: async () => { },
    setTouchState: async () => { }, setInputMode: async () => { }, setSuppressed: async () => { },
  };
  const closes = [];
  const wire = nativeTransport({ onMessage: () => { }, onClose: (c, r) => closes.push([c, r]) }, native);
  wire.open('nope');
  await tick(1);
  assert.deepEqual(closes, [[1006, 'bad url']]);
  wire.close();
});
