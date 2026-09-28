// The desktop's host-identity proof and certificate pins.
//
//   cd desktop && node --test test/proof.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto, generateKeyPairSync, X509Certificate } from 'node:crypto';
import { createServer } from 'node:https';

import { expectedProof, freshNonce, normalizeFingerprint, plaintextOk, proofMatches, displayFingerprint } from '../src/proof.js';
import { createPinStore, fingerprintOfPem, probeFingerprint, VERDICT } from '../src/pins.js';

const SECRET = 'a3f1'.repeat(16);
const NONCE = '00112233445566778899aabbccddeeff';

test('the proof is the vector the host and the phone pin', async () => {
  assert.equal(await expectedProof(SECRET, NONCE, webcrypto), 'd9375949afc61f45b92f080ecb7fd9e659a223cff8ccb0408ee1d5d969485635');
});

test('proofMatches rejects a wrong, replayed or missing proof', async () => {
  const proof = await expectedProof(SECRET, NONCE, webcrypto);
  assert.equal(await proofMatches(SECRET, NONCE, proof.toUpperCase(), webcrypto), true);
  assert.equal(await proofMatches(SECRET, 'ff'.repeat(16), proof, webcrypto), false);
  assert.equal(await proofMatches(SECRET, NONCE, undefined, webcrypto), false);
  assert.match(freshNonce(webcrypto), /^[0-9a-f]{32}$/);
});

test('plaintext is acceptable only to this machine and tailnet peers', () => {
  assert.equal(plaintextOk('http://127.0.0.1:8787'), true);
  assert.equal(plaintextOk('http://100.101.2.3:8787'), true);
  assert.equal(plaintextOk('http://pc.tail1234.ts.net:8787'), true);
  assert.equal(plaintextOk('http://192.168.1.20:8787'), false);
});

test('fingerprints normalise from any spelling and display in eight groups', () => {
  const fp = '0123456789abcdef'.repeat(4);
  assert.equal(normalizeFingerprint(fp.toUpperCase().match(/.{2}/g).join(':')), fp);
  assert.equal(normalizeFingerprint('abc'), null);
  assert.equal(displayFingerprint(fp).split(' ').length, 8);
});

/** A throwaway self-signed certificate, via the host's own encoder. */
async function selfSigned() {
  const { selfSignedCertificate } = await import('../../server/src/tls-cert.ts');
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const der = selfSignedCertificate(privateKey);
  const pem = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').replace(/(.{64})/g, '$1\n')}\n-----END CERTIFICATE-----\n`;
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }), pem, fingerprint: new X509Certificate(pem).fingerprint256.replace(/:/g, '').toLowerCase() };
}

test('a pinned origin accepts only the pinned certificate; others fall back to Chromium', async () => {
  const good = await selfSigned();
  const other = await selfSigned();
  const pins = createPinStore();
  pins.pin('https://192.168.1.20:8787', good.fingerprint);
  const request = (cert, port = 8787) => ({ hostname: '192.168.1.20', port, certificate: { data: cert.pem } });
  assert.equal(pins.decide(request(good)), VERDICT.accept);
  assert.equal(pins.decide(request(other)), VERDICT.reject, 'a different certificate for the pinned host is refused');
  assert.equal(pins.decide(request(good, 9999)), VERDICT.chromium, 'another port is not pinned');
  assert.equal(pins.decide({ hostname: 'example.com', port: 443, certificate: { data: good.pem } }), VERDICT.chromium);
  assert.equal(pins.decide({ hostname: '192.168.1.20', port: 8787, certificate: { data: 'garbage' } }), VERDICT.reject);
  assert.equal(fingerprintOfPem(good.pem), good.fingerprint);
});

test('probeFingerprint reports what a live TLS host presents', async () => {
  const id = await selfSigned();
  const server = createServer({ key: id.key, cert: id.pem }, (_req, res) => res.end());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    assert.equal(await probeFingerprint(`https://127.0.0.1:${port}`), id.fingerprint);
    await assert.rejects(probeFingerprint(`http://127.0.0.1:${port}`));
  } finally {
    server.close();
  }
});
