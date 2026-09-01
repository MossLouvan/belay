// Tailnet peer discovery: parsing, the login rule, bounds, and the cache.
// No test here runs the tailscale CLI or opens a socket except the one that
// proves the probe deadline, which talks to a local server that never answers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  parsePeers, parsePeerHealth, probePeerHealth, scanTailnet,
  discoverPeerHosts, resetDiscoveryCache,
} from '../src/discover-hosts.js';
import type { DiscoveryDeps, PeerHealth } from '../src/discover-hosts.js';

// ---- fixtures ------------------------------------------------------------

const OWNER = 'moss@example.com';

function statusJson(peers: object): string {
  return JSON.stringify({
    Self: { UserID: 1 },
    User: { '1': { LoginName: OWNER } },
    Peer: peers,
  });
}

const windowsPeer = {
  HostName: 'DESKTOP-BB4FRER',
  OS: 'windows',
  TailscaleIPs: ['100.82.170.69', 'fd7a:115c:a1e0::1'],
  Online: true,
};

const phonePeer = {
  HostName: 'localhost',
  OS: 'iOS',
  TailscaleIPs: ['100.98.143.59'],
  Online: true,
};

const belayHealth: PeerHealth & { ok: true } = {
  ok: true,
  id: 'pc-uuid',
  label: 'Windows PC',
  platform: 'win32',
  addresses: [
    { kind: 'lan', url: 'http://192.168.1.9:8787' },
    { kind: 'tailscale', url: 'http://100.82.170.69:8787' },
  ],
};

function deps(overrides: Partial<DiscoveryDeps>): DiscoveryDeps {
  return {
    status: async () => statusJson({ k1: windowsPeer, k2: phonePeer }),
    whois: async () => ({ login: OWNER, node: 'peer' }),
    probe: async () => null,
    ...overrides,
  };
}

// ---- parsing -------------------------------------------------------------

test('parsePeers reads hostname, OS, IPv4 and online state', () => {
  const peers = parsePeers(statusJson({ k1: windowsPeer, k2: { ...phonePeer, Online: false } }));
  assert.deepEqual(peers, [
    { hostName: 'DESKTOP-BB4FRER', os: 'windows', ip: '100.82.170.69', online: true },
    { hostName: 'localhost', os: 'iOS', ip: '100.98.143.59', online: false },
  ]);
});

test('parsePeers drops peers with no tailnet IPv4 and survives garbage', () => {
  assert.deepEqual(parsePeers(statusJson({ k1: { HostName: 'v6only', TailscaleIPs: ['fd7a::1'] } })), []);
  assert.deepEqual(parsePeers('not json'), []);
  assert.deepEqual(parsePeers('{}'), []);
});

test('parsePeerHealth accepts a Belay /health and rejects everything else', () => {
  const parsed = parsePeerHealth(belayHealth);
  assert.equal(parsed?.id, 'pc-uuid');
  assert.equal(parsed?.label, 'Windows PC');
  assert.equal(parsed?.addresses.length, 2);
  // Some other service answering the port is not a Belay host: no id, no deal.
  assert.equal(parsePeerHealth({ ok: true, name: 'something-else' }), null);
  assert.equal(parsePeerHealth({ ok: false, id: 'x' }), null);
  assert.equal(parsePeerHealth(null), null);
  assert.equal(parsePeerHealth('ok'), null);
});

test('parsePeerHealth falls back through label → name → id', () => {
  assert.equal(parsePeerHealth({ ok: true, id: 'x', name: 'mac.local' })?.label, 'mac.local');
  assert.equal(parsePeerHealth({ ok: true, id: 'x' })?.label, 'x');
});

// ---- scan branches -------------------------------------------------------

test('a dead CLI reports tailscale:false with what actually failed', async () => {
  const scan = await scanTailnet(8787, deps({ status: async () => null }));
  assert.equal(scan.tailscale, false);
  assert.match(scan.detail ?? '', /not be installed or running/);
  assert.deepEqual(scan.hosts, []);
});

test('a signed-out daemon is not "no peers" — it is its own state', async () => {
  const scan = await scanTailnet(8787, deps({
    status: async () => JSON.stringify({ Self: {}, User: {}, Peer: { k1: windowsPeer } }),
  }));
  assert.equal(scan.tailscale, false);
  assert.match(scan.detail ?? '', /not signed in/);
});

test('a peer running Belay is reported with its identity and addresses', async () => {
  const probed: string[] = [];
  const scan = await scanTailnet(8787, deps({
    probe: async (url) => {
      probed.push(url);
      // Only the PC answers: nothing listens on the phone's port.
      return url.includes('100.82.170.69') ? parsePeerHealth(belayHealth) : null;
    },
  }));
  assert.equal(scan.tailscale, true);
  assert.deepEqual(probed.sort(), ['http://100.82.170.69:8787', 'http://100.98.143.59:8787']);
  assert.equal(scan.hosts.length, 1);
  const host = scan.hosts.find((h) => h.id === 'pc-uuid');
  assert.equal(host?.tailnetName, 'DESKTOP-BB4FRER');
  assert.equal(host?.url, 'http://100.82.170.69:8787');
  assert.equal(host?.addresses.length, 2);
});

test('a foreign-tailnet peer is never probed and never reported', async () => {
  const probed: string[] = [];
  const scan = await scanTailnet(8787, deps({
    whois: async (ip) => ip === '100.82.170.69'
      ? { login: 'stranger@example.com', node: 'shared-node' }
      : { login: OWNER, node: 'phone' },
    probe: async (url) => { probed.push(url); return parsePeerHealth(belayHealth); },
  }));
  // The shared node is excluded even though it would have answered as Belay.
  assert.equal(probed.includes('http://100.82.170.69:8787'), false);
  assert.deepEqual(scan.hosts.map((h) => h.url), ['http://100.98.143.59:8787']);
});

test('a peer whois cannot identify is excluded, not guessed at', async () => {
  const scan = await scanTailnet(8787, deps({ whois: async () => null }));
  assert.deepEqual(scan.ownPeerIps, []);
  assert.deepEqual(scan.hosts, []);
});

test('an offline peer costs nothing — no whois, no probe', async () => {
  const asked: string[] = [];
  await scanTailnet(8787, deps({
    status: async () => statusJson({ k1: { ...windowsPeer, Online: false } }),
    whois: async (ip) => { asked.push(ip); return { login: OWNER, node: 'x' }; },
  }));
  assert.deepEqual(asked, []);
});

test('a tailnet with many peers is capped before any CLI call', async () => {
  const peers: Record<string, object> = {};
  for (let i = 0; i < 60; i += 1) {
    peers[`k${i}`] = { HostName: `n${i}`, OS: 'linux', TailscaleIPs: [`100.64.0.${i + 1}`], Online: true };
  }
  const asked: string[] = [];
  await scanTailnet(8787, deps({
    status: async () => statusJson(peers),
    whois: async (ip) => { asked.push(ip); return null; },
  }));
  assert.ok(asked.length <= 16, `expected at most 16 whois calls, saw ${asked.length}`);
});

// ---- the probe deadline --------------------------------------------------

test('a peer that accepts but never answers is given up on at the deadline', async () => {
  // The one socket in this file: a server that leaves the request hanging.
  const server = createServer(() => { /* never respond */ });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const started = Date.now();
    const result = await probePeerHealth(`http://127.0.0.1:${port}`, 100);
    assert.equal(result, null);
    assert.ok(Date.now() - started < 1000, 'the deadline did not bound the probe');
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test('a closed port resolves to null rather than throwing', async () => {
  // Port 9 (discard) is about as reliably closed as localhost offers.
  assert.equal(await probePeerHealth('http://127.0.0.1:9', 200), null);
});

// ---- the cached, requester-filtered route body ---------------------------

test('the asker is subtracted from both the hosts and the peer count', async () => {
  resetDiscoveryCache();
  const reply = await discoverPeerHosts(8787, '::ffff:100.98.143.59', deps({
    probe: async () => parsePeerHealth(belayHealth),
  }));
  assert.equal(reply.tailscale, true);
  // Two own peers on the tailnet, one of them is the phone doing the asking.
  assert.equal(reply.peers, 1);
  assert.deepEqual(reply.hosts.map((h) => h.id), ['pc-uuid']);
  // The wire shape carries no peer IP field beyond the URLs.
  assert.equal('ip' in (reply.hosts[0] as object), false);
});

test('a second poll inside the cache window does not re-run the scan', async () => {
  resetDiscoveryCache();
  let scans = 0;
  const counted = deps({ status: async () => { scans += 1; return statusJson({ k1: windowsPeer }); } });
  await discoverPeerHosts(8787, undefined, counted);
  await discoverPeerHosts(8787, undefined, counted);
  assert.equal(scans, 1);
  resetDiscoveryCache();
});

test('peers found but none running Belay is reported as exactly that', async () => {
  resetDiscoveryCache();
  const reply = await discoverPeerHosts(8787, undefined, deps({ probe: async () => null }));
  assert.equal(reply.tailscale, true);
  assert.equal(reply.peers, 2);
  assert.deepEqual(reply.hosts, []);
  resetDiscoveryCache();
});
