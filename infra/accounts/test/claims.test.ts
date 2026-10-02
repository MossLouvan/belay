// QR claim flow: host creates -> phone accepts -> host polls -> heartbeat.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { app, signIn } from './helpers.js';

const HOST = { nodeId: 'host-node-1', name: 'Moss MacBook', platform: 'macos' };

test('full claim flow', async () => {
  const a = app();
  const token = await signIn(a);
  await a.call('POST', '/v1/devices', { token, body: { kind: 'phone', name: 'iPhone', nodeId: 'phone-node-1' } });

  const created = await a.call('POST', '/v1/claims', { body: HOST });
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
  assert.equal(accepted.body.device.nodeId, HOST.nodeId);
  assert.equal((await a.call('POST', `/v1/claims/${claimCode}/accept`, { token })).body.code, 'claim_taken');

  const polled = await a.call('GET', `/v1/claims/${claimCode}`, { headers: secretHeader });
  assert.equal(polled.body.status, 'claimed');
  assert.match(polled.body.hostCredential, /^[A-Za-z0-9_-]{43}$/);
  // credential is delivered exactly once
  assert.deepEqual((await a.call('GET', `/v1/claims/${claimCode}`, { headers: secretHeader })).body, { status: 'claimed' });

  const hb = await a.call('POST', '/v1/hosts/heartbeat', { token: polled.body.hostCredential, body: {} });
  assert.deepEqual(hb.body, { allowedNodeIds: ['phone-node-1'], relayUrls: ['https://relay-1.example', 'https://relay-2.example'] });
  assert.equal((await a.call('POST', '/v1/hosts/heartbeat', { token: 'nope', body: {} })).status, 401);
  assert.equal((await a.call('POST', '/v1/hosts/heartbeat', { token, body: {} })).status, 401); // a session is not a host credential

  const devices = await a.call('GET', '/v1/devices', { token });
  assert.deepEqual(devices.body.devices.map((d: { kind: string }) => d.kind), ['phone', 'host']);
});

test('expired and unknown claims', async () => {
  const a = app();
  const token = await signIn(a);
  const { claimCode, hostSecret } = (await a.call('POST', '/v1/claims', { body: HOST })).body;
  await a.env.DB.prepare('UPDATE claims SET expires_at = ?1').bind(Date.now() - 1).run();
  assert.deepEqual((await a.call('GET', `/v1/claims/${claimCode}`, { headers: { 'x-host-secret': hostSecret } })).body, { status: 'expired' });
  assert.equal((await a.call('POST', `/v1/claims/${claimCode}/accept`, { token })).body.code, 'claim_expired');
  assert.equal((await a.call('POST', '/v1/claims/ZZZZZZZZ/accept', { token })).status, 404);
  assert.equal((await a.call('POST', '/v1/claims/not-base32!/accept', { token })).status, 404);
});

test('re-claiming the same host replaces the old device', async () => {
  const a = app();
  const token = await signIn(a);
  const first = (await a.call('POST', '/v1/claims', { body: HOST })).body;
  const d1 = (await a.call('POST', `/v1/claims/${first.claimCode}/accept`, { token })).body.device;
  const second = (await a.call('POST', '/v1/claims', { body: { ...HOST, name: 'Renamed' } })).body;
  const d2 = (await a.call('POST', `/v1/claims/${second.claimCode}/accept`, { token })).body.device;
  assert.notEqual(d1.id, d2.id);
  const list = (await a.call('GET', '/v1/devices', { token })).body.devices;
  assert.deepEqual(list.map((d: { name: string }) => d.name), ['Renamed']);
});

test('claim validation and host secret stored hashed', async () => {
  const a = app();
  assert.equal((await a.call('POST', '/v1/claims', { body: { ...HOST, nodeId: 'bad id' } })).body.code, 'bad_request');
  assert.equal((await a.call('POST', '/v1/claims', { body: { nodeId: 'n', name: 'x' } })).body.code, 'bad_request');
  const { hostSecret } = (await a.call('POST', '/v1/claims', { body: HOST })).body;
  const row = await a.env.DB.prepare('SELECT host_secret_hash FROM claims').first<string>('host_secret_hash');
  assert.notEqual(row, hostSecret);
  assert.match(row!, /^[0-9a-f]{64}$/);
});

test('unknown routes and unhandled errors use the envelope', async () => {
  const a = app();
  assert.deepEqual(await a.call('GET', '/v1/nope'), { status: 404, body: { error: 'not found', code: 'not_found' } });
  assert.equal((await a.call('PUT', '/v1/me')).status, 404);
});
