// tunnel-listener.ts: tunneled traffic is never loopback, and every phone is
// its own client.
//
// The sidecar delivers tunnel streams over 127.0.0.1, so without the tagging
// in tunnel-listener.ts every loopback-only route — attach, hooks, the MCP
// approval sidecar, plain HTTP — would be open to anyone the account lets in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect as netConnect } from 'node:net';
import type { Socket } from 'node:net';
import { request as httpRequest } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { connect as tlsConnect } from 'node:tls';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

import { createTunnelListener, parseTunnelHeader, tunnelRemoteAddress, TUNNEL_REMOTE_ADDRESS } from '../src/tunnel-listener.js';
import { ensureTlsIdentity } from '../src/tls-cert.js';
import { isLoopback as transportLoopback, plaintextAllowed, transportAllowed } from '../src/transport.js';
import { isLoopback as attachLoopback } from '../src/attach-secret.js';
import { couldBeTailnet } from '../src/tailnet.js';
import { normalizeAddress } from '../src/bwp-stream.js';
import { registerAttachRoutes } from '../src/agent-attach.js';
import { registerHookRoutes } from '../src/hooks-routes.js';
import { createHooksStore } from '../src/hooks-store.js';

const NODE_A = 'ab'.repeat(32);
const NODE_B = 'cd'.repeat(32);
const header = (id: string) => `belay-tunnel/1 ${id}\n`;

test('every loopback decision in the host says no to a tunnel address', () => {
  for (const addr of [tunnelRemoteAddress(NODE_A), TUNNEL_REMOTE_ADDRESS, 'tunnel:127.0.0.1', 'tunnel:::1']) {
    assert.equal(transportLoopback(addr), false, addr);
    assert.equal(attachLoopback(addr), false, addr);
    assert.equal(plaintextAllowed(addr), false, addr);
    assert.equal(couldBeTailnet(addr), false, addr);
    assert.equal(transportAllowed({ encrypted: false, remoteAddress: addr }), false, addr);
    // No UDP address at all: a tunneled client cannot have video aimed at the sidecar.
    assert.equal(normalizeAddress(addr), null, addr);
  }
});

test('the header accepts exactly belay-tunnel/1 + 64 lowercase hex', () => {
  assert.equal(parseTunnelHeader(`belay-tunnel/1 ${NODE_A}`), NODE_A);
  for (const bad of [
    '', 'GET / HTTP/1.1', `belay-tunnel/1 ${NODE_A.toUpperCase()}`, `belay-tunnel/1 ${NODE_A.slice(1)}`,
    `belay-tunnel/1 ${NODE_A}0`, `belay-tunnel/2 ${NODE_A}`, `belay-tunnel/1  ${NODE_A}`, `belay-tunnel/1 ${NODE_A} `,
    `belay-tunnel/1 ${NODE_A}\r`, NODE_A,
  ]) assert.equal(parseTunnelHeader(bad), null, JSON.stringify(bad));
});

interface Harness {
  readonly port: number;
  readonly upgrades: string[];
  close(): void;
}

async function harness(handshakeTimeoutMs?: number): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'belay-tunnel-'));
  const tls = ensureTlsIdentity(dir, () => {});
  const app = express();
  app.use(express.json());
  app.get('/whoami', (req, res) => { res.json({ from: req.socket.remoteAddress, encrypted: (req.socket as { encrypted?: boolean }).encrypted === true }); });
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
    handshakeTimeoutMs,
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    port, upgrades,
    close: () => { server.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

/** Send `preamble` raw and return everything the listener answers until it closes. */
function rawExchange(port: number, preamble: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Half-close after the preamble: a sender that is done writing. Without
    // it a newline-less preamble sits on the listener's header timeout.
    const s = netConnect(port, '127.0.0.1', () => s.end(preamble));
    let out = ''; s.on('data', (c) => { out += c; }); s.on('close', () => resolve(out)); s.on('error', reject);
  });
}

/** A TLS client socket spoken after the sidecar header, as the sidecar would deliver it. */
function tunnelTls(port: number, nodeId: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const raw = netConnect(port, '127.0.0.1', () => {
      raw.write(header(nodeId));
      const tls = tlsConnect({ socket: raw, rejectUnauthorized: false }, () => resolve(tls));
      tls.on('error', reject);
    });
    raw.on('error', reject);
  });
}

async function viaTunnel(port: number, nodeId: string, method: string, path: string, headers: Record<string, string> = {}) {
  const socket = await tunnelTls(port, nodeId);
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest({ createConnection: () => socket, method, path, headers: { host: '127.0.0.1', ...headers } }, (res: IncomingMessage) => {
      let out = ''; res.on('data', (c) => { out += c; }); res.on('end', () => { resolve({ status: res.statusCode ?? 0, body: out }); socket.destroy(); });
    });
    req.on('error', reject);
    req.end();
  });
}

test('without a valid sidecar header the connection is dropped with nothing written', async () => {
  const h = await harness();
  const silent = [
    'GET /whoami HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n',
    '\x16\x03\x01\x00\x05hello',
    header(NODE_A.toUpperCase()),
    header(NODE_A.slice(1)),
    `belay-tunnel/1 ${NODE_A}\r\n`,
    'x'.repeat(200),
  ];
  for (const preamble of silent) assert.equal(await rawExchange(h.port, preamble), '', JSON.stringify(preamble.slice(0, 40)));
  h.close();
});

test('a valid header followed by a stalled handshake is closed on the timeout, not held forever', async () => {
  const h = await harness(200);
  // Header then nothing, and header then the first ClientHello byte only:
  // neither sender half-closes, so only the listener's own timer can end it.
  for (const preamble of [header(NODE_A), `${header(NODE_A)}\x16`]) {
    const t0 = Date.now();
    await new Promise<void>((resolve, reject) => {
      const s = netConnect(h.port, '127.0.0.1', () => s.write(preamble));
      s.on('close', () => resolve()); s.on('error', reject);
    });
    assert.ok(Date.now() - t0 < 2000, `closed by the timeout: ${JSON.stringify(preamble)}`);
  }
  // A completed handshake is not timed out afterwards.
  const socket = await tunnelTls(h.port, NODE_A);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(socket.destroyed, false, 'established connections outlive the handshake timer');
  socket.destroy();
  h.close();
});

test('plain HTTP after a valid header is refused before it reaches the app', async () => {
  const h = await harness();
  const raw = await rawExchange(h.port, `${header(NODE_A)}GET /whoami HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`);
  h.close();
  assert.match(raw, /^HTTP\/1\.1 426/);
  assert.match(raw, /"code":"plaintext-refused"/);
});

test('over TLS each phone is tagged tunnel:<its node id> and every loopback-only route refuses it', async () => {
  const h = await harness();
  const [whoA, whoB] = await Promise.all([viaTunnel(h.port, NODE_A, 'GET', '/whoami'), viaTunnel(h.port, NODE_B, 'GET', '/whoami')]);
  const approval = await viaTunnel(h.port, NODE_A, 'POST', '/agent/approval-request', { 'content-type': 'application/json' });
  const attach = await viaTunnel(h.port, NODE_A, 'GET', '/agent/attach/sessions', { 'x-belay-attach-secret': 'attach-secret' });
  const hook = await viaTunnel(h.port, NODE_A, 'POST', '/hooks/SessionStart', { 'x-belay-hook-secret': 'hook-secret', 'content-type': 'application/json' });
  h.close();
  assert.deepEqual(JSON.parse(whoA.body), { from: tunnelRemoteAddress(NODE_A), encrypted: true });
  assert.deepEqual(JSON.parse(whoB.body), { from: tunnelRemoteAddress(NODE_B), encrypted: true });
  assert.equal(approval.status, 403, approval.body);
  assert.equal(attach.status, 403, attach.body);
  assert.equal(hook.status, 403, hook.body);
});

test('a WebSocket upgrade through the tunnel reaches onUpgrade tagged with the node id', async () => {
  const h = await harness();
  const s = await tunnelTls(h.port, NODE_B);
  await new Promise<void>((resolve, reject) => {
    s.on('close', () => resolve()); s.on('error', reject);
    s.write('GET /ws/screen HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: x\r\nSec-WebSocket-Version: 13\r\n\r\n');
  });
  h.close();
  assert.deepEqual(h.upgrades, [tunnelRemoteAddress(NODE_B)]);
});
