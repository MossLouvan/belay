import assert from 'node:assert/strict';
import { test } from 'node:test';

import { onAppMessage, postToApp, qrModules, requestFromApp, underHostApp } from '../src/host-ipc.js';

test('outside Belay.app the bridge is inert', async () => {
  assert.equal(underHostApp(), false);
  assert.doesNotThrow(() => postToApp({ type: 'pairing' }));
  await assert.rejects(requestFromApp({ type: 'autostart', action: 'status' }), /not running under Belay.app/);
});

test('qrModules is a square matrix with the three finder patterns', () => {
  const m = qrModules('belay://pair?v=1&id=abc&c=123456');
  assert.ok(m.length >= 21);
  for (const row of m) assert.equal(row.length, m.length);
  // Finder pattern corners are dark; the cell diagonally inside the 7x7 ring is light.
  for (const [r, c] of [[0, 0], [0, m.length - 1], [m.length - 1, 0]]) {
    assert.equal(m[r][c], true);
  }
  assert.equal(m[1][1], false);
});

test('commands from Belay.app reach onAppMessage; replies to requests do not', async () => {
  type Listener = (event: { data: unknown }) => void;
  const listeners: Listener[] = [];
  const sent: unknown[] = [];
  const fake = { postMessage: (m: unknown) => sent.push(m), on: (_e: 'message', fn: Listener) => listeners.push(fn) };
  (process as unknown as { parentPort?: unknown }).parentPort = fake;
  try {
    const seen: unknown[] = [];
    onAppMessage((m) => seen.push(m));
    const emit = (data: unknown) => { for (const fn of listeners) fn({ data }); };

    emit({ type: 'pair-code' });
    assert.deepEqual(seen, [{ type: 'pair-code' }]);

    const reply = requestFromApp({ type: 'autostart', action: 'status' });
    const { id } = sent.at(-1) as { id: number };
    emit({ id, installed: true });
    assert.deepEqual(await reply, { id, installed: true });
    assert.equal(seen.length, 1, 'a reply is not a command');
    assert.equal(listeners.length, 1, 'one port listener, however many users');

    emit(null);
    emit('junk');
    assert.equal(seen.length, 1, 'non-objects are ignored');
  } finally {
    delete (process as unknown as { parentPort?: unknown }).parentPort;
  }
});
