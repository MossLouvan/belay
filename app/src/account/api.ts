// Client for the Belay accounts service.
//
// The contract is the Accounts API table in
// openspec/changes/belay-network/design.md; the service itself is built in
// parallel, so this file codes against the table and api.test.mjs mocks fetch.
// Errors arrive as `{error, code}`; they leave here as AccountsError with a
// message a person can act on, never the raw server text when a code is known.
//
// Pure module: no React, no storage. The session is injected so the client is
// testable under node and the session store (session.ts) stays the one owner.

export const DEFAULT_ACCOUNTS_URL = 'https://api.gobelay.com/v1';

/** Longer than the host's 10 s: the API sits on the public internet. */
const REQUEST_TIMEOUT_MS = 15_000;

export interface Account {
  readonly id: string;
  readonly email: string | null;
  /** ISO date. */
  readonly createdAt?: string;
}

export interface AccountDevice {
  readonly id: string;
  /** 'phone' for a registered phone; anything else is a computer. */
  readonly kind: string;
  readonly name: string;
  readonly platform: string;
  readonly nodeId: string;
  readonly lastSeenAt: string | null;
}

export interface SessionResult {
  readonly session: string;
  readonly account: Account;
}

export class AccountsError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = 'AccountsError';
    this.code = code;
    this.status = status;
  }
}

const MESSAGES: Readonly<Record<string, string>> = {
  invalid_code: 'That code is not right. Check the email and try again.',
  code_expired: 'That code has expired. Ask for a new code.',
  too_many_attempts: 'Too many tries for that code. Ask for a new code.',
  rate_limited: 'Too many requests. Wait a moment and try again.',
  invalid_email: 'That does not look like an email address.',
  unauthorized: 'Your session has ended. Sign in again.',
  no_session: 'Sign in to continue.',
  claim_not_found: 'That code is not one your computer is showing. Scan it again.',
  claim_expired: 'That code has expired. Restart Belay on the computer and scan again.',
  claim_claimed: 'That computer is already linked to an account.',
  invalid_token: 'Sign-in could not be verified. Try again.',
  network: 'Could not connect to Belay. Check your internet connection.',
};

const BY_STATUS: Readonly<Record<number, string>> = {
  401: MESSAGES.unauthorized,
  404: 'Belay could not find that. Try again.',
  429: MESSAGES.rate_limited,
};

/** The message for a server code, falling back on the status, then the server's text. */
export function friendlyMessage(code: string, status: number, serverText?: string): string {
  const known = MESSAGES[code] ?? BY_STATUS[status];
  if (known) return known;
  if (status >= 500) return 'Belay is temporarily unavailable. Try again in a minute.';
  return serverText || 'Something went wrong. Try again.';
}

export interface AccountsDeps {
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  /** The current session credential, or null when signed out. */
  readonly session: () => string | null;
}

export interface AccountsApi {
  startEmail(email: string): Promise<void>;
  verifyEmail(email: string, code: string): Promise<SessionResult>;
  signInApple(identityToken: string, nonce: string): Promise<SessionResult>;
  signInGoogle(idToken: string): Promise<SessionResult>;
  me(): Promise<Account>;
  deleteMe(): Promise<void>;
  /** Upserts by nodeId on the server, so calling it again is harmless. */
  registerPhone(name: string, nodeId: string, platform?: string): Promise<AccountDevice>;
  listDevices(): Promise<readonly AccountDevice[]>;
  removeDevice(id: string): Promise<void>;
  acceptClaim(code: string): Promise<AccountDevice>;
}

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/** Claim codes are base32 (A-Z, 2-7), shown upper-case; tolerate what a person types. */
export const normalizeClaimCode = (code: string): string => code.replace(/[\s-]/g, '').toUpperCase();

export function createAccountsApi(deps: AccountsDeps): AccountsApi {
  const baseUrl = (deps.baseUrl ?? DEFAULT_ACCOUNTS_URL).replace(/\/+$/, '');

  async function call<T>(method: string, path: string, opts: { body?: unknown; auth?: boolean } = {}): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (opts.auth) {
      const session = deps.session();
      if (!session) throw new AccountsError('no_session', 0, MESSAGES.no_session);
      headers.authorization = `Bearer ${session}`;
    }
    if (opts.body !== undefined) headers['content-type'] = 'application/json';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      // Resolved per call, so a test (or a dev stub) that replaces global fetch is seen.
      res = await (deps.fetch ?? globalThis.fetch)(`${baseUrl}${path}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
      });
    } catch {
      throw new AccountsError('network', 0, MESSAGES.network);
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 204) return undefined as T;
    const json = await res.json().catch(() => null) as Record<string, unknown> | null;
    if (!res.ok) {
      const code = res.status === 401 ? 'unauthorized' : typeof json?.code === 'string' ? json.code : `http_${res.status}`;
      const serverText = typeof json?.error === 'string' ? json.error : undefined;
      throw new AccountsError(code, res.status, friendlyMessage(code, res.status, serverText));
    }
    if (json === null) throw new AccountsError('bad_response', res.status, friendlyMessage('bad_response', 502));
    return json as T;
  }

  return {
    startEmail: (email) => call('POST', '/auth/email/start', { body: { email: normalizeEmail(email) } }),
    verifyEmail: (email, code) => call('POST', '/auth/email/verify', { body: { email: normalizeEmail(email), code } }),
    signInApple: (identityToken, nonce) => call('POST', '/auth/apple', { body: { identityToken, nonce } }),
    signInGoogle: (idToken) => call('POST', '/auth/google', { body: { idToken } }),
    me: async () => (await call<{ account: Account }>('GET', '/me', { auth: true })).account,
    deleteMe: () => call('DELETE', '/me', { auth: true }),
    registerPhone: async (name, nodeId, platform) =>
      (await call<{ device: AccountDevice }>('POST', '/devices', { auth: true, body: { kind: 'phone', name, nodeId, ...(platform ? { platform } : {}) } })).device,
    listDevices: async () => (await call<{ devices: AccountDevice[] }>('GET', '/devices', { auth: true })).devices ?? [],
    removeDevice: (id) => call('DELETE', `/devices/${encodeURIComponent(id)}`, { auth: true }),
    acceptClaim: async (code) =>
      (await call<{ device: AccountDevice }>('POST', `/claims/${encodeURIComponent(normalizeClaimCode(code))}/accept`, { auth: true })).device,
  };
}
