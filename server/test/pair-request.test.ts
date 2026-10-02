// Who may make the host put a fresh pairing code on its own screen, and how
// often. See pair-request.ts for why the gate exists at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPairRequestGate, isLanAddress, PAIR_REQUEST_DEFAULTS } from '../src/pair-request.js';

const NODE_A = 'a'.repeat(64);
const NODE_B = 'b'.repeat(64);
const ALLOW = [NODE_A];

const clock = (start = 1_000_000) => {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
};

test('LAN means private, link-local, tailnet and loopback addresses only', () => {
  for (const ip of ['192.168.1.20', '10.0.0.5', '172.16.4.4', '172.31.255.1', '169.254.1.1', '100.101.102.103',
    '127.0.0.1', '::1', '::ffff:192.168.1.20', 'fe80::1', 'fd7a:115c:a1e0::1']) {
    assert.equal(isLanAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '2001:4860::1', '', undefined, `tunnel:${NODE_A}`, 'nonsense']) {
    assert.equal(isLanAddress(ip), false, String(ip));
  }
});

test('an allow-listed tunnel peer may ask for a code', () => {
  const gate = createPairRequestGate();
  assert.deepEqual(gate.decide(`tunnel:${NODE_A}`, ALLOW), { allowed: true });
});

test('a tunnel peer that is not on the account allow-list gets nothing', () => {
  const gate = createPairRequestGate();
  const d = gate.decide(`tunnel:${NODE_B}`, ALLOW);
  assert.equal(d.allowed, false);
  assert.equal(d.allowed === false && d.status, 403);
});

test('an empty allow-list (unlinked host) admits no tunnel peer', () => {
  const gate = createPairRequestGate();
  assert.equal(gate.decide(`tunnel:${NODE_A}`, []).allowed, false);
});

test('a malformed tunnel tag is refused, not treated as an address', () => {
  const gate = createPairRequestGate();
  assert.equal(gate.decide('tunnel:', ['']).allowed, false);
  assert.equal(gate.decide('tunnel:xyz', ['xyz']).allowed, false);
});

test('a LAN address may ask; a public one may not', () => {
  const gate = createPairRequestGate();
  assert.equal(gate.decide('192.168.1.20', ALLOW).allowed, true);
  const pub = gate.decide('8.8.8.8', ALLOW);
  assert.equal(pub.allowed, false);
  assert.equal(pub.allowed === false && pub.status, 403);
  assert.equal(gate.decide(undefined, ALLOW).allowed, false);
});

test('a refused request does not spend the budget', () => {
  const gate = createPairRequestGate({ globalMax: 1 });
  for (let i = 0; i < 10; i += 1) gate.decide('8.8.8.8', ALLOW);
  for (let i = 0; i < 10; i += 1) gate.decide(`tunnel:${NODE_B}`, ALLOW);
  assert.equal(gate.decide('192.168.1.20', ALLOW).allowed, true);
});

test('one source is rate limited, with a retry-after', () => {
  const c = clock();
  const gate = createPairRequestGate({}, c.now);
  for (let i = 0; i < PAIR_REQUEST_DEFAULTS.perSourceMax; i += 1) {
    assert.equal(gate.decide('192.168.1.20', ALLOW).allowed, true);
  }
  const d = gate.decide('192.168.1.20', ALLOW);
  assert.equal(d.allowed, false);
  assert.equal(d.allowed === false && d.status, 429);
  assert.ok(d.allowed === false && d.retryAfterSec > 0 && d.retryAfterSec <= PAIR_REQUEST_DEFAULTS.windowMs / 1000);
});

test('the IPv4-mapped spelling of an address shares its bucket', () => {
  const gate = createPairRequestGate({ perSourceMax: 1 });
  assert.equal(gate.decide('192.168.1.20', ALLOW).allowed, true);
  assert.equal(gate.decide('::ffff:192.168.1.20', ALLOW).allowed, false);
});

test('tunnel peers are rate limited too', () => {
  const gate = createPairRequestGate({ perSourceMax: 1 });
  assert.equal(gate.decide(`tunnel:${NODE_A}`, ALLOW).allowed, true);
  assert.equal(gate.decide(`tunnel:${NODE_A}`, ALLOW).allowed, false);
});

test('a global cap bounds codes across many sources', () => {
  const gate = createPairRequestGate();
  for (let i = 0; i < PAIR_REQUEST_DEFAULTS.globalMax; i += 1) {
    assert.equal(gate.decide(`192.168.1.${i + 1}`, ALLOW).allowed, true);
  }
  const d = gate.decide('192.168.1.200', ALLOW);
  assert.equal(d.allowed, false);
  assert.equal(d.allowed === false && d.status, 429);
});

test('the window slides: requests are allowed again once it passes', () => {
  const c = clock();
  const gate = createPairRequestGate({ perSourceMax: 1 }, c.now);
  assert.equal(gate.decide('192.168.1.20', ALLOW).allowed, true);
  assert.equal(gate.decide('192.168.1.20', ALLOW).allowed, false);
  c.advance(PAIR_REQUEST_DEFAULTS.windowMs + 1);
  assert.equal(gate.decide('192.168.1.20', ALLOW).allowed, true);
});

test('the defaults keep guesses bounded well below the code space', () => {
  // Each minted code tolerates 20 wrong guesses (pair-guard) before it burns,
  // so the global cap is the ceiling on guesses per window.
  const perHour = PAIR_REQUEST_DEFAULTS.globalMax * 20 * (3_600_000 / PAIR_REQUEST_DEFAULTS.windowMs);
  assert.ok(perHour <= 400, `${perHour} guesses/hour`);
});
