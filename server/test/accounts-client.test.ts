// accounts-client.ts: the heartbeat answer is the tunnel's allow-list, so
// its shape is checked harder than the others.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseHeartbeat, parseLink, parsePoll } from '../src/accounts-client.js';

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
