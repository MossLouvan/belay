// Unit tests for the paired-device parsing and the revocation reasoning.
//
//   cd app && node --test src/system/devices.test.mjs
//
// Same shape as the other suites here: no framework, plain assertions, only
// JSX-free modules imported.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { canRevoke, isSelfDevice, parseDevices, revocationCopy } from './devices-model.ts';

const OWN_TOKEN = 'aabbccdd' + 'e'.repeat(56);

const payload = {
  devices: [
    { tokenPrefix: 'aabbccdd', name: 'iPhone', createdAt: 1000, lastSeen: 2000 },
    { tokenPrefix: '11223344', name: 'Old iPhone', createdAt: 500, lastSeen: 600 },
  ],
};

test('parseDevices keeps the prefix as identity and defaults the numbers', () => {
  const devices = parseDevices({ devices: [{ name: 'X', tokenPrefix: 'abcd1234' }] });
  assert.equal(devices.length, 1);
  assert.equal(devices[0].tokenPrefix, 'abcd1234');
  assert.equal(devices[0].lastSeen, 0);
});

test('parseDevices tolerates garbage and older hosts without a prefix', () => {
  assert.deepEqual(parseDevices(null), []);
  assert.deepEqual(parseDevices({ devices: 'nope' }), []);
  const [d] = parseDevices({ devices: [{ name: 'Legacy', createdAt: 1, lastSeen: 2 }] });
  assert.equal(d.tokenPrefix, '');
  // A row the app cannot name to the revoke route must not offer to revoke.
  assert.equal(canRevoke(d), false);
});

test('a short prefix is listed but never offered for revocation', () => {
  const [d] = parseDevices({ devices: [{ name: 'X', tokenPrefix: 'ab' }] });
  assert.equal(canRevoke(d), false);
});

test('the phone in hand is recognised by its own token, nothing else', () => {
  const devices = parseDevices(payload);
  assert.equal(isSelfDevice(devices[0], OWN_TOKEN), true);
  assert.equal(isSelfDevice(devices[1], OWN_TOKEN), false);
  assert.equal(isSelfDevice(devices[0], undefined), false);
  assert.equal(isSelfDevice(devices[0], ''), false);
});

test('self-revocation is named as a logout, before it happens', () => {
  const [self] = parseDevices(payload);
  const copy = revocationCopy(self, true);
  assert.equal(copy.self, true);
  assert.match(copy.title, /Log this phone out/);
  assert.match(copy.body, /phone in your hand/);
  assert.match(copy.body, /new pairing code/);
});

test('revoking another device names the device and the lack of undo', () => {
  const other = parseDevices(payload)[1];
  const copy = revocationCopy(other, false);
  assert.equal(copy.self, false);
  assert.match(copy.title, /Revoke Old iPhone\?/);
  assert.match(copy.body, /no undo/);
  assert.match(copy.body, /screen or terminal .* cut/);
});
