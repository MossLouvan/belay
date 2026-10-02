// /me, /devices, and account deletion cascades.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SESSION_TTL_MS } from '../src/env.js';
import { app, signIn } from './helpers.js';

test('session routes reject missing, bogus and expired sessions', async () => {
  const a = app();
  assert.equal((await a.call('GET', '/v1/me')).status, 401);
  assert.equal((await a.call('GET', '/v1/me', { token: 'bogus' })).status, 401);
  const token = await signIn(a);
  assert.equal((await a.call('GET', '/v1/me', { token })).status, 200);
  await a.env.DB.prepare('UPDATE sessions SET expires_at = ?1').bind(Date.now() - 1).run();
  assert.equal((await a.call('GET', '/v1/me', { token })).status, 401);
});

test('session expiry slides forward on use', async () => {
  const a = app();
  const token = await signIn(a);
  const stale = Date.now() + SESSION_TTL_MS - 3 * 86_400_000;
  await a.env.DB.prepare('UPDATE sessions SET expires_at = ?1').bind(stale).run();
  await a.call('GET', '/v1/me', { token });
  const row = await a.env.DB.prepare('SELECT expires_at FROM sessions').first<number>('expires_at');
  assert.ok(row! > stale + 2 * 86_400_000);
});

test('phone registers, re-registers by nodeId, lists and deletes', async () => {
  const a = app();
  const token = await signIn(a);
  const other = await signIn(a, 'other@example.com');

  const created = await a.call('POST', '/v1/devices', { body: { kind: 'phone', name: 'iPhone', nodeId: 'node-a', platform: 'ios' } });
  assert.equal(created.status, 401);

  const dev = await a.call('POST', '/v1/devices', { token, body: { kind: 'phone', name: 'iPhone', nodeId: 'node-a', platform: 'ios' } });
  assert.equal(dev.status, 200);
  assert.deepEqual(Object.keys(dev.body.device).sort(), ['id', 'kind', 'lastSeenAt', 'name', 'nodeId', 'platform']);

  const renamed = await a.call('POST', '/v1/devices', { token, body: { kind: 'phone', name: 'My iPhone', nodeId: 'node-a' } });
  assert.equal(renamed.body.device.id, dev.body.device.id);
  assert.equal(renamed.body.device.name, 'My iPhone');

  const list = await a.call('GET', '/v1/devices', { token });
  assert.equal(list.body.devices.length, 1);
  assert.equal((await a.call('GET', '/v1/devices', { token: other })).body.devices.length, 0);

  assert.equal((await a.call('DELETE', `/v1/devices/${dev.body.device.id}`, { token: other })).status, 404);
  assert.equal((await a.call('DELETE', `/v1/devices/${dev.body.device.id}`, { token })).status, 204);
  assert.equal((await a.call('GET', '/v1/devices', { token })).body.devices.length, 0);
});

test('device validation', async () => {
  const a = app();
  const token = await signIn(a);
  const bad = async (body: unknown) => assert.equal((await a.call('POST', '/v1/devices', { token, body })).body.code, 'bad_request');
  await bad({ kind: 'host', name: 'x', nodeId: 'n' });
  await bad({ kind: 'phone', nodeId: 'n' });
  await bad({ kind: 'phone', name: 'x', nodeId: 'has space' });
  await bad({ kind: 'phone', name: 'x'.repeat(101), nodeId: 'n' });
});

test('DELETE /me cascades to sessions, devices, identities and claims', async () => {
  const a = app();
  const token = await signIn(a);
  await a.call('POST', '/v1/devices', { token, body: { kind: 'phone', name: 'iPhone', nodeId: 'node-a' } });
  const claim = await a.call('POST', '/v1/claims', { body: { nodeId: 'host-1', name: 'Mac', platform: 'macos' } });
  await a.call('POST', `/v1/claims/${claim.body.claimCode}/accept`, { token });
  const poll = await a.call('GET', `/v1/claims/${claim.body.claimCode}`, { headers: { 'x-host-secret': claim.body.hostSecret } });
  const hostCredential = poll.body.hostCredential as string;
  assert.equal((await a.call('POST', '/v1/hosts/heartbeat', { token: hostCredential, body: {} })).status, 200);

  assert.equal((await a.call('DELETE', '/v1/me', { token })).status, 204);
  assert.equal((await a.call('GET', '/v1/me', { token })).status, 401);
  assert.equal((await a.call('POST', '/v1/hosts/heartbeat', { token: hostCredential, body: {} })).status, 401);
  for (const table of ['accounts', 'identities', 'sessions', 'devices', 'claims']) {
    assert.equal(await a.env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<number>('n'), 0, table);
  }
});
