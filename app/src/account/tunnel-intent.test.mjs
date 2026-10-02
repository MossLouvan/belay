// The tunnel pairing intent lives in memory, never in a URL: a deep link
// cannot name a node or switch on account trust.
//
//   cd app && node --test src/account/tunnel-intent.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { clearTunnelIntent, holdTunnelIntent, setTunnelIntent, tunnelIntentFor } from './tunnel-intent.ts';

const NODE = 'ab'.repeat(32);
const OTHER = 'cd'.repeat(32);

test('matches only the exact loopback address the tunnel dial produced, for an account node', () => {
  setTunnelIntent({ port: 5555, nodeId: NODE, trust: true });
  assert.deepEqual(tunnelIntentFor('https://127.0.0.1:5555', [NODE]), { nodeId: NODE, trust: true });
  for (const address of ['https://127.0.0.1:5556', 'http://127.0.0.1:5555', 'https://localhost:5555', 'https://10.0.0.2:5555', null]) {
    assert.equal(tunnelIntentFor(address, [NODE]), null, String(address));
  }
});

test('a node that is not on the account is never trusted', () => {
  setTunnelIntent({ port: 5555, nodeId: NODE, trust: true });
  assert.equal(tunnelIntentFor('https://127.0.0.1:5555', [OTHER]), null);
  assert.equal(tunnelIntentFor('https://127.0.0.1:5555', []), null);
});

test('nothing set (a cold deep link) means no tunnel and no trust', () => {
  clearTunnelIntent();
  assert.equal(tunnelIntentFor('https://127.0.0.1:5555', [NODE]), null);
});

test('the screen keeps the intent it matched after the shared one is cleared, for that address only', () => {
  const ADDR = 'https://127.0.0.1:5555';
  setTunnelIntent({ port: 5555, nodeId: NODE, trust: true });
  const held = holdTunnelIntent(ADDR, [NODE], null);
  assert.deepEqual(held, { address: ADDR, nodeId: NODE, trust: true });
  // A pairing attempt resolved (or the screen closed): the dial is spent.
  clearTunnelIntent();
  assert.equal(tunnelIntentFor(ADDR, [NODE]), null);
  // The same screen re-rendering (account list refreshed) keeps what it had...
  assert.deepEqual(holdTunnelIntent(ADDR, [NODE], held), held);
  assert.deepEqual(holdTunnelIntent(ADDR, [], held), held);
  // ...but a new arrival, or a fresh screen, gets nothing.
  assert.equal(holdTunnelIntent('https://127.0.0.1:5556', [NODE], held), null);
  assert.equal(holdTunnelIntent(ADDR, [NODE], null), null);
});
