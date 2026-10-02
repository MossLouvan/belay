// The first-phone window in host state (state.ts): opened for 15 minutes at
// link time or from Belay.app, closed by the first pairing of any kind, and
// never reopened by revoking phones. Persisted, so a restart does not reopen
// or extend it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'belay-window-'));
process.env.BELAY_STATE_FILE = join(dir, 'state.json');
const state = await import('../src/state.js');
const { FIRST_PHONE_WINDOW_MS } = await import('../src/account-pair.js');

test.after(() => rmSync(dir, { recursive: true, force: true }));

test('a fresh host has no window; opening one lasts 15 minutes', () => {
  state.loadState();
  assert.equal(state.getTrustFirstPhoneUntil(), 0);
  state.openFirstPhoneWindow(1_000);
  assert.equal(state.getTrustFirstPhoneUntil(), 1_000 + FIRST_PHONE_WINDOW_MS);
  assert.equal(FIRST_PHONE_WINDOW_MS, 15 * 60 * 1000);
});

test('the first pairing closes it, and revoking every phone does not reopen it', () => {
  state.loadState();
  state.openFirstPhoneWindow(Date.now());
  const d = state.addDevice('iPhone');
  assert.equal(state.getTrustFirstPhoneUntil(), 0);
  state.revokeDevice(d.tokenHash.slice(0, 8));
  assert.equal(state.deviceCount(), 0);
  assert.equal(state.getTrustFirstPhoneUntil(), 0);
  state.revokeAll();
  assert.equal(state.getTrustFirstPhoneUntil(), 0);
});

test('the window survives a restart as a deadline, not a fresh 15 minutes', () => {
  state.openFirstPhoneWindow(5_000);
  state.loadState();
  assert.equal(state.getTrustFirstPhoneUntil(), 5_000 + FIRST_PHONE_WINDOW_MS);
});
