// Unit tests for the header's one-tap switch target.
//
//   cd app && node --test src/devices/switch-target.test.mjs
//
// Same shape as the other suites here: no framework, plain assertions, only
// JSX-free modules imported.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { quickSwitch, quickSwitchTarget } from './switch-target.ts';

function device(id, label) {
  return {
    id,
    label,
    platform: 'other',
    addresses: [{ kind: 'lan', url: `http://${id}:8787` }],
    token: `${id}-token`,
    addedAt: 1000,
  };
}

const mac = device('mac-uuid', 'MacBook Air');
const pc = device('pc-uuid', 'DESKTOP-BB4FRER');
const third = device('third-uuid', 'Studio Mac');

// ---- target selection ----------------------------------------------------

test('exactly two computers: the target is the other one, both ways round', () => {
  assert.equal(quickSwitchTarget([mac, pc], mac.id), pc);
  assert.equal(quickSwitchTarget([mac, pc], pc.id), mac);
});

test('one computer: nothing to switch to, no shortcut', () => {
  assert.equal(quickSwitchTarget([mac], mac.id), null);
  assert.equal(quickSwitch([mac], mac), null);
});

test('no computers, or no active one: no shortcut', () => {
  assert.equal(quickSwitchTarget([], null), null);
  assert.equal(quickSwitchTarget([mac, pc], null), null);
  assert.equal(quickSwitchTarget([mac, pc], undefined), null);
  assert.equal(quickSwitch([mac, pc], undefined), null);
});

test('three or more computers: "the other one" is ambiguous, fall to the list', () => {
  assert.equal(quickSwitchTarget([mac, pc, third], mac.id), null);
  assert.equal(quickSwitch([mac, pc, third], mac), null);
});

test('an active id that is not one of the two names no destination', () => {
  // Should not happen — parseStore keeps activeId honest — but a guess here
  // would put a wrong name on a session-dropping control.
  assert.equal(quickSwitchTarget([mac, pc], 'ghost-uuid'), null);
});

// ---- the label -----------------------------------------------------------

test('the label names the destination, so the tap is predictable', () => {
  const q = quickSwitch([mac, pc], mac);
  assert.equal(q.text, '⇄ DESKTOP-BB4FRER');
  assert.equal(q.target.id, pc.id);
});

test('the spoken label names the destination and the hint names the cost', () => {
  const q = quickSwitch([mac, pc], pc);
  assert.equal(q.accessibilityLabel, 'Switch to MacBook Air.');
  assert.equal(q.accessibilityHint, 'Disconnects from DESKTOP-BB4FRER.');
});
