import { handle } from '../src/index.js';
import type { Env } from '../src/env.js';
import { fakeD1 } from './fake-d1.js';

export interface CallOptions {
  readonly body?: unknown;
  readonly token?: string;
  readonly headers?: Record<string, string>;
  readonly ip?: string;
}

export function app(overrides: Partial<Env> = {}) {
  const env: Env = {
    DB: fakeD1(),
    APPLE_AUDIENCE: 'com.mosslouvan.belay',
    GOOGLE_AUDIENCES: 'web.apps.googleusercontent.com, ios.apps.googleusercontent.com',
    EMAIL_FROM: 'Belay <sign-in@gobelay.com>',
    RELAY_URLS: 'https://relay-1.example, https://relay-2.example',
    RESEND_API_KEY: 'test-key',
    ...overrides,
  };

  const call = async (method: string, path: string, opts: CallOptions = {}) => {
    const headers: Record<string, string> = {
      'cf-connecting-ip': opts.ip ?? '203.0.113.1',
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...opts.headers,
    };
    const req = new Request(`https://api.gobelay.com${path}`, {
      method,
      headers,
      body: opts.body !== undefined ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : undefined,
    });
    const res = await handle(req, env);
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  return { env, call };
}

/** Replaces global fetch, capturing Resend sends; returns the sent codes. */
export function mockResend(status = 200): { codes: string[]; restore: () => void } {
  const codes: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('https://api.resend.com/')) throw new Error(`unexpected fetch ${url}`);
    const sent = JSON.parse(String(init?.body)) as { subject: string };
    codes.push(sent.subject.slice(0, 6));
    return new Response(status === 200 ? '{"id":"x"}' : 'nope', { status });
  }) as typeof fetch;
  return { codes, restore: () => (globalThis.fetch = original) };
}

/** Signs in via email and returns the session token. */
export async function signIn(a: ReturnType<typeof app>, email = 'user@example.com'): Promise<string> {
  const resend = mockResend();
  try {
    await a.call('POST', '/v1/auth/email/start', { body: { email } });
    const res = await a.call('POST', '/v1/auth/email/verify', { body: { email, code: resend.codes[0] } });
    if (res.status !== 200) throw new Error(`sign-in failed: ${JSON.stringify(res)}`);
    return res.body.session as string;
  } finally {
    resend.restore();
  }
}
