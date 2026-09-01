// Unit tests for address normalization and session storage.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hostOrigin, socketOrigin, DEFAULT_PORT } from '../src/url.js';
import { readSession, writeSession, clearSession, keymapModeOf, migrateLegacySession, sessionPath } from '../src/session.js';

const EMPTY = { host: '', token: '', label: '', platform: '', keymap: 'remap' };

test('a bare address gets a scheme and the host default port', () => {
  assert.equal(hostOrigin('192.168.1.20'), `http://192.168.1.20:${DEFAULT_PORT}`);
  assert.equal(hostOrigin('  mac.local  '), `http://mac.local:${DEFAULT_PORT}`);
});

test('an explicit port or scheme is kept', () => {
  assert.equal(hostOrigin('192.168.1.20:9000'), 'http://192.168.1.20:9000');
  assert.equal(hostOrigin('http://100.101.2.3:8787/'), 'http://100.101.2.3:8787');
  // A user who put the agent behind TLS must not be downgraded or re-ported.
  assert.equal(hostOrigin('https://deskhandler.example.com'), 'https://deskhandler.example.com');
});

test('rubbish yields null rather than throwing', () => {
  for (const input of ['', '   ', null, undefined, 'http://']) {
    assert.equal(hostOrigin(input), null, `expected null for ${JSON.stringify(input)}`);
  }
});

test('socketOrigin swaps only the scheme', () => {
  assert.equal(socketOrigin('http://192.168.1.20:8787'), 'ws://192.168.1.20:8787');
  assert.equal(socketOrigin('https://deskhandler.example.com'), 'wss://deskhandler.example.com');
});

test('a session round-trips and is written owner-only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deskhandler-desktop-'));
  writeSession(dir, {
    host: 'http://192.168.1.20:8787', token: 'secret', label: 'Moss-PC',
    platform: 'win32', keymap: 'verbatim',
  });
  assert.deepEqual(readSession(dir), {
    host: 'http://192.168.1.20:8787',
    token: 'secret',
    label: 'Moss-PC',
    platform: 'win32',
    keymap: 'verbatim',
  });
  // Advisory on Windows, enforced on POSIX — asserted only where it means
  // something, so the suite does not fail for a platform difference.
  if (process.platform !== 'win32') {
    assert.equal(statSync(sessionPath(dir)).mode & 0o777, 0o600);
  }
});

test('a missing or corrupt session reads as not paired', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deskhandler-desktop-'));
  assert.deepEqual(readSession(dir), EMPTY);
  writeFileSync(sessionPath(dir), '["not", "an", "object"]');
  assert.deepEqual(readSession(dir), EMPTY);
});

test('a session saved before the keymap existed reads with the remap default', () => {
  // The upgrade path: an old session.json has no keymap field, and the user
  // who never chose gets the sane default, not an undefined mode.
  const dir = mkdtempSync(join(tmpdir(), 'deskhandler-desktop-'));
  writeFileSync(sessionPath(dir), JSON.stringify({ host: 'http://h:8787', token: 't', label: 'x' }));
  const session = readSession(dir);
  assert.equal(session.keymap, 'remap');
  assert.equal(session.platform, '');
});

test('keymapModeOf resolves junk to the default, never passes it through', () => {
  assert.equal(keymapModeOf('verbatim'), 'verbatim');
  for (const junk of ['remap', 'REMAP', '', null, undefined, 42, {}]) {
    assert.equal(keymapModeOf(junk), 'remap');
  }
});

test('clearing a session leaves nothing usable behind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deskhandler-desktop-'));
  writeSession(dir, { host: 'http://h:8787', token: 'secret', label: 'x' });
  clearSession(dir);
  assert.deepEqual(readSession(dir), EMPTY);
  assert.ok(!readFileSync(sessionPath(dir), 'utf8').includes('secret'));
});

// ---- legacy userData migration (rename Tether → Deskhandler) --------------

test('a session saved by the pre-rename build is picked up', () => {
  const legacy = mkdtempSync(join(tmpdir(), 'deskhandler-desktop-legacy-'));
  const current = mkdtempSync(join(tmpdir(), 'deskhandler-desktop-new-'));
  writeSession(legacy, { host: 'http://192.168.1.20:8787', token: 'tok', label: 'PC' });
  assert.equal(migrateLegacySession(current, legacy), true);
  assert.equal(readSession(current).token, 'tok');
  // Copied, not moved: an old build may still point at the legacy directory.
  assert.equal(readSession(legacy).token, 'tok');
});

test('an existing current session is never overwritten by migration', () => {
  const legacy = mkdtempSync(join(tmpdir(), 'deskhandler-desktop-legacy-'));
  const current = mkdtempSync(join(tmpdir(), 'deskhandler-desktop-new-'));
  writeSession(legacy, { host: 'http://old:8787', token: 'old' });
  writeSession(current, { host: 'http://new:8787', token: 'new' });
  assert.equal(migrateLegacySession(current, legacy), false);
  assert.equal(readSession(current).token, 'new');
});

test('no legacy session means no migration and no files invented', () => {
  const legacy = mkdtempSync(join(tmpdir(), 'deskhandler-desktop-legacy-'));
  const current = mkdtempSync(join(tmpdir(), 'deskhandler-desktop-new-'));
  assert.equal(migrateLegacySession(current, legacy), false);
  assert.equal(readSession(current).token, '');
});
