// TURN REST credential minting: pure HMAC logic, pinned against an
// independent computation and against the deployed coturn policy file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  mintTurnCredential,
  verifyTurnCredential,
  TURN_RELAY_POLICY,
  CREDENTIAL_LIMITS,
} from '../src/turn-credentials.js';

const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
const NOW_MS = 1_700_000_000_000;
const now = () => NOW_MS;

test('mints the exact draft-uberti / coturn REST shape', () => {
  const minted = mintTurnCredential({ accountId: 'acct1', sessionId: 'sess1', ttlSec: 300 }, SECRET, now);
  assert.equal(minted.ok, true);
  if (!minted.ok) return;

  const expectedExpiry = Math.floor(NOW_MS / 1000) + 300;
  assert.equal(minted.value.username, `${expectedExpiry}:acct1:sess1`);

  // Independent recomputation of what coturn does with use-auth-secret:
  // base64(HMAC-SHA1(secret, username)).
  const independent = createHmac('sha1', SECRET).update(minted.value.username).digest('base64');
  assert.equal(minted.value.credential, independent);
  assert.equal(minted.value.ttlSec, 300);
  assert.equal(minted.value.expiresAtMs, expectedExpiry * 1000);
});

test('account/session boundary is unambiguous: dotted ids do not collide', () => {
  // idPattern allows '.', so with a '.' separator these two distinct pairs
  // minted byte-identical usernames — one account could spend another's quota
  // and coturn logs mis-attribute the session. The separator must fence them.
  const left = mintTurnCredential({ accountId: 'a.b', sessionId: 'c' }, SECRET, now);
  const right = mintTurnCredential({ accountId: 'a', sessionId: 'b.c' }, SECRET, now);
  assert.equal(left.ok && right.ok, true);
  if (!left.ok || !right.ok) return;
  assert.notEqual(left.value.username, right.value.username);
  // And the distinct usernames yield distinct credentials (HMAC over username).
  assert.notEqual(left.value.credential, right.value.credential);
});

test('mint → verify round trip; verify is coturn-equivalent', () => {
  const minted = mintTurnCredential({ accountId: 'a', sessionId: 's' }, SECRET, now);
  assert.equal(minted.ok, true);
  if (!minted.ok) return;
  assert.equal(verifyTurnCredential(minted.value.username, minted.value.credential, SECRET, now).ok, true);
});

test('sha256 option produces a distinct, verifiable credential', () => {
  const minted = mintTurnCredential({ accountId: 'a', sessionId: 's', algorithm: 'sha256' }, SECRET, now);
  assert.equal(minted.ok, true);
  if (!minted.ok) return;
  const independent = createHmac('sha256', SECRET).update(minted.value.username).digest('base64');
  assert.equal(minted.value.credential, independent);
  assert.equal(verifyTurnCredential(minted.value.username, minted.value.credential, SECRET, now, 'sha256').ok, true);
  assert.equal(verifyTurnCredential(minted.value.username, minted.value.credential, SECRET, now, 'sha1').ok, false);
});

test('credentials expire exactly at the embedded timestamp', () => {
  const minted = mintTurnCredential({ accountId: 'a', sessionId: 's', ttlSec: 60 }, SECRET, now);
  assert.equal(minted.ok, true);
  if (!minted.ok) return;
  const { username, credential, expiresAtMs } = minted.value;
  assert.equal(verifyTurnCredential(username, credential, SECRET, () => expiresAtMs - 1).ok, true);
  assert.equal(verifyTurnCredential(username, credential, SECRET, () => expiresAtMs).ok, false);
});

test('ttl is clamped to [min, max] and defaulted', () => {
  const short = mintTurnCredential({ accountId: 'a', sessionId: 's', ttlSec: 1 }, SECRET, now);
  const long = mintTurnCredential({ accountId: 'a', sessionId: 's', ttlSec: 999_999 }, SECRET, now);
  const dflt = mintTurnCredential({ accountId: 'a', sessionId: 's' }, SECRET, now);
  assert.equal(short.ok && short.value.ttlSec === CREDENTIAL_LIMITS.minTtlSec, true);
  assert.equal(long.ok && long.value.ttlSec === CREDENTIAL_LIMITS.maxTtlSec, true);
  assert.equal(dflt.ok && dflt.value.ttlSec === CREDENTIAL_LIMITS.defaultTtlSec, true);
});

test('rejects hostile or malformed ids and weak secrets', () => {
  assert.equal(mintTurnCredential({ accountId: 'a:b', sessionId: 's' }, SECRET, now).ok, false);
  assert.equal(mintTurnCredential({ accountId: '', sessionId: 's' }, SECRET, now).ok, false);
  assert.equal(mintTurnCredential({ accountId: 'a'.repeat(129), sessionId: 's' }, SECRET, now).ok, false);
  assert.equal(mintTurnCredential({ accountId: 'a', sessionId: 'x y' }, SECRET, now).ok, false);
  assert.equal(mintTurnCredential({ accountId: 'a', sessionId: 's' }, 'short', now).ok, false);
  assert.equal(
    mintTurnCredential({ accountId: 'a', sessionId: 's', ttlSec: Number.NaN }, SECRET, now).ok,
    false,
  );
});

test('a tampered username or credential never verifies', () => {
  const minted = mintTurnCredential({ accountId: 'acct', sessionId: 'sess', ttlSec: 300 }, SECRET, now);
  assert.equal(minted.ok, true);
  if (!minted.ok) return;
  const { username, credential } = minted.value;

  // Extend own expiry: recompute of HMAC fails.
  const laterExpiry = username.replace(/^\d+/, String(Math.floor(NOW_MS / 1000) + 9999));
  assert.equal(verifyTurnCredential(laterExpiry, credential, SECRET, now).ok, false);
  // Wrong account.
  assert.equal(verifyTurnCredential(username.replace('acct', 'evil'), credential, SECRET, now).ok, false);
  // Flipped credential byte.
  const flipped = (credential[0] === 'A' ? 'B' : 'A') + credential.slice(1);
  assert.equal(verifyTurnCredential(username, flipped, SECRET, now).ok, false);
  // Wrong secret.
  assert.equal(verifyTurnCredential(username, credential, SECRET + 'x', now).ok, false);
  // Garbage.
  assert.equal(verifyTurnCredential('no-expiry', credential, SECRET, now).ok, false);
});

test('deployed coturn policy matches TURN_RELAY_POLICY (no silent drift)', () => {
  const confPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'turn', 'turnserver.conf');
  const conf = readFileSync(confPath, 'utf8');
  const numberOf = (key: string): number => {
    const m = conf.match(new RegExp(`^${key}=(\\d+)$`, 'm'));
    assert.ok(m, `turnserver.conf is missing ${key}=`);
    return Number(m![1]);
  };
  assert.equal(numberOf('max-bps'), TURN_RELAY_POLICY.maxBpsPerSession);
  assert.equal(numberOf('user-quota'), TURN_RELAY_POLICY.userQuota);
  assert.equal(numberOf('total-quota'), TURN_RELAY_POLICY.totalQuota);
  // The REST scheme itself must be on, or minted credentials are meaningless.
  assert.match(conf, /^use-auth-secret$/m);
});
