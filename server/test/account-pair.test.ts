// Account trust (account-pair.ts): who may ask, when the first phone is
// trusted without a tap, and how a later phone's one-tap approval resolves.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ACCOUNT_PAIR_DEFAULTS, createAccountPairing } from '../src/account-pair.js';
import type { AccountPairRequest } from '../src/account-pair.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const D = 'd'.repeat(64);
const ALLOW = [A, B, C, D];

function setup(over: Partial<typeof ACCOUNT_PAIR_DEFAULTS> = {}) {
  let t = 1_000_000;
  const audit: string[] = [];
  const pairing = createAccountPairing({ ...over, audit: (l) => audit.push(l) }, () => t);
  const ask = (node: string, extra: Partial<AccountPairRequest> = {}) => pairing.request({
    remoteAddress: `tunnel:${node}`, allowList: ALLOW, linked: true, deviceCount: 1, name: 'Pixel', ...extra,
  });
  return { pairing, audit, ask, advance: (ms: number) => { t += ms; } };
}

test('a LAN or loopback caller is refused with 403', () => {
  const { ask } = setup();
  for (const remoteAddress of ['192.168.1.5', '127.0.0.1', '::1', undefined]) {
    const r = ask(A, { remoteAddress });
    assert.equal(r.kind, 'refused');
    assert.equal(r.kind === 'refused' && r.status, 403);
  }
});

test('a tunnel peer not on the account allow-list is refused with 403', () => {
  const { ask } = setup();
  const r = ask('e'.repeat(64));
  assert.equal(r.kind === 'refused' && r.status, 403);
  // A malformed tunnel tag is not admitted either.
  assert.equal(ask('A'.repeat(64)).kind, 'refused');
});

test('first phone: trusted at once only when zero devices AND linked', () => {
  const { ask } = setup();
  assert.equal(ask(A, { deviceCount: 0, linked: true }).kind, 'trusted');
  assert.equal(ask(B, { deviceCount: 0, linked: false }).kind, 'refused');
  assert.equal(ask(C, { deviceCount: 1, linked: true }).kind, 'pending');
});

test('an unlinked host refuses even an allow-listed node (403)', () => {
  const { ask } = setup();
  const r = ask(A, { linked: false, deviceCount: 3 });
  assert.equal(r.kind === 'refused' && r.status, 403);
});

test('second phone: pending until approved, and the token is issued exactly once', () => {
  const { pairing, ask, audit } = setup();
  const r = ask(A);
  assert.equal(r.kind, 'pending');
  const id = r.kind === 'pending' ? r.id : '';
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal(pairing.poll(id, `tunnel:${A}`).status, 'pending');
  assert.deepEqual(pairing.list().map((p) => p.name), ['Pixel']);

  assert.equal(pairing.decide(id, true), true);
  const first = pairing.poll(id, `tunnel:${A}`);
  assert.equal(first.status, 'approved');
  assert.equal(first.status === 'approved' && first.name, 'Pixel');
  assert.equal(pairing.poll(id, `tunnel:${A}`).status, 'unknown');
  assert.equal(pairing.decide(id, true), false);
  assert.deepEqual(pairing.list(), []);
  assert.ok(audit.some((l) => l.includes('approved')));
});

test('a poll from any other source learns nothing and does not collect the token', () => {
  const { pairing, ask } = setup();
  const r = ask(A);
  const id = r.kind === 'pending' ? r.id : '';
  pairing.decide(id, true);
  assert.equal(pairing.poll(id, `tunnel:${B}`).status, 'unknown');
  assert.equal(pairing.poll(id, '192.168.1.5').status, 'unknown');
  assert.equal(pairing.poll(id, `tunnel:${A}`).status, 'approved');
});

test('a denied request answers denied once and is cleared', () => {
  const { pairing, ask } = setup();
  const r = ask(A);
  const id = r.kind === 'pending' ? r.id : '';
  assert.equal(pairing.decide(id, false), true);
  assert.deepEqual(pairing.list(), []);
  assert.equal(pairing.poll(id, `tunnel:${A}`).status, 'denied');
  assert.equal(pairing.poll(id, `tunnel:${A}`).status, 'unknown');
});

test('an expired pending cannot be approved and is cleared', () => {
  const { pairing, ask, advance } = setup();
  const r = ask(A);
  const id = r.kind === 'pending' ? r.id : '';
  advance(ACCOUNT_PAIR_DEFAULTS.ttlMs + 1);
  assert.equal(pairing.decide(id, true), false);
  assert.equal(pairing.poll(id, `tunnel:${A}`).status, 'unknown');
  assert.deepEqual(pairing.list(), []);
});

test('an approval collected late still works within a fresh window, not forever', () => {
  const { pairing, ask, advance } = setup();
  const r = ask(A);
  const id = r.kind === 'pending' ? r.id : '';
  advance(ACCOUNT_PAIR_DEFAULTS.ttlMs - 1000);
  pairing.decide(id, true);
  advance(2000);
  assert.equal(pairing.poll(id, `tunnel:${A}`).status, 'approved');

  const r2 = ask(B);
  const id2 = r2.kind === 'pending' ? r2.id : '';
  pairing.decide(id2, true);
  advance(ACCOUNT_PAIR_DEFAULTS.ttlMs + 1);
  assert.equal(pairing.poll(id2, `tunnel:${B}`).status, 'unknown');
});

test('asking again while pending returns the same request without counting', () => {
  const { ask } = setup();
  const first = ask(A);
  for (let i = 0; i < 5; i++) {
    const again = ask(A);
    assert.equal(again.kind === 'pending' && again.id, first.kind === 'pending' && first.id);
  }
});

test('rate limit: at most 3 requests per account per 10 minutes', () => {
  const { pairing, ask, advance } = setup();
  for (const n of [A, B, C]) {
    const r = ask(n);
    assert.equal(r.kind, 'pending');
    pairing.decide(r.kind === 'pending' ? r.id : '', false);
  }
  const fourth = ask(D);
  assert.equal(fourth.kind === 'refused' && fourth.status, 429);
  assert.ok(fourth.kind === 'refused' && fourth.retryAfterSec > 0);
  advance(ACCOUNT_PAIR_DEFAULTS.windowMs);
  assert.equal(ask(D).kind, 'pending');
});

test('rate limit: per node, a denied phone cannot keep re-asking', () => {
  const { pairing, ask } = setup({ perAccountMax: 100 });
  for (let i = 0; i < ACCOUNT_PAIR_DEFAULTS.perNodeMax; i++) {
    const r = ask(A);
    assert.equal(r.kind, 'pending');
    pairing.decide(r.kind === 'pending' ? r.id : '', false);
  }
  const r = ask(A);
  assert.equal(r.kind === 'refused' && r.status, 429);
  assert.equal(ask(B).kind, 'pending');
});

test('refusals are not counted against the owner', () => {
  const { ask } = setup();
  for (let i = 0; i < 10; i++) ask('e'.repeat(64));
  assert.equal(ask(A).kind, 'pending');
});

test('the requesting phone can cancel; nobody else can', () => {
  const { pairing, ask } = setup();
  const r = ask(A);
  const id = r.kind === 'pending' ? r.id : '';
  assert.equal(pairing.cancel(id, `tunnel:${B}`), false);
  assert.equal(pairing.cancel(id, `tunnel:${A}`), true);
  assert.deepEqual(pairing.list(), []);
  assert.equal(pairing.decide(id, true), false);
});

test('the phone name is clamped before anyone sees it', () => {
  const { pairing, ask } = setup();
  ask(A, { name: `\u0007Evil\nPhone${'x'.repeat(100)}` });
  const [p] = pairing.list();
  assert.ok(p.name.length <= 32);
  assert.doesNotMatch(p.name, /[\u0000-\u001f]/);
});

test('subscribers hear about new and resolved requests', () => {
  const { pairing, ask } = setup();
  let calls = 0;
  const off = pairing.onChange(() => { calls += 1; });
  const r = ask(A);
  pairing.decide(r.kind === 'pending' ? r.id : '', true);
  assert.equal(calls, 2);
  off();
  ask(B);
  assert.equal(calls, 2);
});

test('every outcome writes an audit line', () => {
  const { pairing, ask, audit } = setup();
  ask('e'.repeat(64));
  ask(A, { deviceCount: 0 });
  const r = ask(B);
  pairing.decide(r.kind === 'pending' ? r.id : '', false);
  assert.ok(audit.some((l) => /refused 403/.test(l)));
  assert.ok(audit.some((l) => /first phone/.test(l)));
  assert.ok(audit.some((l) => /pending/.test(l)));
  assert.ok(audit.some((l) => /denied/.test(l)));
});
