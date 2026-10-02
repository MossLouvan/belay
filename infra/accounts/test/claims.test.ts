// QR claim flow: host creates (signed) -> phone accepts -> host polls -> heartbeat.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { claimMessage } from '../src/routes/claims.js';
import { app, claimBody, makeNode, phoneNodeId, signIn } from './helpers.js';

test('full claim flow', async () => {
  const a = app();
  const host = await makeNode();
  const token = await signIn(a);
  await a.call('POST', '/v1/devices', { token, body: { kind: 'phone', name: 'iPhone', nodeId: phoneNodeId() } });

  const created = await a.call('POST', '/v1/claims', { body: await claimBody(host) });
  assert.equal(created.status, 200);
  assert.match(created.body.claimCode, /^[A-Z2-7]{8}$/);
  assert.match(created.body.hostSecret, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(Date.parse(created.body.expiresAt) > Date.now());
  const { claimCode, hostSecret } = created.body;
  const secretHeader = { 'x-host-secret': hostSecret };

  assert.deepEqual((await a.call('GET', `/v1/claims/${claimCode}`, { headers: secretHeader })).body, { status: 'pending' });
  assert.equal((await a.call('GET', `/v1/claims/${claimCode}`)).status, 401);
  assert.equal((await a.call('GET', `/v1/claims/${claimCode}`, { headers: { 'x-host-secret': 'wrong' } })).status, 404);

  assert.equal((await a.call('POST', `/v1/claims/${claimCode}/accept`)).status, 401);
  const accepted = await a.call('POST', `/v1/claims/${claimCode.toLowerCase()}/accept`, { token });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.device.kind, 'host');
  assert.equal(accepted.body.device.nodeId, host.nodeId);
  assert.equal((await a.call('POST', `/v1/claims/${claimCode}/accept`, { token })).status, 404); // taken looks like unknown

  const polled = await a.call('GET', `/v1/claims/${claimCode}`, { headers: secretHeader });
  assert.equal(polled.body.status, 'claimed');
  assert.equal(polled.body.claimedBy, 'us***@example.com');
  assert.match(polled.body.hostCredential, /^[A-Za-z0-9_-]{43}$/);
  // credential is delivered exactly once
  assert.deepEqual((await a.call('GET', `/v1/claims/${claimCode}`, { headers: secretHeader })).body, { status: 'claimed', claimedBy: 'us***@example.com' });

  const hb = await a.call('POST', '/v1/hosts/heartbeat', { token: polled.body.hostCredential, body: {} });
  assert.deepEqual(hb.body, { allowedNodeIds: [phoneNodeId()], relayUrls: ['https://relay-1.example', 'https://relay-2.example'] });
  assert.equal((await a.call('POST', '/v1/hosts/heartbeat', { token: 'nope', body: {} })).status, 401);
  assert.equal((await a.call('POST', '/v1/hosts/heartbeat', { token, body: {} })).status, 401); // a session is not a host credential

  const devices = await a.call('GET', '/v1/devices', { token });
  assert.deepEqual(devices.body.devices.map((d: { kind: string }) => d.kind), ['phone', 'host']);
});

test('H1a: POST /claims requires proof of possession of the node key', async () => {
  const a = app();
  const host = await makeNode();
  const other = await makeNode();
  const post = async (body: Record<string, unknown>) => a.call('POST', '/v1/claims', { body });

  assert.equal((await post(await claimBody(host))).status, 200);
  // signed by a different key for the victim's (public) nodeId
  const ts = Math.floor(Date.now() / 1000);
  const forged = await post({ ...(await claimBody(host)), sig: await other.sign(claimMessage(host.nodeId, ts)), ts });
  assert.deepEqual(forged, { status: 401, body: { error: 'bad node signature', code: 'unauthorized' } });
  // signature over a different ts than the one sent
  assert.equal((await post({ ...(await claimBody(host)), ts: ts - 1 })).status, 401);
  // stale timestamp (signed correctly)
  const old = ts - 301;
  assert.equal((await post({ ...(await claimBody(host)), ts: old, sig: await host.sign(claimMessage(host.nodeId, old)) })).status, 401);
  // missing / malformed
  assert.equal((await post({ nodeId: host.nodeId, name: 'x', platform: 'macos' })).body.code, 'bad_request');
  assert.equal((await post(await claimBody(host, { sig: 'AAAA' }))).body.code, 'bad_request');
  assert.equal((await post(await claimBody(host, { nodeId: host.nodeId.toUpperCase() }))).body.code, 'bad_request');
});

test('H1b: a linked host with a live credential is never silently replaced', async () => {
  const a = app();
  const host = await makeNode();
  const token = await signIn(a);

  const first = (await a.call('POST', '/v1/claims', { body: await claimBody(host) })).body;
  const d1 = (await a.call('POST', `/v1/claims/${first.claimCode}/accept`, { token })).body.device;
  const cred = (await a.call('GET', `/v1/claims/${first.claimCode}`, { headers: { 'x-host-secret': first.hostSecret } })).body.hostCredential;

  const second = (await a.call('POST', '/v1/claims', { body: await claimBody(host, { name: 'Renamed' }) })).body;
  const conflict = await a.call('POST', `/v1/claims/${second.claimCode}/accept`, { token });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'device_exists');
  assert.match(conflict.body.error, new RegExp(d1.id));
  // the real host still works and the claim is still open
  assert.equal((await a.call('POST', '/v1/hosts/heartbeat', { token: cred, body: {} })).status, 200);
  assert.equal((await a.call('GET', `/v1/claims/${second.claimCode}`, { headers: { 'x-host-secret': second.hostSecret } })).body.status, 'pending');

  // explicit removal, then the new claim goes through
  assert.equal((await a.call('DELETE', `/v1/devices/${d1.id}`, { token })).status, 204);
  const d2 = (await a.call('POST', `/v1/claims/${second.claimCode}/accept`, { token })).body.device;
  assert.notEqual(d1.id, d2.id);
  assert.equal((await a.call('POST', '/v1/hosts/heartbeat', { token: cred, body: {} })).status, 401);
  assert.deepEqual((await a.call('GET', '/v1/devices', { token })).body.devices.map((d: { name: string }) => d.name), ['Renamed']);
});

test('a half-linked host (accepted, never polled) is replaced by a new claim', async () => {
  const a = app();
  const host = await makeNode();
  const token = await signIn(a);
  const first = (await a.call('POST', '/v1/claims', { body: await claimBody(host) })).body;
  await a.call('POST', `/v1/claims/${first.claimCode}/accept`, { token });
  const second = (await a.call('POST', '/v1/claims', { body: await claimBody(host) })).body;
  assert.equal((await a.call('POST', `/v1/claims/${second.claimCode}/accept`, { token })).status, 200);
  assert.equal((await a.call('GET', '/v1/devices', { token })).body.devices.length, 1);
});

test('M2: accept is rate limited per account and returns 404 uniformly', async () => {
  const a = app();
  const token = await signIn(a);
  const host = await makeNode();
  const { claimCode, hostSecret } = (await a.call('POST', '/v1/claims', { body: await claimBody(host) })).body;
  await a.env.DB.prepare('UPDATE claims SET expires_at = ?1').bind(Date.now() - 1).run();
  assert.deepEqual((await a.call('GET', `/v1/claims/${claimCode}`, { headers: { 'x-host-secret': hostSecret } })).body, { status: 'expired' });
  assert.equal((await a.call('POST', `/v1/claims/${claimCode}/accept`, { token })).status, 404); // expired
  assert.equal((await a.call('POST', '/v1/claims/ZZZZZZZZ/accept', { token })).status, 404); // unknown
  assert.equal((await a.call('POST', '/v1/claims/not-base32!/accept', { token })).status, 404);

  for (let i = 0; i < 7; i++) await a.call('POST', '/v1/claims/ZZZZZZZZ/accept', { token, ip: `203.0.113.${i}` }); // 3 above + 7 = the 10/10 min cap
  const limited = await a.call('POST', '/v1/claims/ZZZZZZZZ/accept', { token, ip: '203.0.113.99' });
  assert.equal(limited.status, 429);
  assert.equal((await a.call('POST', '/v1/claims/ZZZZZZZZ/accept', { token: await signIn(a, 'b@example.com'), ip: '203.0.113.98' })).status, 404);
});

test('L1: no orphan device when two accepts race for one claim', async () => {
  const a = app();
  const host = await makeNode();
  const token = await signIn(a);
  const { claimCode } = (await a.call('POST', '/v1/claims', { body: await claimBody(host) })).body;
  const [r1, r2] = await Promise.all([
    a.call('POST', `/v1/claims/${claimCode}/accept`, { token }),
    a.call('POST', `/v1/claims/${claimCode}/accept`, { token: await signIn(a, 'b@example.com') }),
  ]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 404]);
  assert.equal(await a.env.DB.prepare('SELECT count(*) AS n FROM devices').first<number>('n'), 1);
  assert.equal(await a.env.DB.prepare('SELECT count(*) AS n FROM devices WHERE id NOT IN (SELECT device_id FROM claims WHERE device_id IS NOT NULL)').first<number>('n'), 0);
});

test('host secret stored hashed', async () => {
  const a = app();
  const { hostSecret } = (await a.call('POST', '/v1/claims', { body: await claimBody(await makeNode()) })).body;
  const row = await a.env.DB.prepare('SELECT host_secret_hash FROM claims').first<string>('host_secret_hash');
  assert.notEqual(row, hostSecret);
  assert.match(row!, /^[0-9a-f]{64}$/);
});

test('unknown routes and malformed paths use the envelope', async () => {
  const a = app();
  assert.deepEqual(await a.call('GET', '/v1/nope'), { status: 404, body: { error: 'not found', code: 'not_found' } });
  assert.equal((await a.call('PUT', '/v1/me')).status, 404);
  const token = await signIn(a);
  assert.deepEqual(await a.call('DELETE', '/v1/devices/%E0%A4%A', { token }), { status: 400, body: { error: 'malformed path', code: 'bad_request' } });
});
