import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectLabel, deviceStatus } from './device-status.ts';

test('deviceStatus: a live connection outranks every probe result', () => {
  for (const state of ['online', 'offline', 'checking', undefined]) {
    const s = deviceStatus(state, true);
    assert.equal(s.word, 'Connected');
    assert.equal(s.tone, 'good');
    assert.equal(s.actionable, true);
  }
});

test('deviceStatus: probe results map to one word each', () => {
  assert.equal(deviceStatus('online', false).word, 'Available');
  assert.equal(deviceStatus('offline', false).word, 'Offline');
  assert.equal(deviceStatus('checking', false).word, 'Checking…');
});

test('deviceStatus: an unfinished probe never reads as Offline', () => {
  // The regression this guards: `undefined` falling through to the offline
  // branch made every computer flash "Offline" for the first second.
  assert.equal(deviceStatus(undefined, false).word, 'Checking…');
  assert.equal(deviceStatus(undefined, false).actionable, false);
  assert.equal(deviceStatus('checking', false).actionable, false);
});

test('deviceStatus: only a reachable computer offers an action', () => {
  assert.equal(deviceStatus('online', false).actionable, true);
  assert.equal(deviceStatus('offline', false).actionable, false);
});

test('deviceStatus: returns shared frozen values, so rows can compare by identity', () => {
  assert.equal(deviceStatus('online', false), deviceStatus('online', false));
  assert.equal(Object.isFrozen(deviceStatus('offline', false)), true);
});

test('connectLabel: the connected machine is opened, not connected to', () => {
  assert.equal(connectLabel(false), 'Connect');
  assert.equal(connectLabel(true), 'Open computer');
});
