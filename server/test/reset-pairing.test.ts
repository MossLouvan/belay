// Tests for reopening the pairing window without losing machine identity.
//
// The bug: the app told people to `rm belay-state.json` to get a fresh code.
// That regenerates the host's id — the key the app saves computers on — so the
// phone's saved entry is orphaned and duplicated on the next pair. The fix is a
// `--reset-pairing` boot flag that clears only the devices and keeps identity.
//
//   cd server && npm test

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { wantsPairingReset, RESET_PAIRING_FLAG } from '../src/reset-pairing.js';

const dir = mkdtempSync(join(tmpdir(), 'belay-reset-'));
const stateFile = join(dir, 'belay-state.json');
process.env.BELAY_STATE_FILE = stateFile;

const {
  loadState, addDevice, revokeAll, deviceCount, getHostId, getLabel, setLabel,
} = await import('../src/state.js');

after(() => rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  if (existsSync(stateFile)) rmSync(stateFile);
  loadState();
  revokeAll();
});

// ---- flag parsing --------------------------------------------------------

test('the reset flag is recognised only as an exact argument', () => {
  assert.equal(wantsPairingReset([RESET_PAIRING_FLAG]), true);
  assert.equal(wantsPairingReset(['--port', '8788', RESET_PAIRING_FLAG]), true);
  assert.equal(wantsPairingReset([]), false);
  assert.equal(wantsPairingReset(['--reset-pairing-please']), false);
  assert.equal(wantsPairingReset(['reset-pairing']), false);
});

// ---- the reset keeps identity -------------------------------------------

test('resetting pairing clears devices but keeps hostId and label', () => {
  setLabel('MacBook Air');
  const id = getHostId();
  addDevice('iPhone');
  addDevice('iPad');
  assert.equal(deviceCount(), 2);

  // What the --reset-pairing boot path does.
  revokeAll();

  assert.equal(deviceCount(), 0, 'a fresh code will be issued');
  assert.equal(getHostId(), id, 'identity is preserved — saved computers stay keyed');
  assert.equal(getLabel(), 'MacBook Air', 'a renamed machine keeps its name');
});

test('the kept identity survives a reload after reset', () => {
  setLabel('Studio PC');
  const id = getHostId();
  addDevice('iPhone');
  revokeAll();

  loadState();
  assert.equal(getHostId(), id);
  assert.equal(getLabel(), 'Studio PC');
});
