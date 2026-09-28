// The self-signed certificate the LAN clients pin (tls-cert.ts).
//
// The encoder is hand-rolled, so the test that matters is the one that runs
// it through an independent parser: Node's X509Certificate, which also
// verifies the signature with the certificate's own key.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:tls';
import { createServer } from 'node:https';

import {
  ensureTlsIdentity, selfSignedCertificate, fingerprintOf, displayFingerprint, TLS_CERT_FILE, TLS_KEY_FILE,
} from '../src/tls-cert.js';

const dir = mkdtempSync(join(tmpdir(), 'belay-tls-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('the encoded certificate parses and is self-signed', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const cert = new X509Certificate(selfSignedCertificate(privateKey, new Date('2026-09-27T00:00:00Z')));
  assert.equal(cert.subject, 'CN=Belay host');
  assert.equal(cert.issuer, cert.subject);
  assert.ok(cert.verify(publicKey), 'signature must verify with the key that made it');
  assert.ok(cert.checkIssued(cert));
  assert.equal(new Date(cert.validFrom).toISOString(), '2026-09-27T00:00:00.000Z');
  assert.equal(new Date(cert.validTo).getUTCFullYear(), 2036);
});

test('the identity is minted once, kept 0600, and stable across loads', () => {
  const quiet = () => {};
  const first = ensureTlsIdentity(dir, quiet);
  const second = ensureTlsIdentity(dir, quiet);
  assert.equal(second.fingerprint, first.fingerprint, 'a new fingerprint would un-pair every device');
  assert.match(first.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(fingerprintOf(first.cert), first.fingerprint);
  for (const f of [TLS_KEY_FILE, TLS_CERT_FILE]) {
    assert.equal(statSync(join(dir, f)).mode & 0o777, 0o600, `${f} must be owner-only`);
  }
});

test('the fingerprint is what a TLS client sees on the wire', async () => {
  const identity = ensureTlsIdentity(dir, () => {});
  const server = createServer({ key: identity.key, cert: identity.cert }, (_req, res) => res.end('ok'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const seen = await new Promise<string>((resolve, reject) => {
    const socket = connect({ port, host: '127.0.0.1', rejectUnauthorized: false }, () => {
      resolve(socket.getPeerCertificate().fingerprint256);
      socket.end();
    });
    socket.on('error', reject);
  });
  server.close();
  assert.equal(seen.replace(/:/g, '').toLowerCase(), identity.fingerprint);
});

test('the display form is eight groups a person can compare', () => {
  const shown = displayFingerprint('0123456789abcdef'.repeat(4));
  assert.equal(shown, '01234567 89ABCDEF 01234567 89ABCDEF 01234567 89ABCDEF 01234567 89ABCDEF');
});
