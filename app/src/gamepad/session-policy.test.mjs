import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostStatus, reconnectStatus, usesPhysicalController } from './session-policy.ts';

test('phone input works without a native controller and can override connected hardware', () => {
  assert.equal(usesPhysicalController('auto', false), false);
  assert.equal(usesPhysicalController('phone', false), false);
  assert.equal(usesPhysicalController('auto', true), true);
  assert.equal(usesPhysicalController('phone', true), false);
});
test('host failure survives the socket close and retries without blaming Bluetooth', () => {
  const reason = hostStatus({ type: 'hello', backend: 'unavailable', available: false, reason: 'Grant Accessibility to the host launcher' });
  assert.equal(reconnectStatus(reason, 'Gamepad unavailable'), 'Grant Accessibility to the host launcher · Retrying connection');
  assert.equal(reconnectStatus(reason), reconnectStatus(reason, 'Gamepad unavailable'));
  assert.equal(reconnectStatus(null, 'Controller busy'), 'Controller busy · Retrying connection');
  assert.equal(reconnectStatus(null), 'Reconnecting to the computer…');
});
test('keyboard fallback is a ready backend, even with no virtual Xbox device', () => {
  assert.equal(hostStatus({ type: 'hello', backend: 'keymap', available: true }), 'Connected · Keyboard and mouse controls');
  assert.equal(hostStatus({ type: 'hello', backend: 'vigem', available: true }), 'Connected · Xbox game input');
});
