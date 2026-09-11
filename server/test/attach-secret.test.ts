// The credential the desk-side CLI presents, and the narrow door it opens.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  ATTACH_SECRET_HEADER, attachSecretMatches, attachSecretPath, ensureAttachSecret,
  isLoopback, localConsoleDevice, LOCAL_CONSOLE_TOKEN, readAttachSecret,
} from '../src/attach-secret.js';

function scratchHome(): string {
  return mkdtempSync(join(tmpdir(), 'belay-attach-'));
}

test('the secret is minted once and reused', () => {
  const home = scratchHome();
  const first = ensureAttachSecret(home);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(ensureAttachSecret(home), first);
  assert.equal(readAttachSecret(home), first);
});

test('the secret file is only readable by its owner', { skip: process.platform === 'win32' }, () => {
  const home = scratchHome();
  ensureAttachSecret(home);
  assert.equal(statSync(attachSecretPath(home)).mode & 0o777, 0o600);
});

test('a garbage secret file is replaced rather than trusted', () => {
  const home = scratchHome();
  mkdirSync(join(home, '.belay'), { recursive: true });
  writeFileSync(attachSecretPath(home), 'not-a-secret\n');
  assert.equal(readAttachSecret(home), null);
  const minted = ensureAttachSecret(home);
  assert.match(minted, /^[0-9a-f]{64}$/);
  assert.equal(readFileSync(attachSecretPath(home), 'utf8').trim(), minted);
});

test('a missing secret file reads as null, not a throw', () => {
  assert.equal(readAttachSecret(join(tmpdir(), 'belay-does-not-exist-at-all')), null);
});

test('the secret comparison rejects wrong values, wrong lengths and non-strings', () => {
  const secret = 'a'.repeat(64);
  assert.equal(attachSecretMatches(secret, secret), true);
  assert.equal(attachSecretMatches('b'.repeat(64), secret), false);
  assert.equal(attachSecretMatches('a'.repeat(63), secret), false);
  assert.equal(attachSecretMatches(undefined, secret), false);
  assert.equal(attachSecretMatches(['a'.repeat(64)], secret), false);
});

test('the header name is the one the CLI sends', () => {
  assert.equal(ATTACH_SECRET_HEADER, 'x-belay-attach-secret');
});

test('loopback is recognised in every shape node reports it', () => {
  assert.equal(isLoopback('127.0.0.1'), true);
  assert.equal(isLoopback('::1'), true);
  assert.equal(isLoopback('::ffff:127.0.0.1'), true);
  assert.equal(isLoopback('192.168.1.40'), false);
  assert.equal(isLoopback(undefined), false);
});

test('the local-console handle authenticates on the attach route only', () => {
  const device = localConsoleDevice(LOCAL_CONSOLE_TOKEN, '/ws/agent-attach');
  assert.ok(device);
  assert.equal(device.token, LOCAL_CONSOLE_TOKEN);
});

test('the local-console handle is refused on every other websocket route', () => {
  // The whole point of the path gate: a local console may join an agent
  // session and may not reach the screen, the shell, or the cursor channel.
  for (const path of ['/ws/terminal', '/ws/screen', '/ws/agent', '/ws/cursors', '/ws/audio']) {
    assert.equal(localConsoleDevice(LOCAL_CONSOLE_TOKEN, path), undefined, path);
  }
});

test('a wrong or empty token is never the local console', () => {
  assert.equal(localConsoleDevice('', '/ws/agent-attach'), undefined);
  assert.equal(localConsoleDevice('f'.repeat(64), '/ws/agent-attach'), undefined);
  assert.equal(localConsoleDevice(LOCAL_CONSOLE_TOKEN.slice(0, 32), '/ws/agent-attach'), undefined);
});
