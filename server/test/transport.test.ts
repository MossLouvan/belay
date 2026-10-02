// Transport policy (transport.ts): plaintext only where the link is private,
// and one port that serves both TLS and plain HTTP.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttp, get as httpGet } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { createServer as createHttps, get as httpsGet } from 'node:https';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createPolyglotServer, isLoopback, plaintextAllowed, transportAllowed, PLAINTEXT_REFUSED, PLAINTEXT_REFUSED_STATUS,
} from '../src/transport.js';
import { ensureTlsIdentity } from '../src/tls-cert.js';

test('plaintext is allowed from this computer and from tailnet peers only', () => {
  assert.equal(plaintextAllowed('127.0.0.1'), true);
  assert.equal(plaintextAllowed('::ffff:127.0.0.1'), true);
  assert.equal(plaintextAllowed('::1'), true);
  assert.equal(plaintextAllowed('100.101.102.103'), true, 'Tailscale CGNAT range');
  assert.equal(plaintextAllowed('::ffff:100.64.0.9'), true);
  // The finding: the LAN.
  assert.equal(plaintextAllowed('192.168.1.20'), false);
  assert.equal(plaintextAllowed('10.0.0.5'), false);
  assert.equal(plaintextAllowed('172.16.4.2'), false);
  assert.equal(plaintextAllowed(undefined), false);
  assert.equal(isLoopback('127.9.9.9'), true);
});

test('an encrypted socket is allowed from anywhere; a plain LAN socket is not', () => {
  assert.equal(transportAllowed({ encrypted: true, remoteAddress: '192.168.1.20' }), true);
  assert.equal(transportAllowed({ encrypted: false, remoteAddress: '192.168.1.20' }), false);
  assert.equal(transportAllowed({ remoteAddress: '100.100.1.1' }), true);
});

test('the refusal tells the user what to do and carries a stable code', () => {
  assert.equal(PLAINTEXT_REFUSED_STATUS, 426);
  assert.equal(PLAINTEXT_REFUSED.code, 'plaintext-refused');
  assert.match(PLAINTEXT_REFUSED.error, /pair .* again/i);
});

test('one port answers both plain HTTP and HTTPS', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'belay-polyglot-'));
  const tls = ensureTlsIdentity(dir, () => {});
  const handler = (req: IncomingMessage, res: { end: (s: string) => void }) =>
    res.end((req.socket as { encrypted?: boolean }).encrypted ? 'secure' : 'plain');
  const plain = createHttp(handler);
  const secure = createHttps({ key: tls.key, cert: tls.cert }, handler);
  const server = createPolyglotServer(plain, secure);
  // The sniffing listener owns the TCP handle, so the HTTP servers' own
  // noDelay never reaches it: a frame or a click would sit in Nagle's buffer.
  assert.equal((server as { noDelay?: boolean }).noDelay, true);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;

  const body = (res: IncomingMessage) => new Promise<string>((resolve) => {
    let out = ''; res.on('data', (c) => { out += c; }); res.on('end', () => resolve(out));
  });
  const viaPlain = await new Promise<string>((resolve, reject) =>
    httpGet(`http://127.0.0.1:${port}/`, (res) => body(res).then(resolve)).on('error', reject));
  const viaTls = await new Promise<string>((resolve, reject) =>
    httpsGet(`https://127.0.0.1:${port}/`, { rejectUnauthorized: false }, (res) => body(res).then(resolve)).on('error', reject));

  server.close();
  rmSync(dir, { recursive: true, force: true });
  assert.equal(viaPlain, 'plain');
  assert.equal(viaTls, 'secure');
});
