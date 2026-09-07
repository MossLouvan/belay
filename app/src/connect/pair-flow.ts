// The connect screen's small, pure pieces: timings, the stage vocabulary and
// the helpers that bound or race a host check. Exercised by pair-flow.test.mjs
// under Node's type stripping — nothing here may import react-native. The
// React side lives in use-pair-session.ts and use-address-check.ts.

import type { HostCheck } from '../api';
// Explicit extension: node's test runner imports this file under type
// stripping, and only a real path resolves there (tsconfig allows it).
import { raceAddresses } from '../devices/race.ts';
import type { PairingDeadEnd } from './dead-end';

/** Every screen the connect route can show, in the order a cold start meets them. */
export type Stage = 'welcome' | 'how-it-works' | 'host' | 'scan' | 'code' | 'tailscale' | 'success';

/** How long to wait for `/health` before calling the address unreachable. */
export const HOST_CHECK_TIMEOUT_MS = 8000;
/** How long the success notice is shown before the tabs take over. */
export const SUCCESS_DWELL_MS = 600;

/** The `/health` reply the connect screen keeps hold of. */
export type HealthResult = HostCheck;

/** The reply a bounded check yields when the deadline passes first. */
export const TIMED_OUT: HealthResult = { ok: false, error: 'timed out' };

/**
 * The dead-end notice's inputs: the detection plus a proof-of-life stamp and
 * the host platform, so the notice states observation, not guess
 * (docs/DESIGN.md §11.4).
 */
export type DeadEndNotice = PairingDeadEnd & {
  readonly checkedAt: number;
  readonly platform?: string;
};

/** The name a pairing is registered under on the host, by phone platform. */
export function deviceNameFor(os: string): string {
  if (os === 'web') return 'Browser';
  if (os === 'ios') return 'iPhone';
  return 'Android';
}

/** A message for a thrown value of any shape; never throws itself. */
export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e ?? ''));

/**
 * `checkHost` has no timeout of its own, and a filtered address can leave the
 * request hanging indefinitely — which reads to the user as a frozen app. The
 * race bounds the wait; the underlying request is abandoned, not cancelled.
 */
export async function withDeadline<T>(work: Promise<T>, deadlineMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bail = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), deadlineMs);
  });
  try {
    return await Promise.race([work, bail]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A single-address probe, shaped like `checkHost`. Injected so tests need no network. */
export type HealthProbe = (url: string, signal?: AbortSignal) => Promise<HealthResult>;

/**
 * The first of a scanned computer's addresses that answers.
 *
 * A QR lists every path the host knows about, and only some of them work from
 * wherever the phone is standing — the LAN address is useless on cellular, and
 * the Tailscale one is useless if Tailscale is not running. They are raced
 * rather than tried in order so a dead candidate costs one abandoned request
 * instead of a visible delay.
 */
export async function firstReachable(urls: readonly string[], probe: HealthProbe): Promise<string | null> {
  const winner = await raceAddresses(
    urls.map((url) => ({ url })),
    async (url, signal) => {
      const health = await probe(url, signal);
      return { ok: health.ok, hostId: health.id };
    },
  );
  return winner?.url ?? null;
}

/** What the foreground watcher needs to decide whether to re-run the check. */
export interface ForegroundReturn {
  readonly previous: string;
  readonly next: string;
  /** The app opened Tailscale and is waiting for the user to come back. */
  readonly awaitingTailscale: boolean;
  readonly stage: Stage;
  /** A `/health` check is already in flight. */
  readonly checking: boolean;
  /** The screen is still mounted. */
  readonly live: boolean;
}

/**
 * Whether coming back to the foreground should re-run the address check.
 *
 * Only a real background→active transition counts, and only while the code
 * screen is waiting on Tailscale; a check already in flight, or a screen that
 * has since unmounted, must not be raced.
 */
export function shouldRecheckOnReturn(r: ForegroundReturn): boolean {
  return (
    r.next === 'active' &&
    /inactive|background/.test(r.previous) &&
    r.awaitingTailscale &&
    r.stage === 'code' &&
    !r.checking &&
    r.live
  );
}
