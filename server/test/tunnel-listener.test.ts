// tunnel-listener.ts: tunneled traffic is never loopback.
//
// The sidecar delivers tunnel streams over 127.0.0.1, so without the tagging
// in tunnel-listener.ts every loopback-only route — attach, hooks, the MCP
// approval sidecar, plain HTTP — would be open to anyone the account lets in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect as netConnect } from 'node:net';
import { request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { connect as tlsConnect } from 'node:tls';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

import { createTunnelListener, TUNNEL_REMOTE_ADDRESS } from '../src/tunnel-listener.js';
import { ensureTlsIdentity } from '../src/tls-cert.js';
import { isLoopback as transportLoopback, plaintextAllowed, transportAllowed } from '../src/transport.js';
import { isLoopback as attachLoopback } from '../src/attach-secret.js';
import { couldBeTailnet } from '../src/tailnet.js';
import { normalizeAddress } from '../src/bwp-stream.js';
import { registerAttachRoutes } from '../src/agent-attach.js';
import { registerHookRoutes } from '../src/hooks-routes.js';
import { createHooksStore } from '../src/hooks-store.js';

test('every loopback decision in the host says no to the tunnel address', () => {
  assert.equal(transportLoopback(TUNNEL_REMOTE_ADDRESS), false);
  assert.equal(attachLoopback(TUNNEL_REMOTE_ADDRESS), false);
  assert.equal(plaintextAllowed(TUNNEL_REMOTE_ADDRESS), false);
  assert.equal(couldBeTailnet(TUNNEL_REMOTE_ADDRESS), false);
  assert.equal(transportAllowed({ encrypted: false, remoteAddress: TUNNEL_REMOTE_ADDRESS }), false);
  // Not an address a UDP stream can be aimed at: the streamer refuses it.
  assert.doesNotMatch(normalizeAddress(TUNNEL_REMOTE_ADDRESS) ?? '', /^\d+\.\d+\.\d+\.\d+$|^\[/);
});

interface Harness {
  readonly port: number;
  readonly upgrades: string[];
  close(): void;
}

async function harness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'belay-tunnel-'));
  const tls = ensureTlsIdentity(dir, () => {});
  const app = express();
  app.use(express.json());
  app.get('/whoami', (req, res) => { res.json({ from: req.socket.remoteAddress }); });
  // Mirrors index.ts /agent/approval-request's inline check.
  app.post('/agent/approval-request', (req, res) => {
    const ip = req.socket.remoteAddress || '';
    if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
      res.status(403).json({ allow: false, message: 'loopback only' }); return;
    }
    res.json({ allow: true });
  });
  registerAttachRoutes(app, { issueTicket: () => ({ ticket: 't', expiresInSec: 30 }), secret: 'attach-secret' });
  registerHookRoutes(app, (_req, _res, next) => next(), {
    store: createHooksStore({ newId: () => 'h1' }), secret: 'hook-secret', waitMs: 5000,
    phones: () => 1, isBelaySession: () => false,
  });
  const upgrades: string[] = [];
  const server = createTunnelListener({
    app, tls,
    onUpgrade: (req, socket) => { upgrades.push(String(req.socket.remoteAddress)); socket.destroy(); },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    port, upgrades,
    close: () => { server.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

function viaTls(port: number, method: string, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpsRequest({ host: '127.0.0.1', port, method, path, headers, rejectUnauthorized: false }, (res: IncomingMessage) => {
      let out = ''; res.on('data', (c) => { out += c; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: out }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('plain HTTP through the tunnel is refused before it reaches the app', async () => {
  const h = await harness();
  const raw = await new Promise<string>((resolve, reject) => {
    const s = netConnect(h.port, '127.0.0.1', () => s.write('GET /whoami HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n'));
    let out = ''; s.on('data', (c) => { out += c; }); s.on('end', () => resolve(out)); s.on('error', reject);
  });
  h.close();
  assert.match(raw, /^HTTP\/1\.1 426/);
  assert.match(raw, /"code":"plaintext-refused"/);
});

test('over TLS the tunnel is tagged remote and every loopback-only route refuses it', async () => {
  const h = await harness();
  const who = await viaTls(h.port, 'GET', '/whoami');
  const approval = await viaTls(h.port, 'POST', '/agent/approval-request', { 'content-type': 'application/json' });
  const attach = await viaTls(h.port, 'GET', '/agent/attach/sessions', { 'x-belay-attach-secret': 'attach-secret' });
  const hook = await viaTls(h.port, 'POST', '/hooks/SessionStart', { 'x-belay-hook-secret': 'hook-secret', 'content-type': 'application/json' });
  h.close();
  assert.deepEqual(JSON.parse(who.body), { from: TUNNEL_REMOTE_ADDRESS });
  assert.equal(approval.status, 403, approval.body);
  assert.equal(attach.status, 403, attach.body);
  assert.equal(hook.status, 403, hook.body);
});

test('a WebSocket upgrade through the tunnel reaches onUpgrade tagged remote', async () => {
  const h = await harness();
  await new Promise<void>((resolve, reject) => {
    const s = tlsConnect({ host: '127.0.0.1', port: h.port, rejectUnauthorized: false }, () => {
      s.write('GET /ws/screen HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: x\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    s.on('close', () => resolve()); s.on('error', reject);
  });
  h.close();
  assert.deepEqual(h.upgrades, [TUNNEL_REMOTE_ADDRESS]);
});
