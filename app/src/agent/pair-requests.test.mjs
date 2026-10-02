// The `pairRequests` half of an attention frame: phones on the account
// waiting for one tap to join the connected computer.
//
//   cd app && node --test src/agent/pair-requests.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { livePairRequests, parsePairRequestsPush } from './pair-requests.ts';

const frame = (pairRequests) => JSON.stringify({ type: 'attention', sessions: [], pairRequests });

const ROW = { id: 'p1', name: 'iPad', matchCode: 'K7PQ', platform: 'ios', addedAt: 3, expiresAt: 5 };

test('reads id, name, match code, platform, join date and expiry', () => {
  assert.deepEqual(parsePairRequestsPush(frame([ROW])), [ROW]);
  // An older host without the new fields still shows a card, honestly.
  assert.deepEqual(parsePairRequestsPush(frame([{ id: 'p1', name: 'iPad', expiresAt: 5 }])),
    [{ id: 'p1', name: 'iPad', matchCode: '', platform: 'unknown', addedAt: null, expiresAt: 5 }]);
  assert.deepEqual(parsePairRequestsPush(frame([])), []);
});

test('an older host (no field) or a malformed list is null, never partial', () => {
  assert.equal(parsePairRequestsPush(JSON.stringify({ type: 'attention', sessions: [] })), null);
  assert.equal(parsePairRequestsPush(frame([{ id: 'p1', name: 'iPad', expiresAt: 5 }, { id: 3 }])), null);
  assert.equal(parsePairRequestsPush('not json'), null);
  assert.equal(parsePairRequestsPush(JSON.stringify({ type: 'other', pairRequests: [] })), null);
});

test('a name is clamped for display', () => {
  const [row] = parsePairRequestsPush(frame([{ id: 'p1', name: `\u0007${'x'.repeat(80)}`, expiresAt: 5 }]));
  assert.ok(row.name.length <= 32);
  assert.doesNotMatch(row.name, /\u0007/);
});

test('expired requests drop out locally', () => {
  const rows = [{ id: 'a', name: 'A', expiresAt: 100 }, { id: 'b', name: 'B', expiresAt: 300 }];
  assert.deepEqual(livePairRequests(rows, 200).map((r) => r.id), ['b']);
});
