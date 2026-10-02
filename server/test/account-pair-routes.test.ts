// The account-trust HTTP surface on a real express app. The tunnel tag is
// simulated the way tunnel-listener.ts applies it: `remoteAddress` on the
// socket becomes `tunnel:<nodeId>` before the routes see the request.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createAccountPairing } from '../src/account-pair.js';
import { registerAccountPairRoutes } from '../src/account-pair-routes.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const TOKEN = 'paired-phone-token';
const AS = 'x-test-as';

const SECRET_HEADER = 'x-belay-poll-secret';

async function harness(opts: { devices?: number; linked?: boolean; trustUntil?: number } = {}) {
  const app = express();
  app.use((req, _res, next) => {
    const as = req.headers[AS];
    if (typeof as === 'string') Object.defineProperty(req.socket, 'remoteAddress', { value: as, configurable: true });
    next();
  });
  app.use(express.json());
  const pairing = createAccountPairing();
  const h = {
    devices: opts.devices ?? 1, linked: opts.linked ?? true, issued: [] as string[],
    // Open by default for the first-phone tests; the harness closes it on mint like state.addDevice.
    trustUntil: opts.trustUntil ?? Date.now() + 60_000,
  };
  const auth: express.RequestHandler = (req, res, next) => {
    if (req.headers.authorization === `Bearer ${TOKEN}`) next(); else res.status(401).json({ error: 'unauthorized' });
  };
  registerAccountPairRoutes(app, auth, {
    pairing,
    allowList: () => [A, B],
    linked: () => h.linked,
    deviceCount: () => h.devices,
    trustUntil: () => h.trustUntil,
    phoneInfo: (node) => (node === A ? { platform: 'ios', createdAt: 7 } : undefined),
    issue: (name) => { h.issued.push(name); h.devices += 1; h.trustUntil = 0; return { token: `tok-${h.issued.length}`, name: 'Mac' }; },
  });
  const server: Server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (method: string, path: string, as: string | null, body?: unknown, token?: string, pollSecret?: string) => fetch(url + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(as ? { [AS]: as } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(pollSecret ? { [SECRET_HEADER]: pollSecret } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { h, pairing, call, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('POST /pair/account: loopback (non-tunnel) caller gets 403', async () => {
  const t = await harness({ devices: 0 });
  try {
    const res = await t.call('POST', '/pair/account', null, { deviceName: 'x' });
    assert.equal(res.status, 403);
    assert.equal(t.h.issued.length, 0);
  } finally { await t.close(); }
});

test('POST /pair/account: tunnel node not on the allow-list gets 403', async () => {
  const t = await harness({ devices: 0 });
  try {
    const res = await t.call('POST', '/pair/account', `tunnel:${'f'.repeat(64)}`, { deviceName: 'x' });
    assert.equal(res.status, 403);
  } finally { await t.close(); }
});

test('first phone on a linked host with no devices gets a token at once', async () => {
  const t = await harness({ devices: 0 });
  try {
    const res = await t.call('POST', '/pair/account', `tunnel:${A}`, { deviceName: 'iPhone' });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.token, 'tok-1');
    assert.equal(j.via, 'account');
    // The second phone is no longer the first.
    const second = await t.call('POST', '/pair/account', `tunnel:${B}`, { deviceName: 'iPad' });
    assert.equal(second.status, 202);
  } finally { await t.close(); }
});

test('an unlinked host with no devices does not auto-trust', async () => {
  const t = await harness({ devices: 0, linked: false });
  try {
    const res = await t.call('POST', '/pair/account', `tunnel:${A}`, { deviceName: 'iPhone' });
    assert.equal(res.status, 403);
    assert.equal(t.h.issued.length, 0);
  } finally { await t.close(); }
});

test('a linked host with no phones but no open window asks for a tap instead', async () => {
  const t = await harness({ devices: 0, trustUntil: 0 });
  try {
    const res = await t.call('POST', '/pair/account', `tunnel:${A}`, { deviceName: 'iPhone' });
    assert.equal(res.status, 202);
    assert.equal(t.h.issued.length, 0);
  } finally { await t.close(); }
});

test('second phone: 202 with a poll secret and match code, approve by a paired phone, token once', async () => {
  const t = await harness();
  try {
    const res = await t.call('POST', '/pair/account', `tunnel:${A}`, { deviceName: 'iPad' });
    assert.equal(res.status, 202);
    const { pendingId, pollSecret, matchCode } = await res.json();
    assert.match(pollSecret, /^[0-9a-f]{64}$/);
    assert.match(matchCode, /^[A-Z2-9]{4}$/);
    // The prompt carries the same code, the account's platform and join date.
    assert.deepEqual(t.pairing.list().map((p) => [p.matchCode, p.platform, p.addedAt]), [[matchCode, 'ios', 7]]);

    // Without (or with a wrong) poll secret: nothing.
    assert.equal((await t.call('GET', `/pair/account/${pendingId}`, `tunnel:${A}`)).status, 404);
    assert.equal((await t.call('GET', `/pair/account/${pendingId}`, `tunnel:${A}`, undefined, undefined, 'f'.repeat(64))).status, 404);
    const waiting = await (await t.call('GET', `/pair/account/${pendingId}`, `tunnel:${A}`, undefined, undefined, pollSecret)).json();
    assert.equal(waiting.status, 'pending');
    assert.equal(waiting.matchCode, matchCode);
    assert.equal(waiting.token, undefined);

    const ok = await t.call('POST', '/devices/approve', null, { pendingId, allow: true }, TOKEN);
    assert.equal(ok.status, 200);

    // Another node holding the id and secret learns nothing and takes nothing.
    assert.equal((await t.call('GET', `/pair/account/${pendingId}`, `tunnel:${B}`, undefined, undefined, pollSecret)).status, 404);
    const got = await t.call('GET', `/pair/account/${pendingId}`, `tunnel:${A}`, undefined, undefined, pollSecret);
    assert.equal(got.status, 200);
    const j = await got.json();
    assert.equal(j.status, 'approved');
    assert.equal(j.token, 'tok-1');
    assert.equal((await t.call('GET', `/pair/account/${pendingId}`, `tunnel:${A}`, undefined, undefined, pollSecret)).status, 404);
    assert.deepEqual(t.h.issued, ['iPad']);
  } finally { await t.close(); }
});

test('asking again returns a NEW request; the old id and secret are dead', async () => {
  const t = await harness();
  try {
    const first = await (await t.call('POST', '/pair/account', `tunnel:${A}`, { deviceName: 'iPad' })).json();
    const second = await (await t.call('POST', '/pair/account', `tunnel:${A}`, { deviceName: 'iPad' })).json();
    assert.notEqual(second.pendingId, first.pendingId);
    assert.notEqual(second.pollSecret, first.pollSecret);
    assert.equal((await t.call('GET', `/pair/account/${first.pendingId}`, `tunnel:${A}`, undefined, undefined, first.pollSecret)).status, 404);
  } finally { await t.close(); }
});

test('POST /devices/approve without a device token is 401 and decides nothing', async () => {
  const t = await harness();
  try {
    const { pendingId } = await (await t.call('POST', '/pair/account', `tunnel:${A}`, { deviceName: 'iPad' })).json();
    for (const allow of [true, false]) {
      assert.equal((await t.call('POST', '/devices/approve', `tunnel:${A}`, { pendingId, allow })).status, 401);
      assert.equal((await t.call('POST', '/devices/approve', null, { pendingId, allow }, 'wrong')).status, 401);
    }
    assert.equal(t.pairing.list().length, 1);
  } finally { await t.close(); }
});

test('POST /devices/approve validates its body and 404s an unknown request', async () => {
  const t = await harness();
  try {
    assert.equal((await t.call('POST', '/devices/approve', null, { pendingId: 'x', allow: 'yes' }, TOKEN)).status, 400);
    assert.equal((await t.call('POST', '/devices/approve', null, { pendingId: '0'.repeat(32), allow: true }, TOKEN)).status, 404);
  } finally { await t.close(); }
});

test('denied: the phone hears denied and gets no token', async () => {
  const t = await harness();
  try {
    const { pendingId, pollSecret } = await (await t.call('POST', '/pair/account', `tunnel:${A}`, { deviceName: 'iPad' })).json();
    await t.call('POST', '/devices/approve', null, { pendingId, allow: false }, TOKEN);
    const res = await t.call('GET', `/pair/account/${pendingId}`, `tunnel:${A}`, undefined, undefined, pollSecret);
    assert.equal(res.status, 403);
    assert.equal((await res.json()).status, 'denied');
    assert.equal(t.h.issued.length, 0);
  } finally { await t.close(); }
});

test('DELETE /pair/account/:id cancels only for the asking phone', async () => {
  const t = await harness();
  try {
    const { pendingId, pollSecret } = await (await t.call('POST', '/pair/account', `tunnel:${A}`, { deviceName: 'iPad' })).json();
    assert.equal((await t.call('DELETE', `/pair/account/${pendingId}`, `tunnel:${B}`, undefined, undefined, pollSecret)).status, 404);
    assert.equal((await t.call('DELETE', `/pair/account/${pendingId}`, `tunnel:${A}`)).status, 404);
    assert.equal((await t.call('DELETE', `/pair/account/${pendingId}`, `tunnel:${A}`, undefined, undefined, pollSecret)).status, 204);
    assert.equal(t.pairing.list().length, 0);
  } finally { await t.close(); }
});

test('429 carries Retry-After', async () => {
  const t = await harness();
  try {
    for (let i = 0; i < 2; i++) {
      const { pendingId } = await (await t.call('POST', '/pair/account', `tunnel:${A}`, {})).json();
      await t.call('POST', '/devices/approve', null, { pendingId, allow: false }, TOKEN);
    }
    const res = await t.call('POST', '/pair/account', `tunnel:${A}`, {});
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get('retry-after')) > 0);
  } finally { await t.close(); }
});
