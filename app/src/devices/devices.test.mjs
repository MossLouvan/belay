// Unit tests for the saved-computers model and the address racer.
//
//   cd app && node --test src/devices/devices.test.mjs
//
// Same shape as the other suites here: no framework, plain assertions. Only
// JSX-free modules are imported, since Node strips types but does not compile
// JSX.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  emptyStore, upsertDevice, findDevice, activeDevice, setActive, removeDevice,
  renameDevice, updateAddresses, recordSuccess, mergeAddresses, orderAddresses,
  isReachableFromAnywhere, migrateLegacy, adoptRealId, isLegacyId, parseStore,
} from './model.ts';
import { raceAddresses } from './race.ts';

const mac = {
  id: 'mac-uuid',
  label: 'MacBook Air',
  platform: 'darwin',
  addresses: [
    { kind: 'lan', url: 'http://192.168.1.5:8787' },
    { kind: 'tailscale', url: 'http://100.101.102.103:8787' },
  ],
  token: 'mac-token',
  addedAt: 1000,
};

const pc = {
  id: 'pc-uuid',
  label: 'Windows PC',
  platform: 'win32',
  addresses: [{ kind: 'tailscale', url: 'http://100.64.7.7:8787' }],
  token: 'pc-token',
  addedAt: 2000,
};

// ---- the headline behaviour ---------------------------------------------

test('saving a second computer does not destroy the first', () => {
  // This is the entire point. The old model overwrote one flat token key, so
  // pairing the PC silently un-paired the Mac.
  let store = upsertDevice(emptyStore(), mac);
  store = upsertDevice(store, pc);

  assert.equal(store.devices.length, 2);
  assert.equal(findDevice(store, 'mac-uuid')?.token, 'mac-token');
  assert.equal(findDevice(store, 'pc-uuid')?.token, 'pc-token');
});

test('switching between computers keeps both tokens', () => {
  let store = upsertDevice(upsertDevice(emptyStore(), mac), pc);
  store = setActive(store, 'mac-uuid');
  assert.equal(activeDevice(store)?.label, 'MacBook Air');

  store = setActive(store, 'pc-uuid');
  assert.equal(activeDevice(store)?.label, 'Windows PC');
  assert.equal(findDevice(store, 'mac-uuid')?.token, 'mac-token', 'the Mac is still paired');
});

test('re-pairing the same computer updates it instead of duplicating it', () => {
  let store = upsertDevice(emptyStore(), mac);
  store = upsertDevice(store, { ...mac, token: 'new-token', label: 'Renamed' });

  assert.equal(store.devices.length, 1);
  assert.equal(findDevice(store, 'mac-uuid')?.token, 'new-token');
  assert.equal(findDevice(store, 'mac-uuid')?.label, 'Renamed');
});

test('forgetting one computer leaves the other paired and active', () => {
  let store = upsertDevice(upsertDevice(emptyStore(), mac), pc);
  store = setActive(store, 'pc-uuid');
  store = removeDevice(store, 'pc-uuid');

  assert.equal(store.devices.length, 1);
  assert.equal(store.activeId, 'mac-uuid', 'active falls back rather than going nowhere');
});

test('removing the last computer leaves no active id', () => {
  const store = removeDevice(upsertDevice(emptyStore(), mac), 'mac-uuid');
  assert.deepEqual(store.devices, []);
  assert.equal(store.activeId, null);
});

test('setActive ignores an unknown id rather than pointing at nothing', () => {
  const store = setActive(upsertDevice(emptyStore(), mac), 'does-not-exist');
  assert.equal(store.activeId, 'mac-uuid');
});

test('renaming touches only the named computer', () => {
  let store = upsertDevice(upsertDevice(emptyStore(), mac), pc);
  store = renameDevice(store, 'pc-uuid', 'Gaming rig');
  assert.equal(findDevice(store, 'pc-uuid')?.label, 'Gaming rig');
  assert.equal(findDevice(store, 'mac-uuid')?.label, 'MacBook Air');
});

test('store updates never mutate the previous store', () => {
  const before = upsertDevice(emptyStore(), mac);
  const snapshot = JSON.stringify(before);
  upsertDevice(before, pc);
  renameDevice(before, 'mac-uuid', 'changed');
  removeDevice(before, 'mac-uuid');
  assert.equal(JSON.stringify(before), snapshot);
});

// ---- addresses -----------------------------------------------------------

test('mergeAddresses keeps measured RTT across a refresh', () => {
  const existing = [{ kind: 'lan', url: 'http://a:8787', lastOkAt: 500, lastRttMs: 12 }];
  const advertised = [{ kind: 'lan', url: 'http://a:8787' }];
  const merged = mergeAddresses(existing, advertised);
  assert.equal(merged[0].lastRttMs, 12);
  assert.equal(merged[0].lastOkAt, 500);
});

test('mergeAddresses drops an address the host no longer advertises', () => {
  // How a stale LAN IP eventually disappears instead of being retried forever.
  const existing = [
    { kind: 'lan', url: 'http://old:8787' },
    { kind: 'tailscale', url: 'http://100.64.0.1:8787' },
  ];
  const advertised = [{ kind: 'tailscale', url: 'http://100.64.0.1:8787' }];
  const merged = mergeAddresses(existing, advertised);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].url, 'http://100.64.0.1:8787');
});

test('mergeAddresses lets the host re-classify an address', () => {
  const merged = mergeAddresses(
    [{ kind: 'lan', url: 'http://x:8787' }],
    [{ kind: 'magicdns', url: 'http://x:8787' }],
  );
  assert.equal(merged[0].kind, 'magicdns');
});

test('orderAddresses puts last-known-good first', () => {
  const ordered = orderAddresses(mac.addresses, 'http://100.101.102.103:8787');
  assert.equal(ordered[0].url, 'http://100.101.102.103:8787');
});

test('orderAddresses otherwise prefers LAN', () => {
  const ordered = orderAddresses(mac.addresses);
  assert.equal(ordered[0].kind, 'lan');
});

test('updateAddresses refreshes paths without touching the token', () => {
  let store = upsertDevice(emptyStore(), mac);
  store = updateAddresses(store, 'mac-uuid', [{ kind: 'lan', url: 'http://192.168.1.99:8787' }]);
  const updated = findDevice(store, 'mac-uuid');
  assert.equal(updated.addresses.length, 1);
  assert.equal(updated.addresses[0].url, 'http://192.168.1.99:8787');
  assert.equal(updated.token, 'mac-token', 'a new IP must never cost you the pairing');
});

test('recordSuccess pins the winning address for next time', () => {
  let store = upsertDevice(emptyStore(), mac);
  store = recordSuccess(store, 'mac-uuid', 'http://100.101.102.103:8787', 42, 9999);

  const d = findDevice(store, 'mac-uuid');
  assert.equal(d.lastKnownGoodUrl, 'http://100.101.102.103:8787');
  assert.equal(d.lastConnectedAt, 9999);
  const winner = d.addresses.find((a) => a.url === 'http://100.101.102.103:8787');
  assert.equal(winner.lastRttMs, 42);
  assert.equal(orderAddresses(d.addresses, d.lastKnownGoodUrl)[0].url, 'http://100.101.102.103:8787');
});

test('isReachableFromAnywhere is false for a LAN-only computer', () => {
  assert.equal(isReachableFromAnywhere({ ...mac, addresses: [mac.addresses[0]] }), false);
  assert.equal(isReachableFromAnywhere(mac), true);
  assert.equal(isReachableFromAnywhere({ ...mac, addresses: [] }), false);
});

// ---- migration -----------------------------------------------------------

test('an existing single connection migrates without re-pairing', () => {
  const store = migrateLegacy(
    { host: 'http://192.168.1.5:8787', token: 'old-token', hostName: 'Mosss-MacBook' },
    123,
  );
  assert.equal(store.devices.length, 1);
  assert.equal(store.devices[0].token, 'old-token', 'the token survives — nobody re-pairs');
  assert.equal(store.devices[0].label, 'Mosss-MacBook');
  assert.equal(store.activeId, store.devices[0].id);
  assert.ok(isLegacyId(store.devices[0].id));
});

test('migrating nothing yields an empty store', () => {
  assert.deepEqual(migrateLegacy(null, 1).devices, []);
  assert.deepEqual(migrateLegacy({ host: '', token: '', hostName: '' }, 1).devices, []);
});

test('a migrated computer adopts the host real id on first connect', () => {
  const store = migrateLegacy({ host: 'http://h:8787', token: 't', hostName: 'H' }, 1);
  const legacyId = store.devices[0].id;
  const adopted = adoptRealId(store, legacyId, 'real-uuid');

  assert.equal(adopted.devices.length, 1);
  assert.equal(adopted.devices[0].id, 'real-uuid');
  assert.equal(adopted.devices[0].token, 't', 'token kept through the id change');
  assert.equal(adopted.activeId, 'real-uuid');
});

test('adopting an id already saved drops the duplicate instead of forking', () => {
  let store = migrateLegacy({ host: 'http://h:8787', token: 't', hostName: 'H' }, 1);
  const legacyId = store.devices[0].id;
  store = upsertDevice(store, mac);

  const adopted = adoptRealId(store, legacyId, 'mac-uuid');
  assert.equal(adopted.devices.length, 1);
  assert.equal(adopted.devices[0].id, 'mac-uuid');
});

test('adoptRealId refuses to touch a non-legacy entry', () => {
  const store = upsertDevice(emptyStore(), mac);
  assert.equal(adoptRealId(store, 'mac-uuid', 'other').devices[0].id, 'mac-uuid');
});

// ---- parsing untrusted storage ------------------------------------------

test('parseStore accepts a well-formed store', () => {
  const store = upsertDevice(emptyStore(), mac);
  const parsed = parseStore(JSON.parse(JSON.stringify(store)));
  assert.equal(parsed.devices.length, 1);
  assert.equal(parsed.activeId, 'mac-uuid');
});

test('parseStore rejects junk rather than throwing', () => {
  for (const bad of [null, undefined, 42, 'nope', {}, { version: 99, devices: [] }, { version: 1 }]) {
    assert.equal(parseStore(bad), null, `${JSON.stringify(bad)} must not parse`);
  }
});

test('parseStore drops malformed devices and keeps valid ones', () => {
  const parsed = parseStore({
    version: 1,
    activeId: 'mac-uuid',
    devices: [
      mac,
      { id: 'no-token', label: 'x', addresses: [] },
      { label: 'no-id', token: 't', addresses: [] },
      null,
      'not-an-object',
      { id: 'bad-addr', label: 'x', token: 't', addresses: [{ kind: 'lan' }] },
    ],
  });
  assert.equal(parsed.devices.length, 1);
  assert.equal(parsed.devices[0].id, 'mac-uuid');
});

test('parseStore repairs an activeId pointing at a device that is gone', () => {
  const parsed = parseStore({ version: 1, activeId: 'ghost', devices: [mac] });
  assert.equal(parsed.activeId, 'mac-uuid');
});

// ---- the racer -----------------------------------------------------------

const noStagger = { staggerMs: 0, sleep: async () => {} };

test('the racer returns the address that answers', async () => {
  const probe = async (url) => ({ ok: url.includes('100.101') });
  const winner = await raceAddresses(orderAddresses(mac.addresses), probe, noStagger);
  assert.equal(winner.url, 'http://100.101.102.103:8787');
});

test('the racer returns null when nothing answers', async () => {
  // A meaningful state — computer asleep, or wrong network — not a spinner.
  const winner = await raceAddresses(orderAddresses(mac.addresses), async () => ({ ok: false }), noStagger);
  assert.equal(winner, null);
});

test('the racer returns null for a computer with no addresses', async () => {
  assert.equal(await raceAddresses([], async () => ({ ok: true })), null);
});

test('a probe that throws is a loss, not a crash', async () => {
  const probe = async (url) => {
    if (url.includes('192.168')) throw new Error('network unreachable');
    return { ok: true };
  };
  const winner = await raceAddresses(orderAddresses(mac.addresses), probe, noStagger);
  assert.equal(winner.url, 'http://100.101.102.103:8787');
});

test('the racer aborts the losers once one wins', async () => {
  const aborted = [];
  const probe = (url, signal) => new Promise((resolve) => {
    signal.addEventListener('abort', () => { aborted.push(url); resolve({ ok: false }); });
    if (url.includes('100.101')) resolve({ ok: true });
  });
  const winner = await raceAddresses(orderAddresses(mac.addresses, 'http://100.101.102.103:8787'), probe, noStagger);
  assert.equal(winner.url, 'http://100.101.102.103:8787');
  assert.ok(aborted.includes('http://192.168.1.5:8787'), 'the slow LAN probe was cancelled');
});

test('the racer surfaces the host id so a legacy entry can adopt it', async () => {
  const probe = async () => ({ ok: true, hostId: 'real-uuid' });
  const winner = await raceAddresses(orderAddresses(mac.addresses), probe, noStagger);
  assert.equal(winner.hostId, 'real-uuid');
});

test('the racer measures RTT with an injected clock', async () => {
  let t = 0;
  const now = () => t;
  const probe = async () => { t += 25; return { ok: true }; };
  const winner = await raceAddresses(orderAddresses(mac.addresses), probe, { ...noStagger, now });
  assert.equal(winner.rttMs, 25);
});

test('a probe hanging past the timeout loses to a fast one', async () => {
  const probe = (url, signal) => new Promise((resolve) => {
    if (url.includes('192.168')) {
      signal.addEventListener('abort', () => resolve({ ok: false }));
      return; // never resolves on its own
    }
    resolve({ ok: true });
  });
  const winner = await raceAddresses(orderAddresses(mac.addresses), probe, { ...noStagger, timeoutMs: 20 });
  assert.equal(winner.url, 'http://100.101.102.103:8787');
});
