// The phone's tunnel secret: generated once, kept in the keychain, never
// regenerated while a good one is stored.
//
//   cd app && node --test src/account/tunnel-key.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadOrCreateTunnelSecret, parseRelayUrls, DEFAULT_RELAY_URLS } from './tunnel-key.ts';

const bytes = (n) => new Uint8Array(n).map((_, i) => i);
const HEX = Array.from(bytes(32), (b) => b.toString(16).padStart(2, '0')).join('');

function fakeStore(initial = null) {
  const writes = [];
  let value = initial;
  return {
    writes,
    read: async () => value,
    write: async (v) => { writes.push(v); value = v; },
  };
}

test('generates a 64-hex secret once and stores it', async () => {
  const store = fakeStore();
  const secret = await loadOrCreateTunnelSecret(store.read, store.write, bytes);
  assert.equal(secret, HEX);
  assert.deepEqual(store.writes, [HEX]);
});

test('reuses the stored secret without writing again', async () => {
  const store = fakeStore(HEX);
  const secret = await loadOrCreateTunnelSecret(store.read, store.write, () => { throw new Error('must not generate'); });
  assert.equal(secret, HEX);
  assert.deepEqual(store.writes, []);
});

test('a corrupt stored value is replaced rather than passed to the FFI', async () => {
  const store = fakeStore('not-a-key');
  const secret = await loadOrCreateTunnelSecret(store.read, store.write, bytes);
  assert.equal(secret, HEX);
  assert.deepEqual(store.writes, [HEX]);
});

test('relay URLs come from config, comma separated, with a production default', () => {
  assert.deepEqual(parseRelayUrls(undefined), DEFAULT_RELAY_URLS);
  assert.deepEqual(parseRelayUrls('  '), DEFAULT_RELAY_URLS);
  assert.deepEqual(parseRelayUrls('https://a.example, https://b.example,'), ['https://a.example', 'https://b.example']);
  assert.deepEqual(parseRelayUrls('ftp://nope'), DEFAULT_RELAY_URLS, 'only https relays are accepted');
});
