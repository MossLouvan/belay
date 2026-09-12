// Tests for the refresh policy — the answer to "when does this app take a
// picture of my desktop?". Every rule in the module note has a case here.
// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PREVIEW_LIMITS } from './preview-cache.ts';
import { ATTEMPT_COOLDOWN_MS, stillsToFetch } from './preview-plan.ts';

const device = (id, over = {}) => ({
  id,
  label: id,
  platform: 'darwin',
  addresses: [{ kind: 'lan', url: `http://${id}.local:8787` }],
  token: `${id}-token`,
  addedAt: 0,
  ...over,
});

const plan = (over = {}) => stillsToFetch({
  devices: [device('mac'), device('pc')],
  byId: { mac: 'online', pc: 'online' },
  urlById: { mac: 'http://mac.local:8787', pc: 'http://pc.local:8787' },
  attemptedAt: {},
  previewAt: () => null,
  now: 1_000_000,
  ...over,
});

const ids = (result) => result.map((t) => t.device.id);

test('a reachable computer with no picture is worth one capture', () => {
  assert.deepEqual(ids(plan()), ['mac', 'pc']);
});

test('the address the probe just proved is the one used', () => {
  assert.equal(plan()[0].url, 'http://mac.local:8787');
});

test('an offline or still-checking computer is never asked', () => {
  assert.deepEqual(ids(plan({ byId: { mac: 'offline', pc: 'checking' } })), []);
  assert.deepEqual(ids(plan({ byId: {} })), []);
});

test('a computer with no proven address is never asked', () => {
  assert.deepEqual(ids(plan({ urlById: { pc: 'http://pc.local:8787' } })), ['pc']);
});

test('a computer with no token is never asked', () => {
  const devices = [device('mac', { token: '' }), device('pc')];
  assert.deepEqual(ids(plan({ devices })), ['pc']);
});

test('a fresh picture is not re-taken', () => {
  const now = 1_000_000;
  const previewAt = () => now - (PREVIEW_LIMITS.staleAfterMs - 1);
  assert.deepEqual(ids(plan({ now, previewAt })), []);
});

test('a stale picture is worth replacing', () => {
  const now = 1_000_000;
  const previewAt = () => now - PREVIEW_LIMITS.staleAfterMs;
  assert.deepEqual(ids(plan({ now, previewAt })), ['mac', 'pc']);
});

test('a computer asked recently is left alone even with no picture to show', () => {
  // The guard that stops a re-render loop becoming a capture loop: a failed
  // attempt leaves no preview behind, so freshness alone would let it retry
  // on every render.
  const now = 1_000_000;
  const attemptedAt = { mac: now - (ATTEMPT_COOLDOWN_MS - 1), pc: now - ATTEMPT_COOLDOWN_MS };
  assert.deepEqual(ids(plan({ now, attemptedAt })), ['pc']);
});

test('the cooldown window is configurable and respected', () => {
  const now = 1_000_000;
  assert.deepEqual(
    ids(plan({ now, attemptedAt: { mac: now - 500, pc: now - 500 }, cooldownMs: 100 })),
    ['mac', 'pc'],
  );
});

test('no paired computers means no captures', () => {
  assert.deepEqual(ids(plan({ devices: [] })), []);
});
