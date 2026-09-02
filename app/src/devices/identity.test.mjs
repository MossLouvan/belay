// Unit tests for host-identity reconciliation.
//
//   cd app && node --test src/devices/identity.test.mjs
//
// Same shape as the other suites here: no framework, plain assertions, only
// JSX-free modules imported.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkHostIdentity } from './identity.ts';

test('a real-id entry matches when the host reports the same id', () => {
  assert.equal(checkHostIdentity('mac-uuid', 'mac-uuid'), 'match');
});

// The regression this whole change exists for: the computer reset its pairing,
// minted a fresh id, and now answers at the same address as a different
// machine. The saved token was issued to the old id, so every authed call 401s
// — connectTo must NOT treat this as a successful connection.
test('a real-id entry rejects a host that reports a different id', () => {
  assert.equal(checkHostIdentity('old-uuid', 'new-uuid-after-reset'), 'mismatch');
});

test('a legacy entry adopts whatever real id the host reports', () => {
  assert.equal(checkHostIdentity('legacy:http://10.0.0.5:8787', 'real-uuid'), 'adopt');
});

test('a legacy entry with no reported id has nothing to adopt yet', () => {
  assert.equal(checkHostIdentity('legacy:http://10.0.0.5:8787', undefined), 'unknown');
});

test('a real-id entry against an id-less (older) host is left unverified', () => {
  assert.equal(checkHostIdentity('mac-uuid', undefined), 'unknown');
});
