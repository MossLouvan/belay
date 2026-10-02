// accounts-client.ts: the heartbeat answer is the tunnel's allow-list, so
// its shape is checked harder than the others.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseHeartbeat } from '../src/accounts-client.js';

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
