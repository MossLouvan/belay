// The device token encrypted at rest with a mocked Electron safeStorage.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrateLegacySession, readSession, sessionPath, writeSession } from '../src/session.js';

/** safeStorage stand-in: reversible, and visibly not the plaintext. */
function fakeVault({ available = true, failDecrypt = false } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (text) => Buffer.from(`sealed:${[...text].reverse().join('')}`),
    decryptString: (buf) => {
      if (failDecrypt) throw new Error('keychain says no');
      const raw = buf.toString();
      assert.ok(raw.startsWith('sealed:'));
      return [...raw.slice('sealed:'.length)].reverse().join('');
    },
  };
}

const tmp = () => mkdtempSync(join(tmpdir(), 'belay-vault-'));
const onDisk = (dir) => JSON.parse(readFileSync(sessionPath(dir), 'utf8'));
const SESSION = { host: 'http://192.168.1.20:8787', token: 'secret-token', label: 'PC', platform: 'darwin', keymap: 'verbatim', fingerprint: '', deviceId: '', secret: '' };

test('a written token is sealed on disk and reads back in the clear', () => {
  const dir = tmp();
  writeSession(dir, SESSION, fakeVault());
  const raw = readFileSync(sessionPath(dir), 'utf8');
  assert.ok(!raw.includes('secret-token'));
  assert.equal(onDisk(dir).token, '');
  assert.ok(onDisk(dir).tokenEnc);
  assert.deepEqual(readSession(dir, fakeVault()), SESSION);
});

test('a plaintext session from an older build is re-sealed on first read', () => {
  const dir = tmp();
  writeFileSync(sessionPath(dir), JSON.stringify(SESSION));
  assert.deepEqual(readSession(dir, fakeVault()), SESSION, 'still paired');
  assert.ok(!readFileSync(sessionPath(dir), 'utf8').includes('secret-token'));
  assert.ok(onDisk(dir).tokenEnc);
  assert.deepEqual(readSession(dir, fakeVault()), SESSION, 'and stays paired');
});

test('without encryption the session stays plaintext, with a warning, and is never lost', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const dir = tmp();
  writeSession(dir, SESSION, fakeVault({ available: false }));
  assert.equal(onDisk(dir).token, 'secret-token');
  assert.equal(onDisk(dir).tokenEnc, undefined);
  assert.deepEqual(readSession(dir, fakeVault({ available: false })), SESSION);
  assert.ok(warn.mock.callCount() > 0);
});

test('a token that cannot be decrypted reads as not paired, without throwing or rewriting', (t) => {
  t.mock.method(console, 'warn', () => {});
  const dir = tmp();
  writeSession(dir, SESSION, fakeVault());
  const before = readFileSync(sessionPath(dir), 'utf8');
  const read = readSession(dir, fakeVault({ failDecrypt: true }));
  assert.equal(read.token, '');
  assert.equal(read.host, SESSION.host);
  assert.equal(readFileSync(sessionPath(dir), 'utf8'), before);
});

test('legacy migration seals the new copy and leaves the old build its plaintext file', () => {
  const legacy = tmp();
  const current = tmp();
  writeSession(legacy, SESSION);
  assert.equal(migrateLegacySession(current, legacy, fakeVault()), true);
  assert.ok(onDisk(current).tokenEnc);
  assert.equal(onDisk(legacy).token, 'secret-token');
  assert.equal(readSession(current, fakeVault()).token, 'secret-token');
});

test('re-saving a sealed session with a new token drops the stale ciphertext', (t) => {
  t.mock.method(console, 'warn', () => {});
  const dir = tmp();
  writeSession(dir, SESSION, fakeVault());
  writeSession(dir, { ...SESSION, token: 'other', tokenEnc: 'stale' }, fakeVault({ available: false }));
  assert.equal(onDisk(dir).tokenEnc, undefined);
  assert.equal(readSession(dir).token, 'other');
});

test('the host-proof secret is sealed like the token and reads back in the clear', () => {
  const dir = mkdtempSync(join(tmpdir(), 'belay-vault-'));
  const paired = { ...SESSION, fingerprint: 'ab'.repeat(32), deviceId: 'dev1', secret: 'proof-secret' };
  writeSession(dir, paired, fakeVault());
  const onDisk = JSON.parse(readFileSync(sessionPath(dir), 'utf8'));
  assert.equal(onDisk.secret, '', 'the secret must not sit in plaintext');
  assert.ok(onDisk.secretEnc, 'sealed under secretEnc');
  assert.equal(onDisk.fingerprint, 'ab'.repeat(32), 'the fingerprint is public and stays readable');
  assert.deepEqual(readSession(dir, fakeVault()), paired);
});
