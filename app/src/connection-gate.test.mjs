import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostSettled } from './connection-gate.ts';

test('#85: a host request waits while the store loads or a connect is racing', () => {
  assert.equal(hostSettled(false, 'idle'), false);
  assert.equal(hostSettled(true, 'connecting'), false);
});

test('#85: it goes out once the attempt has settled, either way', () => {
  assert.equal(hostSettled(true, 'connected'), true);
  assert.equal(hostSettled(true, 'unreachable'), true);
  // No saved computer at all: let the request fail honestly instead of spinning.
  assert.equal(hostSettled(true, 'idle'), true);
});
