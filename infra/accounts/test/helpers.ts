import { handle } from '../src/index.js';
import { base64url } from '../src/crypto.js';
import type { Env } from '../src/env.js';
import { claimMessage } from '../src/routes/claims.js';
import { fakeD1 } from './fake-d1.js';

// No test reaches the network: Resend calls made outside mockResend() are
// swallowed (the security-email paths fire on many routes), anything else throws.
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith('https://api.resend.com/')) return new Response('{"id":"x"}');
  throw new Error(`unexpected fetch ${url}`);
}) as typeof fetch;

export interface CallOptions {
  readonly body?: unknown;
  readonly token?: string;
  readonly headers?: Record<string, string>;
  readonly ip?: string;
  /** Cloudflare's request.cf (city/country), absent in Node unless set here. */
  readonly cf?: Record<string, string>;
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
    if (opts.cf) Object.defineProperty(req, 'cf', { value: opts.cf });
    const res = await handle(req, env);
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  return { env, call };
}

export interface SentEmail {
  readonly to: string[];
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
}

/**
 * Replaces global fetch, capturing Resend sends. `codes` are the sign-in
 * codes only; `alerts` are the security emails; `sent` is everything.
 * `status` 0 makes fetch itself throw (network failure).
 */
export function mockResend(status = 200): { codes: string[]; alerts: SentEmail[]; sent: SentEmail[]; restore: () => void } {
  const codes: string[] = [];
  const alerts: SentEmail[] = [];
  const sent: SentEmail[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('https://api.resend.com/')) throw new Error(`unexpected fetch ${url}`);
    const mail = JSON.parse(String(init?.body)) as SentEmail;
    sent.push(mail);
    if (/^\d{6} is your Belay sign-in code$/.test(mail.subject)) codes.push(mail.subject.slice(0, 6));
    else alerts.push(mail);
    if (status === 0) throw new TypeError('network down');
    return new Response(status === 200 ? '{"id":"x"}' : 'nope', { status });
  }) as typeof fetch;
  return { codes, alerts, sent, restore: () => (globalThis.fetch = original) };
}

/** An iroh-style node: Ed25519 keypair, nodeId = 64 lowercase hex chars. */
export interface Node {
  readonly nodeId: string;
  sign(message: string): Promise<string>;
}

export async function makeNode(): Promise<Node> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return {
    nodeId: [...raw].map((b) => b.toString(16).padStart(2, '0')).join(''),
    async sign(message) {
      const sig = await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, new TextEncoder().encode(message));
      return base64url(new Uint8Array(sig));
    },
  };
}

/** A valid POST /claims body for `node`. */
export async function claimBody(node: Node, overrides: Record<string, unknown> = {}) {
  const ts = Math.floor(Date.now() / 1000);
  return { nodeId: node.nodeId, name: 'Moss MacBook', platform: 'macos', ts, sig: await node.sign(claimMessage(node.nodeId, ts)), ...overrides };
}

/** Any syntactically valid phone nodeId. */
export const phoneNodeId = (seed = 'a'): string => seed.charCodeAt(0).toString(16).padStart(2, '0').repeat(32);

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
