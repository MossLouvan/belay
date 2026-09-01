// Unit tests for persistent host state.
//
// These run against a real temp file, because the behaviours that matter are
// exactly the ones a pure-function test would miss: atomic replacement, file
// permissions, and what happens when the file on disk is damaged.

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, statSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'belay-state-'));
const stateFile = join(dir, 'belay-state.json');
process.env.BELAY_STATE_FILE = stateFile;

// Imported after the env var is set, since the module reads it at load time.
const {
  loadState, addDevice, findDevice, touchDevice, listDevices, deviceCount,
  revokeDevice, revokeAll, setHostName, getHostName, getHostId, getLabel, setLabel,
  getPlatform,
} = await import('../src/state.js');

after(() => rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  if (existsSync(stateFile)) rmSync(stateFile);
  loadState();
  revokeAll();
});

test('a fresh host gets a stable id', () => {
  const id = getHostId();
  assert.match(id, /^[0-9a-f-]{36}$/, 'a UUID');
  assert.equal(getHostId(), id, 'stable within a run');
});

test('the host id survives a reload', () => {
  setHostName('test-mac');
  const id = getHostId();
  loadState();
  assert.equal(getHostId(), id, 'id must persist — the app keys computers on it');
});

test('a paired device can be found by its token', () => {
  const device = addDevice('iPhone');
  const found = findDevice(device.token);
  assert.equal(found?.name, 'iPhone');
});

test('an unknown token finds nothing', () => {
  addDevice('iPhone');
  assert.equal(findDevice('0'.repeat(64)), undefined);
  assert.equal(findDevice(''), undefined);
});

test('tokens are 256 bits of hex and unique per device', () => {
  const a = addDevice('one');
  const b = addDevice('two');
  assert.match(a.token, /^[0-9a-f]{64}$/);
  assert.notEqual(a.token, b.token);
});

test('listDevices truncates tokens and does not return whole ones', () => {
  const device = addDevice('iPhone');
  const summaries = listDevices();
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].tokenPrefix, device.token.slice(0, 8));
  // The full token must not appear anywhere in the serialised summary.
  assert.ok(!JSON.stringify(summaries).includes(device.token));
});

test('touchDevice does not mutate the device it is given', () => {
  const device = addDevice('iPhone');
  const before = device.lastSeen;
  touchDevice(device);
  assert.equal(device.lastSeen, before, 'the caller\'s object must be untouched');
});

test('revokeDevice removes only the matching device', () => {
  const a = addDevice('phone-a');
  addDevice('phone-b');
  assert.equal(revokeDevice(a.token.slice(0, 8)), true);
  assert.equal(deviceCount(), 1);
  assert.equal(findDevice(a.token), undefined, 'revoked token no longer authenticates');
});

test('revokeDevice reports false when nothing matched', () => {
  addDevice('phone');
  assert.equal(revokeDevice('ffffffff-nope'), false);
  assert.equal(deviceCount(), 1);
});

test('state persists across a reload', () => {
  const device = addDevice('iPhone');
  loadState();
  assert.equal(deviceCount(), 1);
  assert.ok(findDevice(device.token), 'token still authenticates after reload');
});

test('the state file is written owner-only', () => {
  addDevice('iPhone');
  // These are bearer tokens granting full control of the machine; any other
  // local account being able to read them is a total compromise.
  const mode = statSync(stateFile).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
});

test('no temp file is left behind after a save', () => {
  addDevice('iPhone');
  assert.equal(existsSync(`${stateFile}.tmp`), false);
});

test('a corrupt state file is reported and does not throw', () => {
  addDevice('iPhone');
  writeFileSync(stateFile, '{ this is not json', 'utf8');
  assert.doesNotThrow(() => loadState());
  assert.equal(deviceCount(), 0);
});

test('malformed device entries are dropped, valid ones kept', () => {
  // The failure this prevents: a device whose token is not a string made
  // Buffer.from() throw inside auth middleware, so EVERY authed request
  // returned 500 permanently.
  const good = { token: 'a'.repeat(64), name: 'good', createdAt: 1, lastSeen: 1 };
  writeFileSync(stateFile, JSON.stringify({
    version: 1,
    hostId: 'fixed-id',
    hostName: 'h',
    label: 'h',
    devices: [
      good,
      { token: 123, name: 'bad-token-type', createdAt: 1, lastSeen: 1 },
      { name: 'missing-token', createdAt: 1, lastSeen: 1 },
      null,
      'not-an-object',
    ],
  }), 'utf8');

  loadState();
  assert.equal(deviceCount(), 1);
  assert.ok(findDevice(good.token), 'the valid device survived');
});

test('a pre-v1 file without hostId is migrated and keeps its devices', () => {
  const token = 'b'.repeat(64);
  writeFileSync(stateFile, JSON.stringify({
    devices: [{ token, name: 'old-phone', createdAt: 1, lastSeen: 1 }],
    hostName: 'legacy-mac',
  }), 'utf8');

  loadState();
  assert.match(getHostId(), /^[0-9a-f-]{36}$/, 'an id was minted');
  assert.equal(getHostName(), 'legacy-mac');
  assert.equal(getLabel(), 'legacy-mac', 'label defaults to the host name');
  assert.ok(findDevice(token), 'nobody has to re-pair because of the migration');
});

test('label is editable and persists', () => {
  setHostName('Mosss-MacBook-Air.local');
  setLabel('MacBook Air');
  assert.equal(getLabel(), 'MacBook Air');
  loadState();
  assert.equal(getLabel(), 'MacBook Air');
});

test('label falls back to the host name when unset', () => {
  setHostName('some-host');
  assert.equal(getLabel(), 'some-host');
});

test('getPlatform reports a value the app can switch on', () => {
  assert.ok(['darwin', 'win32', 'other'].includes(getPlatform()));
});
