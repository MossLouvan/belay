// The pure HMAC and the host-identity proof built on it.
//
//   cd app && node --test src/devices/proof.test.mjs
//
// hmac.ts is hand-written, so every case is checked against node:crypto, and
// the proof vector is the one server/test/device-proof.test.ts pins.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';

import { hmacSha256, sha256, toHex, utf8 } from './hmac.ts';
import { expectedProof, nonceHex, proofMatches, NONCE_BYTES } from './proof.ts';

const SECRET = 'a3f1'.repeat(16);
const NONCE = '00112233445566778899aabbccddeeff';

test('sha256 matches node:crypto across block boundaries', () => {
  for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
    const message = utf8('x'.repeat(n));
    assert.equal(toHex(sha256(message)), createHash('sha256').update(message).digest('hex'), `length ${n}`);
  }
  assert.equal(toHex(sha256(utf8('abc'))), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('hmacSha256 matches node:crypto, including a key longer than a block', () => {
  for (const key of ['k', 'a3f1'.repeat(16), 'long-key-'.repeat(20)]) {
    for (const msg of ['', 'belay', 'm'.repeat(300)]) {
      const expected = createHmac('sha256', Buffer.from(key, 'utf8')).update(msg).digest('hex');
      assert.equal(toHex(hmacSha256(utf8(key), utf8(msg))), expected);
    }
  }
});

test('the proof is the vector the host pins', () => {
  assert.equal(expectedProof(SECRET, NONCE), 'd9375949afc61f45b92f080ecb7fd9e659a223cff8ccb0408ee1d5d969485635');
});

test('proofMatches accepts the right proof in any case and rejects the rest', () => {
  const proof = expectedProof(SECRET, NONCE);
  assert.equal(proofMatches(SECRET, NONCE, proof.toUpperCase()), true);
  assert.equal(proofMatches(SECRET, NONCE, proof.slice(0, -1) + '0'), false);
  assert.equal(proofMatches(SECRET, 'ff'.repeat(16), proof), false, 'a replayed proof fails a fresh nonce');
  assert.equal(proofMatches(SECRET, NONCE, null), false);
  assert.equal(proofMatches(SECRET, NONCE, undefined), false);
});

test('nonceHex is 16 bytes of lowercase hex from the given source', () => {
  const nonce = nonceHex((n) => new Uint8Array(n).fill(0xab));
  assert.equal(nonce, 'ab'.repeat(NONCE_BYTES));
  assert.throws(() => nonceHex(() => new Uint8Array(3)));
});
