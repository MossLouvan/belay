// accounts-client.ts: the heartbeat answer is the tunnel's allow-list, so
// its shape is checked harder than the others.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseHeartbeat, parseLink, parsePoll } from '../src/accounts-client.js';

const ID = 'ab'.repeat(32);

test('parseHeartbeat accepts 64-hex node ids and defaults relayUrls', () => {
  assert.deepEqual(parseHeartbeat({ allowedNodeIds: [ID] }), { allowedNodeIds: [ID], relayUrls: [] });
  assert.deepEqual(parseHeartbeat({ allowedNodeIds: [], relayUrls: ['https://r'] }), { allowedNodeIds: [], relayUrls: ['https://r'] });
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
