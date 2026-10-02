// State-file location rules (data-dir.ts). The back-compat cases are the ones
// that matter: an upgrade must never move an existing install's state, or
// every paired phone silently appears unpaired.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { dataDir, resolveStateFile } from '../src/data-dir.js';

const mac = { platform: 'darwin' as const, home: '/Users/me', env: {} };
const win = { platform: 'win32' as const, home: 'C:\\Users\\me', env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' } };
const linux = { platform: 'linux' as const, home: '/home/me', env: {} };
const nothing = () => false;

test('data dir per platform', () => {
  assert.equal(dataDir(mac), '/Users/me/Library/Application Support/Belay');
  assert.equal(dataDir(win), join('C:\\Users\\me\\AppData\\Roaming', 'Belay'));
  assert.equal(dataDir({ ...win, env: {} }), join('C:\\Users\\me', 'AppData', 'Roaming', 'Belay'));
  assert.equal(dataDir(linux), '/home/me/.config/belay');
  assert.equal(dataDir({ ...linux, env: { XDG_CONFIG_HOME: '/xdg' } }), '/xdg/belay');
});

test('BELAY_STATE_FILE / TETHER_STATE_FILE wins over everything (the LaunchAgent pins one)', () => {
  const pinned = '/Users/me/projects/belay/server/belay-state.json';
  assert.equal(resolveStateFile(pinned, '/elsewhere', mac, () => true), pinned);
});

test('a state file already in the working directory keeps being used', () => {
  const cwd = '/Users/me/projects/belay/server';
  const exists = (p: string) => p === join(cwd, 'belay-state.json');
  assert.equal(resolveStateFile(undefined, cwd, mac, exists), join(cwd, 'belay-state.json'));
});

test('a legacy tether-state.json in the working directory keeps the cwd location, so state.ts can migrate it', () => {
  const cwd = '/Users/me/projects/belay/server';
  const exists = (p: string) => p === join(cwd, 'tether-state.json');
  assert.equal(resolveStateFile(undefined, cwd, mac, exists), join(cwd, 'belay-state.json'));
});

test('a fresh install goes to the per-user data dir, not process.cwd()', () => {
  assert.equal(
    resolveStateFile(undefined, '/tmp/anywhere', mac, nothing),
    '/Users/me/Library/Application Support/Belay/belay-state.json',
  );
  assert.equal(resolveStateFile(undefined, '/tmp/anywhere', linux, nothing), '/home/me/.config/belay/belay-state.json');
});
