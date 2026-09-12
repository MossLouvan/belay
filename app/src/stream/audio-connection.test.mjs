import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectHostAudio } from './audio-connection.ts';

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

function connection(overrides = {}) {
  const sockets = [];
  const statuses = [];
  const frames = [];
  const timers = new Map();
  let resets = 0;
  let tickets = 0;
  const stop = connectHostAudio({
    getUrl: async () => `ws://host/audio?ticket=${++tickets}`,
    createSocket: (url) => {
      const socket = { url, readyState: 1, close() { this.readyState = 3; this.onclose?.(); } };
      sockets.push(socket);
      return socket;
    },
    isUnauthorized: () => false,
    onReset: () => { resets += 1; },
    onBytes: (bytes) => frames.push(bytes),
    onStatus: (status) => statuses.push(status),
    schedule: (callback, delay) => { const id = {}; timers.set(id, { callback, delay }); return id; },
    cancel: (id) => timers.delete(id),
    ...overrides,
  });
  return { sockets, statuses, frames, timers, stop, get resets() { return resets; } };
}

test('binary packets reach the receiver; capture error messages are visible', async () => {
  const c = connection();
  await flush();
  c.sockets[0].onmessage({ data: new Uint8Array([1, 2]).buffer });
  c.sockets[0].onmessage({ data: JSON.stringify({ type: 'error', error: 'Screen recording permission missing' }) });
  assert.deepEqual([...c.frames[0]], [1, 2]);
  assert.deepEqual(c.statuses.at(-1), { phase: 'error', message: 'Screen recording permission missing' });
  c.sockets[0].close();
  assert.equal(c.statuses.at(-1).message, 'Screen recording permission missing');
  c.stop();
});

test('a dead audio connection retries with a fresh ticket and receiver', async () => {
  const c = connection();
  await flush();
  c.sockets[0].close();
  assert.equal(c.timers.size, 1);
  const retry = [...c.timers.values()][0];
  assert.equal(retry.delay, 1000);
  retry.callback();
  await flush();
  assert.equal(c.sockets[1].url, 'ws://host/audio?ticket=2');
  assert.equal(c.resets, 2);
  c.stop();
});

test('mute cancels retries and closes the active socket', async () => {
  const c = connection();
  await flush();
  c.stop();
  assert.equal(c.sockets[0].readyState, 3);
  assert.equal(c.timers.size, 0);
});

test('a ticket arriving after mute cannot open a socket', async () => {
  let resolve;
  const c = connection({ getUrl: () => new Promise((done) => { resolve = done; }) });
  c.stop();
  resolve('ws://late');
  await flush();
  assert.equal(c.sockets.length, 0);
});

test('unpairing is terminal and transient ticket failures retry', async () => {
  const error = new Error('unpaired');
  const terminal = connection({ getUrl: async () => { throw error; }, isUnauthorized: (e) => e === error });
  await flush();
  assert.equal(terminal.timers.size, 0);
  terminal.stop();
  const transient = connection({ getUrl: async () => { throw new Error('offline'); } });
  await flush();
  assert.equal(transient.timers.size, 1);
  transient.stop();
});

test('socket errors retry once, and obsolete messages cannot reach the receiver', async () => {
  const c = connection();
  await flush();
  const old = c.sockets[0];
  old.onerror();
  old.onclose();
  old.onmessage({ data: new Uint8Array([99]).buffer });
  assert.equal(c.frames.length, 0);
  assert.equal(c.timers.size, 1);
  assert.equal(c.statuses.at(-1).phase, 'error');
  c.stop();
  assert.equal(c.timers.size, 0);
});

test('malformed control messages are ignored while transport remains usable', async () => {
  const c = connection();
  await flush();
  const socket = c.sockets[0];
  for (const data of ['not json', 'null', '{}', '"text"', '{"type":"error","error":7}', 7]) {
    assert.doesNotThrow(() => socket.onmessage({ data }));
  }
  socket.onmessage({ data: new Uint8Array([42]).buffer });
  assert.equal(c.frames[0][0], 42);
  assert.equal(c.statuses.length, 1);
  c.stop();
});

test('retry delay backs off to a cap during a sustained outage', async () => {
  const c = connection({ getUrl: async () => { throw new Error('offline'); } });
  await flush();
  for (const expected of [1000, 2000, 4000, 5000, 5000]) {
    const [id, retry] = [...c.timers.entries()][0];
    assert.equal(retry.delay, expected);
    c.timers.delete(id);
    retry.callback();
    await flush();
  }
  c.stop();
});

test('an already queued retry cannot change status or fetch tickets after mute', async () => {
  const c = connection();
  await flush();
  c.sockets[0].close();
  const retry = [...c.timers.values()][0];
  c.stop();
  const reports = c.statuses.length;
  retry.callback();
  await flush();
  assert.equal(c.statuses.length, reports);
  assert.equal(c.sockets.length, 1);
});

test('a host that cannot do audio is told once, with the fix, and never retried', async () => {
  const c = connection({
    probeSupport: async () => ({
      supported: false,
      kind: 'host-too-old',
      message: "This computer's Belay host is too old to stream audio.",
      hint: 'Update Belay on that computer and try again.',
    }),
  });
  await flush();
  await flush();
  assert.equal(c.sockets.length, 0, 'no socket is opened against a host that said no');
  assert.equal(c.timers.size, 0, 'a permanent refusal must not schedule retries');
  assert.deepEqual(c.statuses.at(-1), {
    phase: 'error',
    message: "This computer's Belay host is too old to stream audio.",
    hint: 'Update Belay on that computer and try again.',
    kind: 'host-too-old',
  });
  c.stop();
});

test('a probe that could not reach the host still opens the socket and still retries', async () => {
  const c = connection({
    probeSupport: async () => ({ supported: false, kind: 'unreachable', message: 'Could not ask', hint: '' }),
  });
  await flush();
  await flush();
  assert.equal(c.sockets.length, 1, '"could not tell" is a blip, not a refusal');
  c.sockets[0].close();
  assert.equal(c.timers.size, 1);
  c.stop();
});

test('a supported host connects exactly as before the probe existed', async () => {
  const c = connection({ probeSupport: async () => ({ supported: true, kind: '', message: '', hint: '' }) });
  await flush();
  await flush();
  assert.equal(c.sockets[0].url, 'ws://host/audio?ticket=1');
  c.stop();
});

test('a host error message carries its hint and kind to the UI when it has them', async () => {
  const c = connection();
  await flush();
  c.sockets[0].onmessage({ data: JSON.stringify({
    type: 'error', error: 'No audio device', kind: 'no-device', hint: 'Plug in speakers.',
  }) });
  assert.deepEqual(c.statuses.at(-1), {
    phase: 'error', message: 'No audio device', hint: 'Plug in speakers.', kind: 'no-device',
  });
  c.stop();
});
