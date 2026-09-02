import test from 'node:test';
import assert from 'node:assert/strict';

import { connectLanding, postPairDestination } from './landing.ts';

const base = { ready: true, connected: false, deviceCount: 0, connecting: false, adding: false };

test('a fresh install stays on the pairing flow', () => {
  assert.equal(connectLanding(base), null);
});

test('nothing moves before the store has been read', () => {
  assert.equal(connectLanding({ ...base, ready: false, connected: true, deviceCount: 2 }), null);
});

test('a live connection goes straight to the tabs', () => {
  assert.equal(connectLanding({ ...base, connected: true, deviceCount: 1 }), '/(tabs)/screen');
});

test('saved computers without a connection land on the list', () => {
  assert.equal(connectLanding({ ...base, deviceCount: 2 }), '/devices');
});

test('an in-flight connect is left to finish rather than redirected', () => {
  assert.equal(connectLanding({ ...base, deviceCount: 1, connecting: true }), null);
});

test('coming to add another computer is never bounced away', () => {
  // The regression this file exists for: with one computer saved (or even
  // connected), "Add a computer" used to land here and be redirected right
  // back — pairing the second machine was unreachable from the UI.
  assert.equal(connectLanding({ ...base, adding: true, deviceCount: 1 }), null);
  assert.equal(connectLanding({ ...base, adding: true, connected: true, deviceCount: 1 }), null);
});

test('a fresh pair lands on Screen when the host can capture', () => {
  assert.equal(postPairDestination(true), '/(tabs)/screen');
});

test('a host with no capture helper lands on System, not a black Screen', () => {
  assert.equal(postPairDestination(false), '/(tabs)/system');
});

test('an older host that reports neither way keeps the old Screen landing', () => {
  // Only an explicit `false` reroutes — an unknown capability must not send a
  // fully working machine to System.
  assert.equal(postPairDestination(undefined), '/(tabs)/screen');
});
