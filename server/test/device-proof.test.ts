// The host-identity proof (device-proof.ts). The vector below is shared with
// the app and desktop suites, so the three HMAC implementations cannot drift.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { isValidNonce, proveDevice, proofMatches, PROOF_CONTEXT } from '../src/device-proof.js';

const SECRET = 'a3f1'.repeat(16);
const NONCE = '00112233445566778899aabbccddeeff';

test('the proof is HMAC-SHA256 over the context and nonce, keyed by the secret text', () => {
  const expected = createHmac('sha256', Buffer.from(SECRET, 'utf8')).update(PROOF_CONTEXT + NONCE).digest('hex');
  assert.equal(proveDevice(SECRET, NONCE), expected);
  // Pinned vector — app/src/devices/proof.test.mjs and desktop/test/proof.test.mjs assert the same string.
  assert.equal(proveDevice(SECRET, NONCE), 'd9375949afc61f45b92f080ecb7fd9e659a223cff8ccb0408ee1d5d969485635');
});

test('a different secret or nonce yields a different proof', () => {
  assert.notEqual(proveDevice(SECRET, NONCE), proveDevice('b'.repeat(64), NONCE));
  assert.notEqual(proveDevice(SECRET, NONCE), proveDevice(SECRET, 'ff'.repeat(16)));
});

test('nonce validation refuses anything that is not 16–32 bytes of hex', () => {
  assert.equal(isValidNonce(NONCE), true);
  assert.equal(isValidNonce('ab'.repeat(32)), true);
  assert.equal(isValidNonce('ab'.repeat(15)), false);
  assert.equal(isValidNonce('ab'.repeat(33)), false);
  assert.equal(isValidNonce('zz'.repeat(16)), false);
  assert.equal(isValidNonce(42), false);
});

test('proofMatches is case-insensitive on hex and rejects junk', () => {
  const proof = proveDevice(SECRET, NONCE);
  assert.equal(proofMatches(proof, proof.toUpperCase()), true);
  assert.equal(proofMatches(proof, proof.slice(1)), false);
  assert.equal(proofMatches(proof, undefined), false);
});
