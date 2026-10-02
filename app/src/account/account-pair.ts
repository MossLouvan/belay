// Account trust, the phone half (server/src/account-pair.ts is the host's).
// A computer linked to this account is reached over the tunnel, and then:
// the first phone is paired at once; any later one waits for ONE tap on
// Belay.app or on a phone that is already paired. No code either way.
//
// Plain fetch, no react-native, so account-pair.test.mjs runs it in node.

import { fetchWithTimeout, readPairResult } from '../api.ts';
import type { PairResult } from '../api.ts';

export type JoinStart =
  | { readonly kind: 'paired'; readonly result: PairResult }
  | { readonly kind: 'pending'; readonly pendingId: string }
  /** Not an account-trust host, or not this account's: use the code instead. */
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'error'; readonly message: string };

export type JoinEnd =
  | { readonly kind: 'paired'; readonly result: PairResult }
  | { readonly kind: 'denied' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'cancelled' };

/** How often the waiting phone asks whether it was let in. */
export const APPROVAL_POLL_MS = 2000;

const json = async (res: Response): Promise<Record<string, unknown>> =>
  ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;

export async function askToJoin(host: string, deviceName: string): Promise<JoinStart> {
  const path = '/pair/account';
  const res = await fetchWithTimeout(host + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceName }),
  }, path);
  const j = await json(res);
  if (res.status === 200) return { kind: 'paired', result: readPairResult(host, j) };
  if (res.status === 202 && typeof j.pendingId === 'string') return { kind: 'pending', pendingId: j.pendingId };
  if (res.status === 403 || res.status === 404) return { kind: 'unsupported' };
  return { kind: 'error', message: typeof j.error === 'string' ? j.error : `the computer answered ${res.status}` };
}

export interface WaitOptions {
  readonly signal?: AbortSignal;
  readonly sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll until the owner taps, the request lapses, or `signal` aborts (Cancel). */
export async function waitForApproval(host: string, pendingId: string, opts: WaitOptions = {}): Promise<JoinEnd> {
  const sleep = opts.sleep ?? realSleep;
  const path = `/pair/account/${encodeURIComponent(pendingId)}`;
  while (!opts.signal?.aborted) {
    try {
      const res = await fetchWithTimeout(host + path, { method: 'GET' }, path, opts.signal);
      const j = await json(res);
      if (res.status === 200 && j.status === 'approved') return { kind: 'paired', result: readPairResult(host, j) };
      if (res.status === 403) return { kind: 'denied' };
      if (res.status === 404) return { kind: 'expired' };
    } catch {
      // A dropped poll over a flaky tunnel is not an answer; ask again.
    }
    await sleep(APPROVAL_POLL_MS);
  }
  // Withdraw it, so the owner is not asked about a phone that gave up.
  await fetchWithTimeout(host + path, { method: 'DELETE' }, path).catch(() => undefined);
  return { kind: 'cancelled' };
}
