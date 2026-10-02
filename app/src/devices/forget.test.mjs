// Forgetting a computer revokes this phone's own token on the host first,
// best effort, then always drops the pairing locally (#83).
//
//   cd app && node --test src/devices/forget.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { forgetDevice } from './forget.ts';

const device = { id: 'mac', label: 'Mac', platform: 'darwin', addresses: [{ kind: 'lan', url: 'http://10.0.0.5:8787' }], token: 't', addedAt: 1 };
const store = { version: 1, devices: [device, { ...device, id: 'pc', label: 'PC' }], activeId: 'mac' };

test('revokes the forgotten computer, then removes it locally', async () => {
  const revoked = [];
  const next = await forgetDevice(store, 'mac', async (d) => { revoked.push(d.id); });
  assert.deepEqual(revoked, ['mac']);
  assert.deepEqual(next.devices.map((d) => d.id), ['pc']);
  assert.equal(next.activeId, 'pc');
  assert.equal(store.devices.length, 2, 'input store is not mutated');
});

test('an unreachable host still forgets locally', async () => {
  const next = await forgetDevice(store, 'mac', async () => { throw new TypeError('Network request failed'); });
  assert.deepEqual(next.devices.map((d) => d.id), ['pc']);
});

test('an unknown id revokes nothing and changes nothing', async () => {
  let called = 0;
  const next = await forgetDevice(store, 'nope', async () => { called += 1; });
  assert.equal(called, 0);
  assert.deepEqual(next, store);
});
