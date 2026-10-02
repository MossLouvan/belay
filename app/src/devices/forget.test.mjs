// Forgetting a computer revokes this phone's own token on the host first,
// best effort, then always drops the pairing locally (#83).
//
//   cd app && node --test src/devices/forget.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { forgetDevice, revokeAtVerifiedHost } from './forget.ts';

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

// The token never goes to an address verify-host has not passed: a stale
// LAN/Tailscale IP can belong to a different machine after a Wi-Fi change.
const deps = (over = {}) => {
  const posted = [];
  const d = {
    connectedHost: null,
    checkHost: async () => ({ ok: true, id: 'mac' }),
    verify: async () => ({ ok: true }),
    revoke: async (_device, host) => { posted.push(host); },
    ...over,
  };
  return { d, posted };
};

test('a verify-host mismatch means no revoke, and forget still removes locally', async () => {
  const { d, posted } = deps({ verify: async () => ({ ok: false, problem: 'identity' }) });
  const next = await forgetDevice(store, 'mac', (dev) => revokeAtVerifiedHost(dev, d));
  assert.deepEqual(posted, []);
  assert.deepEqual(next.devices.map((x) => x.id), ['pc']);
});

test('a host that does not answer is not revoked at', async () => {
  const { d, posted } = deps({ checkHost: async () => ({ ok: false }) });
  await assert.rejects(revokeAtVerifiedHost(device, d));
  assert.deepEqual(posted, []);
});

test('a verified host is revoked at, and the reported id feeds the check', async () => {
  const seen = [];
  const { d, posted } = deps({
    checkHost: async () => ({ ok: true, id: 'other-id' }),
    verify: async (input) => { seen.push(input); return { ok: true }; },
  });
  await revokeAtVerifiedHost({ ...device, lastKnownGoodUrl: 'http://10.0.0.9:8787' }, d);
  assert.deepEqual(posted, ['http://10.0.0.9:8787']);
  assert.deepEqual(seen, [{ device: { ...device, lastKnownGoodUrl: 'http://10.0.0.9:8787' }, url: 'http://10.0.0.9:8787', reportedHostId: 'other-id' }]);
});

test('the live, already-verified connection is reused without a second probe', async () => {
  const { d, posted } = deps({
    connectedHost: 'http://100.64.0.1:8787',
    checkHost: async () => { throw new Error('must not probe'); },
    verify: async () => { throw new Error('must not re-verify'); },
  });
  await revokeAtVerifiedHost(device, d);
  assert.deepEqual(posted, ['http://100.64.0.1:8787']);
});

test('an unknown id revokes nothing and changes nothing', async () => {
  let called = 0;
  const next = await forgetDevice(store, 'nope', async () => { called += 1; });
  assert.equal(called, 0);
  assert.deepEqual(next, store);
});
