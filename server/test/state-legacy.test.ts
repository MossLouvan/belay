// The pre-rename `tether-state.json` fallback: a host that last ran as Tether
// keeps every pairing, and its raw tokens are hashed on the way into the new
// file. Runs with the default (cwd-based) location, so it chdirs into a temp
// dir before the module reads process.cwd().

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'belay-legacy-state-'));
delete process.env.BELAY_STATE_FILE;
delete process.env.TETHER_STATE_FILE;
process.chdir(dir);

const legacyFile = join(dir, 'tether-state.json');
const stateFile = join(dir, 'belay-state.json');
const token = 'd'.repeat(64);
writeFileSync(legacyFile, JSON.stringify({
  version: 1, hostId: 'tether-host', hostName: 'old', label: 'old',
  devices: [{ token, name: 'tether-phone', createdAt: 1, lastSeen: 1 }],
}));

const { loadState, findDevice, getHostId, hashToken } = await import('../src/state.js');

after(() => rmSync(dir, { recursive: true, force: true }));

test('a legacy tether-state.json is read, kept, and promoted with hashed tokens', () => {
  loadState();
  assert.equal(getHostId(), 'tether-host');
  assert.equal(findDevice(token)?.name, 'tether-phone', 'the old pairing still authenticates');
  assert.ok(existsSync(stateFile), 'promoted to the new file name');
  const promoted = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(promoted.devices[0].tokenHash, hashToken(token));
  assert.ok(!readFileSync(stateFile, 'utf8').includes(token), 'no raw token in the new file');
  // The old file is never written or deleted: an old binary may still use it.
  assert.ok(existsSync(legacyFile));
  assert.ok(readFileSync(legacyFile, 'utf8').includes(token));
});
