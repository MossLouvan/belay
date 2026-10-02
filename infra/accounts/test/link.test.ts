// Direct link: a signed-in computer links itself (no QR, no phone).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { claimMessage } from '../src/routes/claims.js';
import { app, claimBody, makeNode, signIn } from './helpers.js';

test('POST /hosts/link mints a host credential once and the host shows up in /devices', async () => {
  const a = app();
  const host = await makeNode();
  const token = await signIn(a);

  assert.equal((await a.call('POST', '/v1/hosts/link', { body: await claimBody(host) })).status, 401);
  const linked = await a.call('POST', '/v1/hosts/link', { token, body: await claimBody(host) });
  assert.equal(linked.status, 200);
  assert.match(linked.body.hostCredential, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(linked.body.linkedBy, 'us***@example.com');
  assert.equal(linked.body.device.kind, 'host');
  assert.equal(linked.body.device.nodeId, host.nodeId);

  const hb = await a.call('POST', '/v1/hosts/heartbeat', { token: linked.body.hostCredential, body: {} });
  assert.equal(hb.status, 200);
  const devices = (await a.call('GET', '/v1/devices', { token })).body.devices;
  assert.deepEqual(devices.map((d: { kind: string; name: string }) => [d.kind, d.name]), [['host', 'Moss MacBook']]);

  const stored = await a.env.DB.prepare('SELECT host_credential_hash FROM devices').first<string>('host_credential_hash');
  assert.notEqual(stored, linked.body.hostCredential);
  assert.match(stored!, /^[0-9a-f]{64}$/);
});

test('link needs proof of possession of the node key', async () => {
  const a = app();
  const host = await makeNode();
  const other = await makeNode();
  const token = await signIn(a);
  const post = (body: Record<string, unknown>) => a.call('POST', '/v1/hosts/link', { token, body });
  const ts = Math.floor(Date.now() / 1000);

  assert.equal((await post({ ...(await claimBody(host)), sig: await other.sign(claimMessage(host.nodeId, ts)), ts })).status, 401);
  assert.equal((await post({ ...(await claimBody(host)), ts: ts - 1 })).status, 401);
  const old = ts - 301;
  assert.equal((await post({ ...(await claimBody(host)), ts: old, sig: await host.sign(claimMessage(host.nodeId, old)) })).status, 401);
  assert.equal((await post({ nodeId: host.nodeId, name: 'x', platform: 'macos' })).body.code, 'bad_request');
  assert.equal((await post(await claimBody(host, { nodeId: host.nodeId.toUpperCase() }))).body.code, 'bad_request');
  assert.equal((await post(await claimBody(host, { name: 'x'.repeat(101) }))).body.code, 'bad_request');
  assert.equal((await post(await claimBody(host, { platform: '' }))).body.code, 'bad_request');
  assert.equal((await a.call('GET', '/v1/devices', { token })).body.devices.length, 0);
});

test('link never silently replaces a live host (409), but replaces a half-linked one', async () => {
  const a = app();
  const host = await makeNode();
  const token = await signIn(a);

  // half-linked via claim accept (never polled) is replaced
  const claim = (await a.call('POST', '/v1/claims', { body: await claimBody(host) })).body;
  await a.call('POST', `/v1/claims/${claim.claimCode}/accept`, { token });
  const first = await a.call('POST', '/v1/hosts/link', { token, body: await claimBody(host) });
  assert.equal(first.status, 200);
  assert.equal((await a.call('GET', '/v1/devices', { token })).body.devices.length, 1);

  const again = await a.call('POST', '/v1/hosts/link', { token, body: await claimBody(host, { name: 'Renamed' }) });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'device_exists');
  assert.match(again.body.error, new RegExp(first.body.device.id));
  assert.equal((await a.call('POST', '/v1/hosts/heartbeat', { token: first.body.hostCredential, body: {} })).status, 200);

  // a different account can link the same computer (its own device row)
  const other = await a.call('POST', '/v1/hosts/link', { token: await signIn(a, 'b@example.com'), body: await claimBody(host) });
  assert.equal(other.status, 200);

  assert.equal((await a.call('DELETE', `/v1/devices/${first.body.device.id}`, { token })).status, 204);
  assert.equal((await a.call('POST', '/v1/hosts/link', { token, body: await claimBody(host) })).status, 200);
});

test('two concurrent links for one nodeId: one wins, the other is 409, no 500', async () => {
  const a = app();
  const host = await makeNode();
  const token = await signIn(a);
  const [r1, r2] = await Promise.all([
    a.call('POST', '/v1/hosts/link', { token, body: await claimBody(host) }),
    a.call('POST', '/v1/hosts/link', { token, body: await claimBody(host) }),
  ]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
  assert.equal(await a.env.DB.prepare('SELECT count(*) AS n FROM devices').first<number>('n'), 1);
});

test('link is rate limited per account', async () => {
  const a = app();
  const token = await signIn(a);
  const host = await makeNode();
  for (let i = 0; i < 10; i++) await a.call('POST', '/v1/hosts/link', { token, ip: `203.0.113.${i}`, body: { bad: true } });
  const limited = await a.call('POST', '/v1/hosts/link', { token, ip: '203.0.113.99', body: await claimBody(host) });
  assert.equal(limited.status, 429);
  assert.equal((await a.call('POST', '/v1/hosts/link', { token: await signIn(a, 'b@example.com'), ip: '203.0.113.98', body: await claimBody(host) })).status, 200);
});
