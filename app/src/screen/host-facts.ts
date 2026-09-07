// The `/screen/info` probe and what it tells the screen tab.
//
// `useHostFacts` polls the host for geometry, latency and — on macOS — the
// Screen Recording / Accessibility permission flags. The permission and aspect
// helpers are pure and live here with the data they read.

import { useCallback, useEffect, useState } from 'react';
import { api, ScreenInfo } from '../api';
import { messageOf, PERMISSION_PATTERN, STREAM } from './model';

// --- host facts -------------------------------------------------------------

export interface HostFacts {
  readonly info: ScreenInfo | null;
  readonly pingMs: number | null;
  readonly error: string | null;
  readonly refresh: () => void;
}

/**
 * Polls `/screen/info`. Doubles as the latency probe — the REST round trip is
 * the most honest measure of link latency available to the client — and as the
 * source of the macOS permission flags.
 *
 * `active` carries the same paired-and-focused meaning as in `useScreenStream`:
 * the poll must not keep firing every 15s while the user is on another tab.
 */
export function useHostFacts(active: boolean): HostFacts {
  const [info, setInfo] = useState<ScreenInfo | null>(null);
  const [pingMs, setPingMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!active) {
      // A ping measured before the tab was hidden says nothing about now.
      setPingMs(null);
      return;
    }
    let disposed = false;

    const probe = async (): Promise<void> => {
      const started = Date.now();
      try {
        const next = await api.screenInfo();
        if (disposed) return;
        setPingMs(Date.now() - started);
        setInfo(next);
        setError(null);
      } catch (e: unknown) {
        if (disposed) return;
        setPingMs(null);
        setError(messageOf(e));
      }
    };

    void probe();
    const timer = setInterval(() => void probe(), STREAM.infoPollMs);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [active, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { info, pingMs, error, refresh };
}

// --- permissions ------------------------------------------------------------

export interface PermissionState {
  readonly captureBlocked: boolean;
  readonly inputBlocked: boolean;
  /** True when the host actually reported flags, rather than us inferring them. */
  readonly known: boolean;
}

/**
 * True when the host reports a Darwin kernel. The single source of truth for
 * every mac-specific branch in this tab — key labels, and the permission card.
 */
export const isMacHost = (info: ScreenInfo | null): boolean =>
  (info?.platform ?? '').toLowerCase().startsWith('darwin');

export const readPermissions = (info: ScreenInfo | null, streamError: string | null): PermissionState => {
  const perms = info?.permissions;
  if (perms) {
    return { captureBlocked: !perms.screenRecording, inputBlocked: !perms.accessibility, known: true };
  }
  // Older macOS hosts do not report the flags, so fall back to sniffing the
  // capture error: a silent black screen is the worst outcome.
  //
  // Strictly gated on the host being a Mac. The pattern matches ordinary
  // Windows and Node failures too — "Access is denied", "EACCES: permission
  // denied" — and the card it drives tells the user to open macOS System
  // Settings. Confidently wrong advice is worse than a generic error, so
  // anything that is not a known Mac gets the generic stream-error banner.
  const suspicious = isMacHost(info) && Boolean(streamError && PERMISSION_PATTERN.test(streamError));
  return { captureBlocked: suspicious, inputBlocked: false, known: false };
};

export { aspectOf } from './aspect';
