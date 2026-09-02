// The rule that stops a transient keychain read failure from permanently
// un-pairing a computer.
//
//   cd app && node --test src/devices/token-resolve.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveLoadedToken, isUnresolved, SECURE_MARK } from './token-resolve.ts';

test('a non-marker token is returned unchanged', () => {
  assert.equal(resolveLoadedToken('real-token', { kind: 'failed' }), 'real-token');
});

test('marker + present value resolves to the real token', () => {
  assert.equal(resolveLoadedToken(SECURE_MARK, { kind: 'value', token: 'tok' }), 'tok');
});

test('marker + genuinely absent drops the device (empty token)', () => {
  assert.equal(resolveLoadedToken(SECURE_MARK, { kind: 'absent' }), '');
});

test('marker + READ FAILURE keeps the marker so the device is NOT dropped', () => {
  // The core of the fix: a locked-phone read failure must not become '' (which
  // would drop the device and then delete its real keychain entry on save).
  const token = resolveLoadedToken(SECURE_MARK, { kind: 'failed' });
  assert.equal(token, SECURE_MARK);
  assert.ok(token.length > 0, 'non-empty, so parseStore keeps the device');
  assert.ok(isUnresolved(token), 'flagged unresolved so save leaves the keychain entry alone');
});

test('isUnresolved only matches the marker', () => {
  assert.ok(isUnresolved(SECURE_MARK));
  assert.ok(!isUnresolved('real'));
  assert.ok(!isUnresolved(''));
});
