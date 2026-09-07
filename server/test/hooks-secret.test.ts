// Tests for the hook secret file: minted once, 0600, reused, never the
// pairing token. Temp HOME only. Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureHookSecret, hookSecretPath, readHookSecret, secretMatches } from '../src/hooks-secret.js';

const tempHome = () => mkdtempSync(join(tmpdir(), 'belay-secret-'));

test('ensureHookSecret mints a 64-hex secret at ~/.belay/hook-secret with mode 0600 and reuses it', () => {
  const home = tempHome();
  const first = ensureHookSecret(home);
  assert.match(first, /^[0-9a-f]{64}$/);
  const path = hookSecretPath(home);
  assert.equal(readFileSync(path, 'utf8').trim(), first);
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(ensureHookSecret(home), first);
  assert.equal(readHookSecret(home), first);
});

test('a missing or garbage file reads as null and is replaced on ensure', () => {
  const home = tempHome();
  assert.equal(readHookSecret(home), null);
  mkdirSync(join(home, '.belay'));
  writeFileSync(hookSecretPath(home), 'short\n');
  assert.equal(readHookSecret(home), null);
  const minted = ensureHookSecret(home);
  assert.equal(readHookSecret(home), minted);
});

test('secretMatches is exact and tolerates junk', () => {
  const s = 'a'.repeat(64);
  assert.equal(secretMatches(s, s), true);
  assert.equal(secretMatches('a'.repeat(63) + 'b', s), false);
  assert.equal(secretMatches(undefined, s), false);
  assert.equal(secretMatches('', s), false);
  assert.equal(secretMatches(42, s), false);
});
