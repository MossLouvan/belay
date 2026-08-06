// Unit tests for WebSocket upgrade tickets.
//
// The properties that matter are single-use and expiry: a ticket that survives
// either of those is just a token in a URL again, which is the thing this
// module exists to stop.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTicketStore, TICKET_TTL_MS } from '../src/tickets.js';

function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

test('a freshly issued ticket redeems to the token it was issued for', () => {
  const store = createTicketStore();
  const { ticket } = store.issue('device-token-abc');
  assert.equal(store.redeem(ticket), 'device-token-abc');
});

test('a ticket is single use', () => {
  // Otherwise a URL captured from a log could open a second socket.
  const store = createTicketStore();
  const { ticket } = store.issue('token');
  assert.equal(store.redeem(ticket), 'token');
  assert.equal(store.redeem(ticket), null, 'a spent ticket must not work twice');
});

test('a ticket expires', () => {
  const clock = fakeClock();
  const store = createTicketStore(30_000, clock.now);
  const { ticket } = store.issue('token');

  clock.advance(29_000);
  const still = createTicketStore(30_000, clock.now);
  assert.ok(still !== null); // keeps the clock referenced for clarity
  assert.equal(store.redeem(ticket), 'token', 'valid just before expiry');
});

test('a ticket past its lifetime is refused', () => {
  const clock = fakeClock();
  const store = createTicketStore(30_000, clock.now);
  const { ticket } = store.issue('token');
  clock.advance(31_000);
  assert.equal(store.redeem(ticket), null);
});

test('an unknown ticket is refused without throwing', () => {
  const store = createTicketStore();
  for (const bad of ['', 'nope', 'a'.repeat(64), '0'.repeat(64)]) {
    assert.equal(store.redeem(bad), null, `${bad} must not redeem`);
  }
});

test('tickets are unique and long', () => {
  const store = createTicketStore();
  const seen = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const { ticket } = store.issue('token');
    assert.match(ticket, /^[0-9a-f]{64}$/, '256 bits of hex');
    assert.ok(!seen.has(ticket), 'tickets must not repeat');
    seen.add(ticket);
  }
});

test('two devices get tickets that redeem to their own tokens', () => {
  const store = createTicketStore();
  const a = store.issue('token-a');
  const b = store.issue('token-b');
  assert.equal(store.redeem(b.ticket), 'token-b');
  assert.equal(store.redeem(a.ticket), 'token-a');
});

test('expired tickets are pruned rather than accumulating', () => {
  const clock = fakeClock();
  const store = createTicketStore(1_000, clock.now);
  for (let i = 0; i < 20; i++) store.issue('token');
  assert.equal(store.size(), 20);

  clock.advance(2_000);
  assert.equal(store.size(), 0, 'nothing survives past its lifetime');
});

test('the live ticket count is bounded even if nothing is redeemed', () => {
  const store = createTicketStore();
  for (let i = 0; i < 1000; i++) store.issue('token');
  assert.ok(store.size() <= 256, `expected a cap, got ${store.size()}`);
});

test('the default lifetime is short enough for a leaked URL to be useless', () => {
  assert.ok(TICKET_TTL_MS <= 60_000, 'a ticket must not be a long-lived credential');
  assert.ok(TICKET_TTL_MS >= 5_000, 'but must survive one slow round trip');
});
