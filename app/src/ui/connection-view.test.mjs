// Unit tests for the connection status descriptor.
//
//   cd app && node --test src/ui/connection-view.test.mjs
//
// Pure mapping, no framework — same shape as the other suites here.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { describeConnection } from './connection-view.ts';

test('connected reports good and names the machine', () => {
  const v = describeConnection('connected', 'studio');
  assert.equal(v.status, 'good');
  assert.equal(v.pulse, false);
  assert.equal(v.label, 'Connected · studio');
});

test('connecting pulses in accent and never claims a machine yet', () => {
  const v = describeConnection('connecting', 'studio');
  assert.equal(v.status, 'accent');
  assert.equal(v.pulse, true);
  assert.equal(v.label, 'Connecting…', 'the machine is not confirmed reachable while the race runs');
});

test('unreachable is bad and honest — asleep or off, not "connecting forever"', () => {
  const v = describeConnection('unreachable', 'studio');
  assert.equal(v.status, 'bad');
  assert.equal(v.pulse, false);
  assert.equal(v.label, 'Asleep or off · studio');
});

test('idle is neutral with no machine', () => {
  const v = describeConnection('idle');
  assert.equal(v.status, 'neutral');
  assert.equal(v.pulse, false);
  assert.equal(v.label, 'Not connected');
});

test('an unknown machine drops the suffix rather than printing "undefined"', () => {
  assert.equal(describeConnection('connected').label, 'Connected');
  assert.equal(describeConnection('unreachable').label, 'Asleep or off');
});
