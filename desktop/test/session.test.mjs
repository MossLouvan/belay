// Unit tests for address normalization and session storage.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hostOrigin, socketOrigin, DEFAULT_PORT } from '../src/url.js';
import { readSession, writeSession, clearSession, sessionPath } from '../src/session.js';

test('a bare address gets a scheme and the host default port', () => {
  assert.equal(hostOrigin('192.168.1.20'), `http://192.168.1.20:${DEFAULT_PORT}`);
  assert.equal(hostOrigin('  mac.local  '), `http://mac.local:${DEFAULT_PORT}`);
});

test('an explicit port or scheme is kept', () => {
  assert.equal(hostOrigin('192.168.1.20:9000'), 'http://192.168.1.20:9000');
  assert.equal(hostOrigin('http://100.101.2.3:8787/'), 'http://100.101.2.3:8787');
  // A user who put the agent behind TLS must not be downgraded or re-ported.
  assert.equal(hostOrigin('https://tether.example.com'), 'https://tether.example.com');
});

test('rubbish yields null rather than throwing', () => {
  for (const input of ['', '   ', null, undefined, 'http://']) {
    assert.equal(hostOrigin(input), null, `expected null for ${JSON.stringify(input)}`);
  }
});

test('socketOrigin swaps only the scheme', () => {
  assert.equal(socketOrigin('http://192.168.1.20:8787'), 'ws://192.168.1.20:8787');
  assert.equal(socketOrigin('https://tether.example.com'), 'wss://tether.example.com');
});

test('a session round-trips and is written owner-only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tether-desktop-'));
  writeSession(dir, { host: 'http://192.168.1.20:8787', token: 'secret', label: 'Moss-PC' });
  assert.deepEqual(readSession(dir), {
    host: 'http://192.168.1.20:8787',
    token: 'secret',
    label: 'Moss-PC',
  });
  // Advisory on Windows, enforced on POSIX — asserted only where it means
  // something, so the suite does not fail for a platform difference.
  if (process.platform !== 'win32') {
    assert.equal(statSync(sessionPath(dir)).mode & 0o777, 0o600);
  }
});

test('a missing or corrupt session reads as not paired', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tether-desktop-'));
  assert.deepEqual(readSession(dir), { host: '', token: '', label: '' });
  writeFileSync(sessionPath(dir), '["not", "an", "object"]');
  assert.deepEqual(readSession(dir), { host: '', token: '', label: '' });
});

test('clearing a session leaves nothing usable behind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tether-desktop-'));
  writeSession(dir, { host: 'http://h:8787', token: 'secret', label: 'x' });
  clearSession(dir);
  assert.deepEqual(readSession(dir), { host: '', token: '', label: '' });
  assert.ok(!readFileSync(sessionPath(dir), 'utf8').includes('secret'));
});
