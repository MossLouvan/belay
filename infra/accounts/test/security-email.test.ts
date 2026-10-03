// Security alert emails: who gets one, when, rate limits, the opt-out,
// POST /hosts/events and POST /me/sessions/revoke-all.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { app, claimBody, makeNode, mockResend, phoneNodeId, signIn, type SentEmail } from './helpers.js';

const EMAIL = 'user@example.com';
const SECURITY_URL = 'https://gobelay.com/security';

/** Signs in while capturing every email, returning the session and the alerts. */
async function signInCapturing(a: ReturnType<typeof app>, opts: { cf?: Record<string, string>; email?: string } = {}) {
  const email = opts.email ?? EMAIL;
  const resend = mockResend();
  try {
    await a.call('POST', '/v1/auth/email/start', { body: { email } });
    const res = await a.call('POST', '/v1/auth/email/verify', { body: { email, code: resend.codes[0] }, cf: opts.cf });
    assert.equal(res.status, 200);
    return { session: res.body.session as string, alerts: resend.alerts };
  } finally {
    resend.restore();
  }
}

async function capture<T>(fn: () => Promise<T>, status = 200): Promise<{ result: T; alerts: SentEmail[] }> {
  const resend = mockResend(status);
  try {
    return { result: await fn(), alerts: resend.alerts };
  } finally {
    resend.restore();
  }
}

/** Moves every rate-limit window into the past, as if 10 minutes went by. */
const elapse = (a: ReturnType<typeof app>) => a.env.DB.prepare('UPDATE rate_limits SET window_start = window_start - 3600000').run();

test('a sign-in emails the account: what, when, how, where (cf only), text + html, Not you? link', async () => {
  const a = app();
  const { alerts } = await signInCapturing(a, { cf: { city: 'Lisbon', country: 'PT' } });
  assert.equal(alerts.length, 1);
  const [mail] = alerts;
  assert.deepEqual(mail.to, [EMAIL]);
  assert.match(mail.subject, /sign-in/i);
  assert.match(mail.text, /email code/);
  assert.match(mail.text, /Lisbon, PT/);
  assert.match(mail.text, /UTC/);
  assert.ok(mail.text.includes(SECURITY_URL));
  assert.match(mail.text, /Not you\?/);
  assert.ok(mail.html?.includes(`href="${SECURITY_URL}"`));
  assert.match(mail.html!, /Belay/);

  // Location is never stored anywhere.
  for (const table of ['accounts', 'sessions', 'rate_limits']) {
    const rows = await a.env.DB.prepare(`SELECT * FROM ${table}`).all();
    assert.ok(!JSON.stringify(rows.results).includes('Lisbon'), table);
  }
});

test('no location line without request.cf', async () => {
  const a = app();
  const { alerts } = await signInCapturing(a);
  assert.equal(alerts.length, 1);
  assert.doesNotMatch(alerts[0].text, /Location/);
});

test('sign-in alerts are limited to one per 10 minutes per account', async () => {
  const a = app();
  assert.equal((await signInCapturing(a)).alerts.length, 1);
  assert.equal((await signInCapturing(a)).alerts.length, 0);
  assert.equal((await signInCapturing(a, { email: 'other@example.com' })).alerts.length, 1);
  await elapse(a);
  assert.equal((await signInCapturing(a)).alerts.length, 1);
});

test('PATCH /me turns security emails off and on; GET /me reports it', async () => {
  const a = app();
  const token = await signIn(a);
  assert.equal((await a.call('GET', '/v1/me', { token })).body.account.securityEmails, true);
  assert.equal((await a.call('PATCH', '/v1/me', { body: { securityEmails: false } })).status, 401);
  assert.equal((await a.call('PATCH', '/v1/me', { token, body: { securityEmails: 'no' } })).body.code, 'bad_request');
  assert.equal((await a.call('PATCH', '/v1/me', { token, body: {} })).body.code, 'bad_request');

  // Turning them off is itself announced (a stolen session must not switch them off silently).
  const { result: off, alerts: offAlerts } = await capture(() => a.call('PATCH', '/v1/me', { token, body: { securityEmails: false } }));
  assert.equal(off.status, 200);
  assert.equal(off.body.account.securityEmails, false);
  assert.equal(offAlerts.length, 1);
  assert.match(offAlerts[0].subject, /turned off/);
  const again = await capture(() => a.call('PATCH', '/v1/me', { token, body: { securityEmails: false } }));
  assert.equal(again.alerts.length, 0, 'already off: nothing new to announce');
  await elapse(a);
  assert.equal((await signInCapturing(a)).alerts.length, 0);
  const phone = await capture(() => a.call('POST', '/v1/devices', { token, body: { kind: 'phone', name: 'iPhone', nodeId: phoneNodeId() } }));
  assert.equal(phone.alerts.length, 0);

  assert.equal((await a.call('PATCH', '/v1/me', { token, body: { securityEmails: true } })).body.account.securityEmails, true);
  assert.equal((await signInCapturing(a)).alerts.length, 1);
});

test('a new phone emails once; re-registering the same nodeId does not', async () => {
  const a = app();
  const token = await signIn(a);
  const body = { kind: 'phone', name: 'Moss iPhone', nodeId: phoneNodeId(), platform: 'ios' };
  const first = await capture(() => a.call('POST', '/v1/devices', { token, body }));
  assert.equal(first.alerts.length, 1);
  assert.match(first.alerts[0].subject, /phone/i);
  assert.match(first.alerts[0].text, /Moss iPhone \(iOS\)/);
  assert.ok(first.alerts[0].text.includes(SECURITY_URL));

  const again = await capture(() => a.call('POST', '/v1/devices', { token, body: { ...body, name: 'Renamed' } }));
  assert.equal(again.alerts.length, 0);
});

test('a computer linked by claim accept or /hosts/link emails the account', async () => {
  const a = app();
  const token = await signIn(a);
  const claim = (await a.call('POST', '/v1/claims', { body: await claimBody(await makeNode()) })).body;
  const accepted = await capture(() => a.call('POST', `/v1/claims/${claim.claimCode}/accept`, { token }));
  assert.equal(accepted.result.status, 200);
  assert.equal(accepted.alerts.length, 1);
  assert.match(accepted.alerts[0].subject, /computer/i);
  assert.match(accepted.alerts[0].text, /Moss MacBook \(macOS\)/);

  const linked = await capture(async () => a.call('POST', '/v1/hosts/link', { token, body: await claimBody(await makeNode(), { name: 'Studio PC', platform: 'windows' }) }));
  assert.equal(linked.result.status, 200);
  assert.equal(linked.alerts.length, 1);
  assert.match(linked.alerts[0].text, /Studio PC \(Windows\)/);
});

test('accounts without an email get nothing; Apple private relay addresses are emailed', async () => {
  const a = app();
  const now = Date.now();
  await a.env.DB.prepare('INSERT INTO accounts (id, email, created_at) VALUES (?1, NULL, ?2)').bind('no-mail', now).run();
  const { createSession } = await import('../src/auth.js');
  const hidden = await createSession(a.env.DB, 'no-mail');
  const quiet = await capture(() => a.call('POST', '/v1/devices', { token: hidden, body: { kind: 'phone', name: 'iPhone', nodeId: phoneNodeId() } }));
  assert.equal(quiet.result.status, 200);
  assert.equal(quiet.alerts.length, 0);

  await a.env.DB.prepare('INSERT INTO accounts (id, email, created_at) VALUES (?1, ?2, ?3)').bind('relay', 'x1@privaterelay.appleid.com', now).run();
  const relay = await createSession(a.env.DB, 'relay');
  const sent = await capture(() => a.call('POST', '/v1/devices', { token: relay, body: { kind: 'phone', name: 'iPhone', nodeId: phoneNodeId() } }));
  assert.deepEqual(sent.alerts.map((m) => m.to), [['x1@privaterelay.appleid.com']]);
});

test('a failed or unreachable Resend never blocks the action', async () => {
  for (const status of [500, 0]) {
    const a = app();
    const token = await signIn(a);
    const { result, alerts } = await capture(() => a.call('POST', '/v1/devices', { token, body: { kind: 'phone', name: 'iPhone', nodeId: phoneNodeId() } }), status);
    assert.equal(result.status, 200);
    assert.equal(alerts.length, 1, 'the send was attempted');
  }

  // and the sign-in itself still answers when only the alert fails
  const a = app();
  const resend = mockResend();
  try {
    await a.call('POST', '/v1/auth/email/start', { body: { email: EMAIL } });
  } finally {
    resend.restore();
  }
  const failing = mockResend(500);
  try {
    const res = await a.call('POST', '/v1/auth/email/verify', { body: { email: EMAIL, code: resend.codes[0] } });
    assert.equal(res.status, 200);
  } finally {
    failing.restore();
  }
});

test('user-chosen names are escaped in the html part and stripped of control characters', async () => {
  const a = app();
  const token = await signIn(a);
  const { alerts } = await capture(() =>
    a.call('POST', '/v1/devices', { token, body: { kind: 'phone', name: '<img src=x onerror=alert(1)>\nEvil', nodeId: phoneNodeId() } }),
  );
  assert.ok(!alerts[0].html!.includes('<img'));
  assert.ok(alerts[0].html!.includes('&lt;img'));
  assert.ok(!alerts[0].text.includes('\nEvil'));
});

async function linkedHost(a: ReturnType<typeof app>, token: string, name = 'Moss MacBook') {
  const linked = await a.call('POST', '/v1/hosts/link', { token, body: await claimBody(await makeNode(), { name }) });
  assert.equal(linked.status, 200);
  return linked.body.hostCredential as string;
}

test('POST /hosts/events needs a host credential and a well-formed phone-request', async () => {
  const a = app();
  const token = await signIn(a);
  const cred = await linkedHost(a, token);
  const good = { type: 'phone-request', phoneName: 'Pixel', matchCode: 'K7QX' };

  assert.equal((await a.call('POST', '/v1/hosts/events', { body: good })).status, 401);
  assert.equal((await a.call('POST', '/v1/hosts/events', { token: 'nope', body: good })).status, 401);
  assert.equal((await a.call('POST', '/v1/hosts/events', { token, body: good })).status, 401); // a session is not a host credential
  const bad = async (body: unknown) => assert.equal((await a.call('POST', '/v1/hosts/events', { token: cred, body })).body.code, 'bad_request');
  await bad({ ...good, type: 'other' });
  await bad({ ...good, matchCode: 'k7qx!' });
  await bad({ ...good, matchCode: 'TOOLONG' });
  await bad({ type: 'phone-request', matchCode: 'K7QX' });
  await bad({ ...good, phoneName: 'x'.repeat(101) });
});

test('a phone-request event emails the owner, limited per host', async () => {
  const a = app();
  const token = await signIn(a);
  const mac = await linkedHost(a, token);
  const pc = await linkedHost(a, token, 'Gaming PC');
  const event = { type: 'phone-request', phoneName: 'Pixel 9', matchCode: 'K7QX' };

  const first = await capture(() => a.call('POST', '/v1/hosts/events', { token: mac, body: event, cf: { city: 'Lisbon', country: 'PT' } }));
  assert.equal(first.result.status, 204);
  assert.equal(first.alerts.length, 1);
  assert.equal(first.alerts[0].subject, 'A new phone asked to control your Mac');
  assert.match(first.alerts[0].text, /Pixel 9/);
  assert.match(first.alerts[0].text, /Moss MacBook/);
  assert.match(first.alerts[0].text, /K7QX/);
  assert.ok(first.alerts[0].text.includes(SECURITY_URL));
  assert.doesNotMatch(first.alerts[0].text, /Lisbon/, "the computer's location is not the phone's");

  const second = await capture(() => a.call('POST', '/v1/hosts/events', { token: mac, body: event }));
  assert.equal(second.result.status, 204);
  assert.equal(second.alerts.length, 0);

  const other = await capture(() => a.call('POST', '/v1/hosts/events', { token: pc, body: event }));
  assert.equal(other.alerts.length, 1);

  await a.call('PATCH', '/v1/me', { token, body: { securityEmails: false } });
  await elapse(a);
  const off = await capture(() => a.call('POST', '/v1/hosts/events', { token: mac, body: event }));
  assert.equal(off.result.status, 204);
  assert.equal(off.alerts.length, 0);
});

test('POST /me/sessions/revoke-all signs out every session but leaves computers linked', async () => {
  const a = app();
  const t1 = await signIn(a);
  const t2 = await signIn(a);
  const other = await signIn(a, 'other@example.com');
  const cred = await linkedHost(a, t1);

  assert.equal((await a.call('POST', '/v1/me/sessions/revoke-all')).status, 401);
  assert.equal((await a.call('POST', '/v1/me/sessions/revoke-all', { token: t2, body: {} })).status, 204);
  assert.equal((await a.call('GET', '/v1/me', { token: t1 })).status, 401);
  assert.equal((await a.call('GET', '/v1/me', { token: t2 })).status, 401);
  assert.equal((await a.call('GET', '/v1/me', { token: other })).status, 200);
  assert.equal((await a.call('POST', '/v1/hosts/heartbeat', { token: cred, body: {} })).status, 200);
});
