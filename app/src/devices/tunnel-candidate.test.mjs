// The tunnel in the connection race: where `tunnel:<nodeId>` sits among the
// addresses, the pin-before-probe rule for 127.0.0.1:<port>, and what a
// computer paired over the tunnel saves.
//
//   cd app && node --test src/devices/tunnel-candidate.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TUNNEL_PREFIX, isTunnelCandidate, pathLabel, probeViaTunnel, savedOverTunnel, tunnelNodeId, withTunnelCandidate,
} from './tunnel-candidate.ts';
import { raceAddresses } from './race.ts';

const NODE = 'ab'.repeat(32);
const FP = '0123456789abcdef'.repeat(4);
const lan = { kind: 'lan', url: 'https://192.168.1.5:8787' };
const ts = { kind: 'tailscale', url: 'http://100.64.0.2:8787' };
const device = { id: 'mac', label: 'Mac', platform: 'darwin', addresses: [lan, ts], token: 't', fingerprint: FP, nodeId: NODE, addedAt: 0 };

test('the tunnel goes second: the preferred LAN address keeps the head start, nothing waits a long stagger', () => {
  const urls = withTunnelCandidate([lan, ts], device).map((a) => a.url);
  assert.deepEqual(urls, [lan.url, `${TUNNEL_PREFIX}${NODE}`, ts.url]);
});

test('a computer with no addresses races the tunnel alone', () => {
  assert.deepEqual(withTunnelCandidate([], device).map((a) => a.url), [`${TUNNEL_PREFIX}${NODE}`]);
});

test('no tunnel candidate without a node id or a fingerprint (the tunnel is https and must be pinned)', () => {
  assert.deepEqual(withTunnelCandidate([lan], { ...device, nodeId: undefined }), [lan]);
  assert.deepEqual(withTunnelCandidate([lan], { ...device, fingerprint: undefined }), [lan]);
});

test('candidate helpers', () => {
  assert.equal(isTunnelCandidate(`${TUNNEL_PREFIX}${NODE}`), true);
  assert.equal(isTunnelCandidate(lan.url), false);
  assert.equal(tunnelNodeId(`${TUNNEL_PREFIX}${NODE}`), NODE);
  assert.equal(tunnelNodeId('tunnel:zz'), null);
});

test('LAN wins the race when it answers; the tunnel wins when it does not', async () => {
  const candidates = withTunnelCandidate([lan], device);
  const sleep = async () => {};
  const lanUp = async (url) => ({ ok: true, hostId: url === lan.url ? 'mac' : 'via-tunnel' });
  const w1 = await raceAddresses(candidates, lanUp, { sleep, now: () => 0 });
  assert.equal(w1?.url, lan.url);
  const lanDown = async (url) => ({ ok: url !== lan.url, via: 'https://127.0.0.1:5000' });
  const w2 = await raceAddresses(candidates, lanDown, { sleep, now: () => 0 });
  assert.equal(w2?.url, `${TUNNEL_PREFIX}${NODE}`);
  assert.equal(w2?.via, 'https://127.0.0.1:5000', 'the race carries the concrete loopback URL the tunnel answered on');
});

test('the host fingerprint is pinned for 127.0.0.1:<port> before the first probe', async () => {
  const order = [];
  const deps = {
    dial: async (nodeId) => { order.push(`dial ${nodeId}`); return 5123; },
    pin: (urls, fp) => { order.push(`pin ${urls.join(',')} ${fp}`); },
    check: async (url) => { order.push(`probe ${url}`); return { ok: true, id: 'mac' }; },
  };
  const result = await probeViaTunnel(deps, NODE, FP, new AbortController().signal);
  assert.deepEqual(order, [`dial ${NODE}`, `pin https://127.0.0.1:5123 ${FP}`, 'probe https://127.0.0.1:5123']);
  assert.deepEqual(result, { ok: true, hostId: 'mac', via: 'https://127.0.0.1:5123' });
});

test('a failed dial is a dead candidate, not a crash, and nothing is probed', async () => {
  let probed = false;
  const deps = { dial: async () => { throw new Error('offline'); }, pin: () => {}, check: async () => { probed = true; return { ok: true }; } };
  assert.deepEqual(await probeViaTunnel(deps, NODE, FP, new AbortController().signal), { ok: false });
  assert.equal(probed, false);
});

test('a computer paired over the tunnel saves its node id, never the ephemeral loopback port', () => {
  const paired = {
    ...device, nodeId: undefined,
    addresses: [{ kind: 'lan', url: 'https://127.0.0.1:5123' }, lan],
    lastKnownGoodUrl: 'https://127.0.0.1:5123',
  };
  const saved = savedOverTunnel(paired, NODE);
  assert.equal(saved.nodeId, NODE);
  assert.deepEqual(saved.addresses, [lan]);
  assert.equal(saved.lastKnownGoodUrl, `${TUNNEL_PREFIX}${NODE}`);
});

test('the path label', () => {
  assert.equal(pathLabel('wifi'), 'Wi-Fi');
  assert.equal(pathLabel('direct'), 'Direct');
  assert.equal(pathLabel('relay'), 'Relay');
  assert.equal(pathLabel(null), undefined);
});
