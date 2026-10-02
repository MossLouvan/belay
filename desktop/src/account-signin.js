// Sign in on this computer to link it to a Belay account — no QR, no phone.
//
// Every path ends in a user session from the accounts API. The caller hands
// that session to the host ONCE (host.js → server/src/host-claim.ts
// linkWithSession, which calls POST /hosts/link) and drops it: it is never
// written to disk and never reaches the renderer. The computer keeps only the
// host credential the host stores at 0600.
//
// Email code works with no setup. Apple and Google go through the system
// browser — no SDK:
//  * Google: OAuth "Desktop app" client, authorization code + PKCE, redirect
//    to a one-shot 127.0.0.1 listener, id_token from the token endpoint.
//  * Apple: a Services ID can only redirect to https, so Apple sends the
//    id_token (fragment) to gobelay.com/auth/desktop-callback, which forwards
//    it to the loopback port carried in `state` (desktop/oauth/).
// Both only show when configured (SIGN_IN below or BELAY_* env); setup steps
// are in desktop/README.md.

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

export const DEFAULT_ACCOUNTS_URL = 'https://api.gobelay.com/v1';
const LOOPBACK_TIMEOUT_MS = 5 * 60_000;

/** Fill these in to ship Apple/Google sign-in (not secrets: see desktop/README.md). */
export const SIGN_IN = Object.freeze({
  googleClientId: '',
  // A Google "Desktop app" client's secret ships inside every copy of the app
  // by design; Google does not treat it as confidential. PKCE protects the code.
  googleClientSecret: '',
  appleServicesId: '',
  appleRedirectUrl: 'https://gobelay.com/auth/desktop-callback',
});

export function signInConfig(env = process.env, defaults = SIGN_IN) {
  return {
    googleClientId: env.BELAY_GOOGLE_CLIENT_ID ?? defaults.googleClientId,
    googleClientSecret: env.BELAY_GOOGLE_CLIENT_SECRET ?? defaults.googleClientSecret,
    appleServicesId: env.BELAY_APPLE_SERVICES_ID ?? defaults.appleServicesId,
    appleRedirectUrl: env.BELAY_APPLE_REDIRECT_URL ?? defaults.appleRedirectUrl,
  };
}

export function providers(config) {
  return {
    apple: Boolean(config.appleServicesId) && /^https:\/\//.test(config.appleRedirectUrl ?? ''),
    google: Boolean(config.googleClientId && config.googleClientSecret),
  };
}

/** Same knob as the host (server/src/accounts-client.ts accountsUrl). */
export function accountsBase(env = process.env) {
  return (env.BELAY_ACCOUNTS_URL || env.TETHER_ACCOUNTS_URL || DEFAULT_ACCOUNTS_URL).replace(/\/+$/, '');
}

const FRIENDLY = {
  invalid_code: 'That code is not right. Check the email and try again.',
  code_expired: 'That code expired. Send a new one.',
  too_many_attempts: 'Too many wrong codes. Send a new one.',
  rate_limited: 'Too many tries. Wait a few minutes and try again.',
};

async function api(fetchImpl, url, body) {
  const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* reported below */ }
  if (!res.ok) throw new Error(FRIENDLY[json?.code] ?? (typeof json?.error === 'string' ? json.error : `Belay accounts answered HTTP ${res.status}`));
  return json;
}

const SESSION_RE = /^[A-Za-z0-9_-]{20,128}$/;
const sessionFrom = (json) => {
  if (typeof json?.session !== 'string' || !SESSION_RE.test(json.session)) throw new Error('Sign-in did not return a usable session.');
  return json.session;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const cleanEmail = (email) => {
  const e = String(email ?? '').trim().toLowerCase();
  if (e.length > 254 || !EMAIL_RE.test(e)) throw new Error('Enter a valid email address.');
  return e;
};

export async function emailStart(base, email, fetchImpl = fetch) {
  await api(fetchImpl, `${base}/auth/email/start`, { email: cleanEmail(email) });
}

export async function emailVerify(base, email, code, fetchImpl = fetch) {
  const e = cleanEmail(email);
  const c = String(code ?? '').trim();
  if (!/^\d{6}$/.test(c)) throw new Error('Enter the 6-digit code from the email.');
  return sessionFrom(await api(fetchImpl, `${base}/auth/email/verify`, { email: e, code: c }));
}

// ---- system browser + loopback ----------------------------------------------

const b64url = (buf) => buf.toString('base64url');
const randomToken = () => b64url(randomBytes(32));

export function googleAuthUrl({ clientId, redirectUri, state, challenge }) {
  const q = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid email',
    state, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

export function appleAuthUrl({ servicesId, redirectUri, state, nonceHash }) {
  // No scope: Apple then allows response_mode=fragment (scopes force form_post,
  // which a static page cannot read). Accounts match on Apple's team-scoped
  // `sub`, the same one the iPhone app gets.
  const q = new URLSearchParams({
    client_id: servicesId, redirect_uri: redirectUri, response_type: 'code id_token', response_mode: 'fragment', state, nonce: nonceHash,
  });
  return `https://appleid.apple.com/auth/authorize?${q}`;
}

const DONE_PAGE = '<!doctype html><meta charset="utf-8"><title>Belay</title><body style="font:16px -apple-system,sans-serif;padding:3em;text-align:center">'
  + '<p>Signed in. You can close this tab and go back to Belay.</p>';

/**
 * A one-shot listener on 127.0.0.1 (random port) for the browser redirect.
 * `state` may depend on the port (Apple's relay page reads the port from it).
 * Resolves with the query of the first request on `path` carrying that state.
 */
export function loopbackCallback({ path, state, timeoutMs = LOOPBACK_TIMEOUT_MS }) {
  return new Promise((ready, fail) => {
    let settle;
    const params = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    params.catch(() => {}); // the caller awaits it; never an unhandled rejection meanwhile
    let expected = '';
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method !== 'GET' || url.pathname !== path) { res.writeHead(404).end(); return; }
      if (url.searchParams.get('state') !== expected) { res.writeHead(400).end('Sign-in state did not match. Start again from Belay.'); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', connection: 'close' }).end(DONE_PAGE);
      const error = url.searchParams.get('error');
      finish(error ? new Error(`Sign-in was cancelled (${error.slice(0, 64)}).`) : null, url.searchParams);
    });
    const timer = setTimeout(() => finish(new Error('Sign-in timed out. Try again.')), timeoutMs);
    const finish = (err, value) => {
      clearTimeout(timer);
      server.close();
      server.closeAllConnections?.();
      if (err) settle.reject(err); else settle.resolve(value);
    };
    server.on('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      expected = typeof state === 'function' ? state(port) : state;
      ready({ port, state: expected, params });
    });
  });
}

/** Google: returns a session. `openUrl` opens the system browser (shell.openExternal). */
export async function googleSignIn({ config, base, openUrl, fetchImpl = fetch, timeoutMs }) {
  const verifier = randomToken();
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const cb = await loopbackCallback({ path: '/google', state: randomToken(), timeoutMs });
  const redirectUri = `http://127.0.0.1:${cb.port}/google`;
  await openUrl(googleAuthUrl({ clientId: config.googleClientId, redirectUri, state: cb.state, challenge }));
  const code = (await cb.params).get('code');
  if (!code) throw new Error('Google did not return a sign-in code.');
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: config.googleClientId, client_secret: config.googleClientSecret,
      code_verifier: verifier, redirect_uri: redirectUri, grant_type: 'authorization_code',
    }).toString(),
  });
  const token = await res.json().catch(() => null);
  if (!res.ok || typeof token?.id_token !== 'string') throw new Error('Google sign-in failed. Try again.');
  return sessionFrom(await api(fetchImpl, `${base}/auth/google`, { idToken: token.id_token }));
}

/** Apple: returns a session. Needs the relay page at config.appleRedirectUrl. */
export async function appleSignIn({ config, base, openUrl, fetchImpl = fetch, timeoutMs }) {
  const { nonce } = await api(fetchImpl, `${base}/auth/nonce`, {});
  if (typeof nonce !== 'string' || !nonce) throw new Error('Sign-in could not start. Try again.');
  const nonceHash = createHash('sha256').update(nonce).digest('hex');
  const cb = await loopbackCallback({ path: '/apple', state: (port) => `${port}.${randomToken()}`, timeoutMs });
  await openUrl(appleAuthUrl({ servicesId: config.appleServicesId, redirectUri: config.appleRedirectUrl, state: cb.state, nonceHash }));
  const idToken = (await cb.params).get('id_token');
  if (!idToken) throw new Error('Apple did not return a sign-in token.');
  return sessionFrom(await api(fetchImpl, `${base}/auth/apple`, { identityToken: idToken, nonce }));
}
