// Unit tests for the sign-in gate and the computers-list merge.
//
//   cd app && node --test src/account/gate.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { signInRequired } from './gate.ts';
import { mergeComputers } from './merge-devices.ts';

const base = { ready: true, signedIn: false, deviceCount: 0, adding: false };

test('nothing moves until both stores are read', () => {
  assert.equal(signInRequired({ ...base, ready: false }), false);
});

test('a fresh install must sign in before the pairing flow', () => {
  assert.equal(signInRequired(base), true);
});

test('a phone already paired over LAN keeps working signed out', () => {
  // Accounts arrived after these pairings; the owner asked for them to keep
  // working. Remote use (the tunnel) needs the account; the LAN path does not.
  assert.equal(signInRequired({ ...base, deviceCount: 2 }), false);
});

test('adding a new computer is gated on sign-in even for an already-paired phone', () => {
  assert.equal(signInRequired({ ...base, deviceCount: 2, adding: true }), true);
});

test('signed in means never gated', () => {
  assert.equal(signInRequired({ ...base, signedIn: true }), false);
  assert.equal(signInRequired({ ...base, signedIn: true, deviceCount: 3, adding: true }), false);
});

const local = (id, nodeId) => ({ id, label: id, platform: 'darwin', addresses: [], token: 't', addedAt: 1, ...(nodeId ? { nodeId } : {}) });
const remote = (id, kind, nodeId) => ({ id, kind, name: id, platform: 'darwin', nodeId, lastSeenAt: null });

test('account computers that are not paired locally are listed as linked-only', () => {
  const merged = mergeComputers([local('mac')], [remote('r1', 'host', 'n1'), remote('phone', 'phone', 'np')]);
  assert.deepEqual(merged.linkedOnly.map((d) => d.id), ['r1'], 'this phone itself is never listed');
  assert.deepEqual(merged.local.map((d) => d.id), ['mac']);
});

test('a computer paired locally and linked to the account appears once, with its node id', () => {
  const merged = mergeComputers([local('mac', 'n1')], [remote('r1', 'host', 'n1')]);
  assert.equal(merged.linkedOnly.length, 0);
  assert.equal(merged.local[0].nodeId, 'n1');
});

test('an unknown device kind is treated as a computer, not dropped', () => {
  const merged = mergeComputers([], [remote('r1', 'desktop', 'n1')]);
  assert.equal(merged.linkedOnly.length, 1);
});
