// The trust decision made before a bearer token leaves the phone.
//
//   cd app && node --test src/devices/verify-host.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { expectedProof } from './proof.ts';
import { hasProofSecret, isPrivateLink, verifyHost } from './verify-host.ts';

const SECRET = 'a3f1'.repeat(16);
const FP = '0123456789abcdef'.repeat(4);
const paired = { id: 'mac-uuid', deviceId: 'dev1', secret: SECRET, fingerprint: FP };
const legacy = { id: 'mac-uuid' };
const bytes = (n) => new Uint8Array(n).fill(7);

/** A host that knows the secret answers correctly; anything else is an impostor. */
const genuine = async (_url, _deviceId, nonce) => expectedProof(SECRET, nonce);
const impostor = async () => 'not-the-proof';
const silent = async () => null;

test('a paired device connects when the host proves the secret', async () => {
  assert.deepEqual(await verifyHost({ device: paired, url: 'https://192.168.1.5:8787', reportedHostId: 'mac-uuid' }, genuine, bytes), { ok: true, adoptId: undefined });
  assert.deepEqual(await verifyHost({ device: paired, url: 'http://100.101.1.1:8787', reportedHostId: 'mac-uuid' }, genuine, bytes), { ok: true, adoptId: undefined });
});

test('a wrong or missing proof is an identity failure even when the host id matches', async () => {
  // HIGH-2: the id is public; a stranger on another network can echo it.
  const input = { device: paired, url: 'http://100.101.1.1:8787', reportedHostId: 'mac-uuid' };
  assert.deepEqual(await verifyHost(input, impostor, bytes), { ok: false, problem: 'identity' });
  assert.deepEqual(await verifyHost(input, silent, bytes), { ok: false, problem: 'identity' });
});

test('no reported host id is a mismatch — never a pass', async () => {
  let asked = false;
  const spy = async (...args) => { asked = true; return genuine(...args); };
  const verdict = await verifyHost({ device: paired, url: 'https://192.168.1.5:8787', reportedHostId: undefined }, spy, bytes);
  assert.deepEqual(verdict, { ok: false, problem: 'identity' });
  assert.equal(asked, false, 'an unverifiable host is not even challenged');
});

test('a different host id is a mismatch before any challenge', async () => {
  const verdict = await verifyHost({ device: paired, url: 'https://192.168.1.5:8787', reportedHostId: 'other' }, genuine, bytes);
  assert.deepEqual(verdict, { ok: false, problem: 'identity' });
});

test('a pre-TLS pairing still works over Tailscale and loopback, and must re-pair on the LAN', async () => {
  assert.deepEqual(await verifyHost({ device: legacy, url: 'http://100.101.1.1:8787', reportedHostId: 'mac-uuid' }, silent, bytes), { ok: true, adoptId: undefined });
  assert.deepEqual(await verifyHost({ device: legacy, url: 'http://127.0.0.1:8787', reportedHostId: 'mac-uuid' }, silent, bytes), { ok: true, adoptId: undefined });
  assert.deepEqual(await verifyHost({ device: legacy, url: 'http://192.168.1.5:8787', reportedHostId: 'mac-uuid' }, silent, bytes), { ok: false, problem: 'needs-repair' });
  // An https address with nothing pinned cannot have been checked.
  assert.deepEqual(await verifyHost({ device: legacy, url: 'https://192.168.1.5:8787', reportedHostId: 'mac-uuid' }, silent, bytes), { ok: false, problem: 'needs-repair' });
});

test('a migrated legacy entry adopts the real id once the host proves itself', async () => {
  const device = { id: 'legacy:http://10.0.0.5:8787', deviceId: 'dev1', secret: SECRET, fingerprint: FP };
  const verdict = await verifyHost({ device, url: 'https://10.0.0.5:8787', reportedHostId: 'real-uuid' }, genuine, bytes);
  assert.deepEqual(verdict, { ok: true, adoptId: 'real-uuid' });
});

test('private links are loopback and Tailscale only', () => {
  assert.equal(isPrivateLink('http://127.0.0.1:8787'), true);
  assert.equal(isPrivateLink('http://localhost:8787'), true);
  assert.equal(isPrivateLink('http://100.64.0.1:8787'), true);
  assert.equal(isPrivateLink('http://100.127.255.254:8787'), true);
  assert.equal(isPrivateLink('http://my-mac.tail1234.ts.net:8787'), true);
  assert.equal(isPrivateLink('http://100.128.0.1:8787'), false, 'just outside the CGNAT range');
  assert.equal(isPrivateLink('http://192.168.1.5:8787'), false);
  assert.equal(isPrivateLink('nonsense'), false);
});

test('hasProofSecret needs both halves', () => {
  assert.equal(hasProofSecret(paired), true);
  assert.equal(hasProofSecret({ id: 'x', deviceId: 'd' }), false);
  assert.equal(hasProofSecret({ id: 'x', secret: 's' }), false);
});

// Item 11 (cut-latency): the TLS pin already proves the peer holds the host's
// private key, so the HMAC round trip is skipped ONLY when the link is https,
// not Tailscale/loopback, and the caller attests the native layer enforced
// the pin for this host:port. Everything else still challenges.
test('a natively pinned https link skips the challenge', async () => {
  let asked = false;
  const spy = async (...args) => { asked = true; return genuine(...args); };
  const verdict = await verifyHost(
    { device: paired, url: 'https://192.168.1.5:8787', reportedHostId: 'mac-uuid', pinEnforced: true },
    spy, bytes,
  );
  assert.deepEqual(verdict, { ok: true, adoptId: undefined });
  assert.equal(asked, false, 'no /challenge round trip');
});

test('plain http, Tailscale, and an unenforced pin all keep the challenge', async () => {
  const cases = [
    { url: 'http://100.101.1.1:8787', pinEnforced: true },
    { url: 'https://mac.tail1234.ts.net:8787', pinEnforced: true },
    { url: 'https://192.168.1.5:8787', pinEnforced: false },
    { url: 'https://192.168.1.5:8787' },
  ];
  for (const c of cases) {
    let asked = false;
    const spy = async (...args) => { asked = true; return genuine(...args); };
    const ok = await verifyHost({ device: paired, reportedHostId: 'mac-uuid', ...c }, spy, bytes);
    assert.deepEqual(ok, { ok: true, adoptId: undefined }, c.url);
    assert.equal(asked, true, `${c.url} must still challenge`);
    const bad = await verifyHost({ device: paired, reportedHostId: 'mac-uuid', ...c }, impostor, bytes);
    assert.deepEqual(bad, { ok: false, problem: 'identity' }, c.url);
  }
});

// The tunnel: the app talks to https://127.0.0.1:<port>, a loopback address
// that is NOT a private link in the Tailscale sense — the bytes leave the
// phone, and the native pin layer enforces the host's fingerprint for exactly
// that host:port. A pinned loopback https answer therefore proves identity
// just as a pinned LAN one does; an unpinned one still challenges.
test('a natively pinned https loopback (tunnel) address counts as pinned https', async () => {
  let asked = false;
  const spy = async (...args) => { asked = true; return genuine(...args); };
  const verdict = await verifyHost(
    { device: paired, url: 'https://127.0.0.1:5123', reportedHostId: 'mac-uuid', pinEnforced: true },
    spy, bytes,
  );
  assert.deepEqual(verdict, { ok: true, adoptId: undefined });
  assert.equal(asked, false, 'no /challenge round trip through the tunnel');

  const unpinned = await verifyHost(
    { device: paired, url: 'https://127.0.0.1:5123', reportedHostId: 'mac-uuid', pinEnforced: false },
    impostor, bytes,
  );
  assert.deepEqual(unpinned, { ok: false, problem: 'identity' }, 'unpinned loopback https still challenges');
});

test('a mismatched host id still fails on a pinned link, before any challenge', async () => {
  const verdict = await verifyHost(
    { device: paired, url: 'https://192.168.1.5:8787', reportedHostId: 'other', pinEnforced: true },
    genuine, bytes,
  );
  assert.deepEqual(verdict, { ok: false, problem: 'identity' });
});
