import assert from 'node:assert/strict';
import { test } from 'node:test';

import { postToApp, qrModules, requestFromApp, underHostApp } from '../src/host-ipc.js';

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
