// accounts-client.ts: the heartbeat answer is the tunnel's allow-list, so
// its shape is checked harder than the others.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseHeartbeat, parseLink, parsePoll, reportPhoneRequest } from '../src/accounts-client.js';

const ID = 'ab'.repeat(32);

test('parseHeartbeat accepts 64-hex node ids and defaults relayUrls', () => {
  assert.deepEqual(parseHeartbeat({ allowedNodeIds: [ID] }), { allowedNodeIds: [ID], relayUrls: [], phones: [] });
  assert.deepEqual(parseHeartbeat({ allowedNodeIds: [], relayUrls: ['https://r'] }), { allowedNodeIds: [], relayUrls: ['https://r'], phones: [] });
});

test('parseHeartbeat keeps phone metadata for allow-listed nodes only, and never fails on it', () => {
  const other = 'cd'.repeat(32);
  const hb = parseHeartbeat({
    allowedNodeIds: [ID],
    phones: [
      { nodeId: ID, platform: 'ios', createdAt: 1700000000000 },
      { nodeId: other, platform: 'android', createdAt: 1 },
      { nodeId: ID.slice(1), platform: 'x', createdAt: 1 },
      'junk',
    ],
  });
  assert.deepEqual(hb.phones, [{ nodeId: ID, platform: 'ios', createdAt: 1700000000000 }]);
  assert.deepEqual(parseHeartbeat({ allowedNodeIds: [ID], phones: 'nope' }).phones, []);
  // A long or odd platform is clamped, not trusted.
  assert.equal(parseHeartbeat({ allowedNodeIds: [ID], phones: [{ nodeId: ID, platform: `ios\n${'x'.repeat(80)}`, createdAt: 2 }] }).phones[0].platform.length <= 16, true);
});

test('parseHeartbeat rejects any node id that is not 64 lowercase hex', () => {
  for (const bad of [ID.toUpperCase(), ID.slice(1), `${ID}0`, 'n1', '', ` ${ID}`]) {
    assert.throws(() => parseHeartbeat({ allowedNodeIds: [ID, bad] }), /not a 64-hex node id/, JSON.stringify(bad));
  }
  assert.throws(() => parseHeartbeat({ allowedNodeIds: [ID, 7] }), /not a string list/);
  assert.throws(() => parseHeartbeat({}), /not a string list/);
});

test('parsePoll reads the service\'s claimedBy as the masked email', () => {
  assert.deepEqual(parsePoll({ status: 'claimed', claimedBy: 'us***@example.com', hostCredential: 'c' }), { status: 'claimed', hostCredential: 'c', maskedEmail: 'us***@example.com' });
});

test('parseLink needs a hostCredential and keeps the masked linkedBy', () => {
  const cred = 'A'.repeat(43);
  assert.deepEqual(parseLink({ hostCredential: cred, linkedBy: 'us***@example.com', device: {} }), { hostCredential: cred, maskedEmail: 'us***@example.com' });
  assert.deepEqual(parseLink({ hostCredential: cred, linkedBy: null }), { hostCredential: cred });
  assert.throws(() => parseLink({}), /hostCredential/);
  assert.throws(() => parseLink({ hostCredential: 'has space' }), /hostCredential/);
});

test('reportPhoneRequest posts the phone-request event with the host credential, and never throws', async () => {
  const original = globalThis.fetch;
  const calls: { url: string; init: RequestInit }[] = [];
  try {
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    assert.equal(await reportPhoneRequest('cred-1', { phoneName: 'Pixel', matchCode: 'K7QX' }, 'https://api.test/v1'), true);
    assert.equal(calls[0].url, 'https://api.test/v1/hosts/events');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal((calls[0].init.headers as Record<string, string>).authorization, 'Bearer cred-1');
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { type: 'phone-request', phoneName: 'Pixel', matchCode: 'K7QX' });

    globalThis.fetch = (async () => new Response('{"error":"nope","code":"unauthorized"}', { status: 401 })) as typeof fetch;
    assert.equal(await reportPhoneRequest('cred-1', { phoneName: 'Pixel', matchCode: 'K7QX' }, 'https://api.test/v1'), false);
    globalThis.fetch = (async () => { throw new TypeError('offline'); }) as typeof fetch;
    assert.equal(await reportPhoneRequest('cred-1', { phoneName: 'Pixel', matchCode: 'K7QX' }, 'https://api.test/v1'), false);
  } finally {
    globalThis.fetch = original;
  }
});
