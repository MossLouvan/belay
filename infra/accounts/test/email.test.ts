import { test } from 'node:test';
import assert from 'node:assert/strict';

import { app, mockResend } from './helpers.js';

const EMAIL = 'someone@example.com';

test('start sends a 6-digit code and verify returns a session', async () => {
  const a = app();
  const resend = mockResend();
  try {
    assert.equal((await a.call('POST', '/v1/auth/email/start', { body: { email: 'Someone@Example.com' } })).status, 204);
    assert.match(resend.codes[0], /^\d{6}$/);

    const res = await a.call('POST', '/v1/auth/email/verify', { body: { email: EMAIL, code: resend.codes[0] } });
    assert.equal(res.status, 200);
    assert.match(res.body.session, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(res.body.account.email, EMAIL);

    // the code is single-use
    assert.equal((await a.call('POST', '/v1/auth/email/verify', { body: { email: EMAIL, code: resend.codes[0] } })).status, 401);
    // the session is stored hashed
    const row = await a.env.DB.prepare('SELECT hash FROM sessions').first<{ hash: string }>();
    assert.notEqual(row?.hash, res.body.session);
    assert.match(row!.hash, /^[0-9a-f]{64}$/);
  } finally {
    resend.restore();
  }
});

test('wrong code 5 times locks the code', async () => {
  const a = app();
  const resend = mockResend();
  try {
    await a.call('POST', '/v1/auth/email/start', { body: { email: EMAIL } });
    const wrong = resend.codes[0] === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      assert.equal((await a.call('POST', '/v1/auth/email/verify', { body: { email: EMAIL, code: wrong } })).body.code, 'invalid_code');
    }
    const locked = await a.call('POST', '/v1/auth/email/verify', { body: { email: EMAIL, code: resend.codes[0] } });
    assert.equal(locked.body.code, 'too_many_attempts');
  } finally {
    resend.restore();
  }
});

test('an expired code is refused', async () => {
  const a = app();
  const resend = mockResend();
  try {
    await a.call('POST', '/v1/auth/email/start', { body: { email: EMAIL } });
    await a.env.DB.prepare('UPDATE email_codes SET expires_at = ?1').bind(Date.now() - 1).run();
    const res = await a.call('POST', '/v1/auth/email/verify', { body: { email: EMAIL, code: resend.codes[0] } });
    assert.deepEqual(res, { status: 401, body: { error: 'code expired, request a new one', code: 'code_expired' } });
  } finally {
    resend.restore();
  }
});

test('reviewer allow-list uses the fixed code and sends no email', async () => {
  const a = app({ REVIEW_EMAIL: 'Reviewer@Apple.com', REVIEW_CODE: '424242' });
  const resend = mockResend();
  try {
    assert.equal((await a.call('POST', '/v1/auth/email/start', { body: { email: 'reviewer@apple.com' } })).status, 204);
    assert.equal(resend.codes.length, 0);
    assert.equal((await a.call('POST', '/v1/auth/email/verify', { body: { email: 'reviewer@apple.com', code: '000000' } })).status, 401);
    assert.equal((await a.call('POST', '/v1/auth/email/verify', { body: { email: 'reviewer@apple.com', code: '424242' } })).status, 200);
  } finally {
    resend.restore();
  }
});

test('input validation and Resend failure', async () => {
  const a = app();
  assert.equal((await a.call('POST', '/v1/auth/email/start', { body: { email: 'not-an-email' } })).body.code, 'bad_request');
  assert.equal((await a.call('POST', '/v1/auth/email/start', { body: 'junk' })).body.code, 'bad_request');
  assert.equal((await a.call('POST', '/v1/auth/email/verify', { body: { email: EMAIL, code: '12' } })).body.code, 'bad_request');

  const resend = mockResend(500);
  try {
    const res = await a.call('POST', '/v1/auth/email/start', { body: { email: EMAIL } });
    assert.equal(res.status, 502);
    assert.equal(res.body.code, 'email_send_failed');
  } finally {
    resend.restore();
  }
});

test('rate limits per email and per ip', async () => {
  const a = app();
  const resend = mockResend();
  try {
    for (let i = 0; i < 5; i++) assert.equal((await a.call('POST', '/v1/auth/email/start', { body: { email: EMAIL } })).status, 204);
    assert.equal((await a.call('POST', '/v1/auth/email/start', { body: { email: EMAIL } })).status, 429);
    assert.equal((await a.call('POST', '/v1/auth/email/start', { body: { email: 'other@example.com' } })).status, 204);

    const claim = { nodeId: 'abc123', name: 'Mac', platform: 'macos' };
    for (let i = 0; i < 60; i++) assert.equal((await a.call('POST', '/v1/claims', { body: claim, ip: '198.51.100.9' })).status, 200);
    assert.equal((await a.call('POST', '/v1/claims', { body: claim, ip: '198.51.100.9' })).status, 429);
    const res = await a.call('POST', '/v1/auth/email/start', { body: { email: 'third@example.com' }, ip: '198.51.100.9' });
    assert.equal(res.status, 429);
  } finally {
    resend.restore();
  }
});
