// Account trust (account-pair.ts): who may ask, when the first phone is
// trusted without a tap, and how a later phone's one-tap approval resolves.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ACCOUNT_PAIR_DEFAULTS, FIRST_PHONE_WINDOW_MS, createAccountPairing } from '../src/account-pair.js';
import type { AccountPairRequest } from '../src/account-pair.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const D = 'd'.repeat(64);
const ALLOW = [A, B, C, D];
const T0 = 1_000_000;

function setup(over: Partial<typeof ACCOUNT_PAIR_DEFAULTS> = {}) {
  let t = T0;
  const audit: string[] = [];
  const pairing = createAccountPairing({ ...over, audit: (l) => audit.push(l) }, () => t);
  const ask = (node: string, extra: Partial<AccountPairRequest> = {}) => pairing.request({
    remoteAddress: `tunnel:${node}`, allowList: ALLOW, linked: true, deviceCount: 1, trustUntil: 0, name: 'Pixel', ...extra,
  });
  const pend = (node: string, extra: Partial<AccountPairRequest> = {}) => {
    const r = ask(node, extra);
    assert.equal(r.kind, 'pending', JSON.stringify(r));
    return r as Extract<typeof r, { kind: 'pending' }>;
  };
  const adm = (node: string, allowList = ALLOW, linked = true) => ({ remoteAddress: `tunnel:${node}`, allowList, linked });
  return { pairing, audit, ask, pend, adm, advance: (ms: number) => { t += ms; } };
}

test('a LAN or loopback caller is refused with 403', () => {
  const { ask } = setup();
  for (const remoteAddress of ['192.168.1.5', '127.0.0.1', '::1', undefined]) {
    const r = ask(A, { remoteAddress });
    assert.equal(r.kind === 'refused' && r.status, 403);
  }
});

test('a tunnel peer not on the account allow-list is refused with 403', () => {
  const { ask } = setup();
  assert.equal(ask('e'.repeat(64)).kind === 'refused' && 403, 403);
  assert.equal(ask('A'.repeat(64)).kind, 'refused');
});

test('an unlinked host refuses even an allow-listed node (403)', () => {
  const { ask } = setup();
  const r = ask(A, { linked: false, deviceCount: 0, trustUntil: T0 + 1000 });
  assert.equal(r.kind === 'refused' && r.status, 403);
});

test('first phone: trusted only with 0 devices AND linked AND inside the window', () => {
  const { ask } = setup({ perAccountMax: 10 });
  const open = T0 + FIRST_PHONE_WINDOW_MS;
  assert.equal(ask(A, { deviceCount: 0, trustUntil: open }).kind, 'trusted');
  // No window (linked before this existed, or already used): a tap is needed.
  assert.equal(ask(B, { deviceCount: 0, trustUntil: 0 }).kind, 'pending');
  // A window that lapsed.
  assert.equal(ask(C, { deviceCount: 0, trustUntil: T0 }).kind, 'pending');
  // A phone already paired: never auto-trusted, window or not.
  assert.equal(ask(D, { deviceCount: 1, trustUntil: open }).kind, 'pending');
});

test('second phone: pending, needs its poll secret, token exactly once', () => {
  const { pairing, pend, adm, audit } = setup();
  const r = pend(A);
  assert.match(r.id, /^[0-9a-f]{32}$/);
  assert.match(r.secret, /^[0-9a-f]{64}$/);
  assert.equal(pairing.poll(r.id, r.secret, adm(A)).status, 'pending');
  assert.equal(pairing.poll(r.id, 'f'.repeat(64), adm(A)).status, 'unknown');
  assert.equal(pairing.poll(r.id, '', adm(A)).status, 'unknown');

  assert.equal(pairing.decide(r.id, true, adm(A)), true);
  assert.equal(pairing.poll(r.id, 'f'.repeat(64), adm(A)).status, 'unknown');
  const first = pairing.poll(r.id, r.secret, adm(A));
  assert.equal(first.status === 'approved' && first.name, 'Pixel');
  assert.equal(pairing.poll(r.id, r.secret, adm(A)).status, 'unknown');
  assert.equal(pairing.decide(r.id, true, adm(A)), false);
  assert.ok(audit.some((l) => l.includes('token issued')));
});

test('another node holding the id and secret still gets nothing', () => {
  const { pairing, pend, adm } = setup();
  const r = pend(A);
  pairing.decide(r.id, true, adm(A));
  assert.equal(pairing.poll(r.id, r.secret, adm(B)).status, 'unknown');
  assert.equal(pairing.poll(r.id, r.secret, { remoteAddress: '192.168.1.5', allowList: ALLOW, linked: true }).status, 'unknown');
  assert.equal(pairing.poll(r.id, r.secret, adm(A)).status, 'approved');
});

test('asking again never hands back the earlier request: it replaces it', () => {
  const { pairing, pend, adm } = setup({ perNodeMax: 5 });
  const first = pend(A);
  const second = pend(A);
  assert.notEqual(second.id, first.id);
  assert.notEqual(second.secret, first.secret);
  assert.equal(pairing.poll(first.id, first.secret, adm(A)).status, 'unknown');
  assert.equal(pairing.decide(first.id, true, adm(A)), false);
  assert.deepEqual(pairing.list().map((p) => p.id), [second.id]);
});

test('a denied request answers denied once and is cleared', () => {
  const { pairing, pend, adm } = setup();
  const r = pend(A);
  assert.equal(pairing.decide(r.id, false, adm(A)), true);
  assert.deepEqual(pairing.list(), []);
  assert.equal(pairing.poll(r.id, r.secret, adm(A)).status, 'denied');
  assert.equal(pairing.poll(r.id, r.secret, adm(A)).status, 'unknown');
});

test('an expired pending cannot be approved and is cleared', () => {
  const { pairing, pend, adm, advance } = setup();
  const r = pend(A);
  advance(ACCOUNT_PAIR_DEFAULTS.ttlMs + 1);
  assert.equal(pairing.decide(r.id, true, adm(A)), false);
  assert.equal(pairing.poll(r.id, r.secret, adm(A)).status, 'unknown');
  assert.deepEqual(pairing.list(), []);
});

test('an approval collected late still works within a fresh window, not forever', () => {
  const { pairing, pend, adm, advance } = setup();
  const r = pend(A);
  advance(ACCOUNT_PAIR_DEFAULTS.ttlMs - 1000);
  pairing.decide(r.id, true, adm(A));
  advance(2000);
  assert.equal(pairing.poll(r.id, r.secret, adm(A)).status, 'approved');

  const r2 = pend(B);
  pairing.decide(r2.id, true, adm(B));
  advance(ACCOUNT_PAIR_DEFAULTS.ttlMs + 1);
  assert.equal(pairing.poll(r2.id, r2.secret, adm(B)).status, 'unknown');
});

test('a phone dropped from the account (or an unlinked host) can neither be approved nor collect', () => {
  const { pairing, pend, adm } = setup({ perAccountMax: 10 });
  const r = pend(A);
  assert.equal(pairing.decide(r.id, true, adm(A, [B])), false);
  assert.deepEqual(pairing.list(), []);

  const r2 = pend(B);
  pairing.decide(r2.id, true, adm(B));
  assert.equal(pairing.poll(r2.id, r2.secret, adm(B, [A])).status, 'unknown');

  const r3 = pend(C);
  assert.equal(pairing.decide(r3.id, true, adm(C, ALLOW, false)), false);
  const r4 = pend(D);
  pairing.decide(r4.id, true, adm(D));
  assert.equal(pairing.poll(r4.id, r4.secret, adm(D, ALLOW, false)).status, 'unknown');
});

test('rate limit: 2 per phone per 10 minutes', () => {
  const { pairing, pend, ask, adm } = setup();
  for (let i = 0; i < ACCOUNT_PAIR_DEFAULTS.perNodeMax; i++) pairing.decide(pend(A).id, false, adm(A));
  const r = ask(A);
  assert.equal(r.kind === 'refused' && r.status, 429);
  assert.ok(r.kind === 'refused' && r.retryAfterSec > 0);
});

test('rate limit: 3 distinct phones per account per 10 minutes, and one noisy phone takes one slot', () => {
  const { pairing, pend, ask, adm, advance } = setup();
  // A burns its own per-phone budget; that is still only one account slot.
  pairing.decide(pend(A).id, false, adm(A));
  pairing.decide(pend(A).id, false, adm(A));
  assert.equal(ask(A).kind, 'refused');
  pend(B);
  pend(C);
  const fourth = ask(D);
  assert.equal(fourth.kind === 'refused' && fourth.status, 429);
  advance(ACCOUNT_PAIR_DEFAULTS.windowMs);
  assert.equal(ask(D).kind, 'pending');
});

test('refusals are not counted against the owner', () => {
  const { ask } = setup();
  for (let i = 0; i < 10; i++) ask('e'.repeat(64));
  assert.equal(ask(A).kind, 'pending');
});

test('only the asking phone, with its secret, can cancel', () => {
  const { pairing, pend, adm } = setup();
  const r = pend(A);
  assert.equal(pairing.cancel(r.id, r.secret, `tunnel:${B}`), false);
  assert.equal(pairing.cancel(r.id, 'f'.repeat(64), `tunnel:${A}`), false);
  assert.equal(pairing.cancel(r.id, r.secret, `tunnel:${A}`), true);
  assert.deepEqual(pairing.list(), []);
  assert.equal(pairing.decide(r.id, true, adm(A)), false);
});

test('a short match code shows on both sides, with the account\'s platform and join date', () => {
  const { pairing, pend } = setup();
  const r = pend(A, { info: { platform: 'ios', createdAt: 42 } });
  assert.match(r.matchCode, /^[A-HJ-NP-Z2-9]{4}$/);
  const [row] = pairing.list();
  assert.equal(row.matchCode, r.matchCode);
  assert.equal(row.platform, 'ios');
  assert.equal(row.addedAt, 42);
  assert.equal('secret' in row, false);
  // Without account metadata the prompt says so rather than guessing.
  pend(B);
  assert.equal(pairing.list()[1].platform, 'unknown');
  assert.equal(pairing.list()[1].addedAt, null);
});

test('the phone name is clamped before anyone sees it', () => {
  const { pairing, ask } = setup();
  ask(A, { name: `\u0007Evil\nPhone${'x'.repeat(100)}` });
  const [p] = pairing.list();
  assert.ok(p.name.length <= 32);
  assert.doesNotMatch(p.name, /[\u0000-\u001f]/);
});

test('subscribers hear about new and resolved requests', () => {
  const { pairing, pend, adm } = setup();
  let calls = 0;
  const off = pairing.onChange(() => { calls += 1; });
  pairing.decide(pend(A).id, true, adm(A));
  assert.equal(calls, 2);
  off();
  pend(B);
  assert.equal(calls, 2);
});

test('every outcome is audited; 403s are sampled so a flood cannot fill the disk', () => {
  const { pairing, ask, pend, adm, audit, advance } = setup();
  for (let i = 0; i < 50; i++) ask('e'.repeat(64));
  assert.equal(audit.filter((l) => /refused 403/.test(l)).length, 1);
  advance(ACCOUNT_PAIR_DEFAULTS.refusalAuditMs);
  ask('e'.repeat(64));
  const lines = audit.filter((l) => /refused 403/.test(l));
  assert.equal(lines.length, 2);
  assert.match(lines[1], /49 more/);
  ask(A, { deviceCount: 0, trustUntil: T0 + FIRST_PHONE_WINDOW_MS + ACCOUNT_PAIR_DEFAULTS.refusalAuditMs });
  pairing.decide(pend(B).id, false, adm(B));
  assert.ok(audit.some((l) => /first phone/.test(l)));
  assert.ok(audit.some((l) => /pending/.test(l)));
  assert.ok(audit.some((l) => /denied/.test(l)));
});

test('/health pairing facts: none over the tunnel, `paired` only on LAN, counts only for loopback', async () => {
  const { healthPairingFacts } = await import('../src/account-pair.js');
  assert.deepEqual(healthPairingFacts(`tunnel:${A}`, 2), {});
  assert.deepEqual(healthPairingFacts('192.168.1.9', 2), { paired: true });
  assert.deepEqual(healthPairingFacts('::ffff:192.168.1.9', 0), { paired: false });
  assert.deepEqual(healthPairingFacts('127.0.0.1', 2), { paired: true, devices: 2 });
  assert.deepEqual(healthPairingFacts('::ffff:127.0.0.1', 0), { paired: false, devices: 0 });
  assert.deepEqual(healthPairingFacts(undefined, 2), {});
});
