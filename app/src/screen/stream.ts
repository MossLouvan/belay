// The `/ws/screen` socket and the `/screen/info` probe.
//
// `useScreenStream` owns opening the socket, exponential-backoff reconnects,
// decoding untrusted frames, per-second statistics and stall detection.
// `useHostFacts` polls the host for geometry, latency and — on macOS — the
// Screen Recording / Accessibility permission flags.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ScreenInfo, wsUrl } from '../api';
import { messageOf, numberOf, PERMISSION_PATTERN, QualityPreset, STREAM } from './model';

export type Phase = 'idle' | 'connecting' | 'live' | 'stalled' | 'reconnecting' | 'error';

export const PHASE_LABEL: Readonly<Record<Phase, string>> = Object.freeze({
  idle: 'not connected',
  connecting: 'connecting…',
  live: 'live',
  stalled: 'stalled',
  reconnecting: 'reconnecting…',
  error: 'error',
});

export interface StreamStats {
  readonly fps: number;
  readonly kbps: number;
  readonly frameBytes: number;
  readonly width: number;
  readonly height: number;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
}

export const EMPTY_STATS: StreamStats = Object.freeze({
  fps: 0,
  kbps: 0,
  frameBytes: 0,
  width: 0,
  height: 0,
  sourceWidth: 0,
  sourceHeight: 0,
});

interface FramePayload {
  readonly data: string;
  readonly w: number;
  readonly h: number;
  readonly sw: number;
  readonly sh: number;
  readonly bytes: number;
}

type StreamMessage =
  | { readonly type: 'frame'; readonly frame: FramePayload }
  | { readonly type: 'error'; readonly error: string };

/** Parses an untrusted socket payload. Returns null for anything unrecognised. */
export function parseStreamMessage(raw: unknown): StreamMessage | null {
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const msg = parsed as Record<string, unknown>;
  if (msg.type === 'frame' && typeof msg.data === 'string') {
    return {
      type: 'frame',
      frame: {
        data: msg.data,
        w: numberOf(msg.w),
        h: numberOf(msg.h),
        sw: numberOf(msg.sw),
        sh: numberOf(msg.sh),
        bytes: numberOf(msg.bytes),
      },
    };
  }
  if (msg.type === 'error') {
    const error = typeof msg.error === 'string' && msg.error ? msg.error : 'The host reported a capture error.';
    return { type: 'error', error };
  }
  return null;
}

export interface StreamState {
  readonly phase: Phase;
  readonly frameUri: string | null;
  readonly stats: StreamStats;
  readonly error: string | null;
  readonly attempt: number;
  readonly retry: () => void;
}

interface FrameCounters {
  frames: number;
  bytes: number;
  lastFrameAt: number;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  frameBytes: number;
}

const newCounters = (): FrameCounters => ({
  frames: 0,
  bytes: 0,
  lastFrameAt: 0,
  width: 0,
  height: 0,
  sourceWidth: 0,
  sourceHeight: 0,
  frameBytes: 0,
});

const SOCKET_OPEN = 1;

/**
 * Delay before reconnect attempt N (1-based). Exported because the panel's
 * "RETRYING IN 4S" countdown must agree with the socket's actual schedule —
 * one formula, two readers.
 */
export const backoffDelayMs = (attempt: number): number =>
  Math.min(STREAM.backoffMaxMs, STREAM.backoffBaseMs * 2 ** Math.max(0, attempt - 1));

/**
 * @param active True only while the tab is both paired and on screen. The tab
 *   navigator keeps this route mounted after the user moves to Terminal or
 *   Files, so without a focus gate the socket would keep pulling frames — and
 *   re-rendering — off screen. False tears the socket and the stats ticker down
 *   completely; the next `true` opens a fresh socket with the backoff reset.
 */
/**
 * @param screen Monitor index to stream (from `ScreenInfo.screens`), or
 *   undefined for the host's primary. Sent alongside w/q/fps both in the
 *   connect URL and as a live `config` retune, so switching monitors costs no
 *   reconnect. Must be the SAME index the input calls use — capture and input
 *   agreeing on one monitor is the whole multi-monitor contract.
 */
export function useScreenStream(active: boolean, quality: QualityPreset, screen?: number): StreamState {
  const [phase, setPhase] = useState<Phase>('idle');
  const [frameUri, setFrameUri] = useState<string | null>(null);
  const [stats, setStats] = useState<StreamStats>(EMPTY_STATS);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [generation, setGeneration] = useState(0);

  const socketRef = useRef<WebSocket | null>(null);
  const qualityRef = useRef<QualityPreset>(quality);
  const screenRef = useRef<number | undefined>(screen);
  const counters = useRef<FrameCounters>(newCounters());

  // Live retune: the host accepts a `config` message, so changing quality or
  // the streamed monitor costs neither a reconnect nor a dropped picture.
  useEffect(() => {
    qualityRef.current = quality;
    screenRef.current = screen;
    const socket = socketRef.current;
    if (!socket || socket.readyState !== SOCKET_OPEN) return;
    try {
      // `screen` is omitted (not null) when undefined: JSON.stringify drops
      // undefined keys, and the host treats an absent field as "keep current".
      socket.send(JSON.stringify({ type: 'config', w: quality.w, q: quality.q, fps: quality.fps, screen }));
    } catch (e: unknown) {
      setError(`Could not apply the ${quality.label} preset — ${messageOf(e)}`);
    }
  }, [quality, screen]);

  useEffect(() => {
    if (!active) {
      // The previous run's cleanup has already closed the socket and cleared
      // both timers. Clearing the attempt counter and the last fault as well
      // means a refocus starts from a clean "connecting", never mid-backoff and
      // never showing a stale error banner for a socket that no longer exists.
      setPhase('idle');
      setAttempt(0);
      setError(null);
      counters.current = newCounters();
      setStats(EMPTY_STATS);
      return;
    }

    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    // Local to this effect run, so every resume restarts the backoff at zero.
    let tries = 0;

    const onFrame = (frame: FramePayload): void => {
      const c = counters.current;
      c.frames += 1;
      c.bytes += frame.bytes;
      c.frameBytes = frame.bytes;
      c.lastFrameAt = Date.now();
      c.width = frame.w;
      c.height = frame.h;
      c.sourceWidth = frame.sw;
      c.sourceHeight = frame.sh;
      setFrameUri(`data:image/jpeg;base64,${frame.data}`);
      // Functional updates so a steady stream of identical values bails out of
      // re-rendering rather than churning at the frame rate.
      setPhase((prev) => (prev === 'live' ? prev : 'live'));
      setError((prev) => (prev === null ? prev : null));
    };

    const onMessage = (event: { data: unknown }): void => {
      const msg = parseStreamMessage(event.data);
      if (!msg) return;
      if (msg.type === 'error') {
        setError(msg.error);
        setPhase('error');
        return;
      }
      onFrame(msg.frame);
    };

    const scheduleRetry = (): void => {
      if (disposed) return;
      tries += 1;
      setAttempt(tries);
      setPhase('reconnecting');
      retryTimer = setTimeout(() => void open().catch(() => scheduleRetry()), backoffDelayMs(tries));
    };

    // Async because the upgrade URL now needs a ticket fetched over HTTP first.
    // The `disposed` check is repeated after the await: the effect can be torn
    // down while the ticket request is in flight, and opening a socket then
    // would leak one that nothing ever closes.
    async function open(): Promise<void> {
      if (disposed) return;
      setPhase(tries === 0 ? 'connecting' : 'reconnecting');
      const preset = qualityRef.current;
      const screenIndex = screenRef.current;
      let socket: WebSocket;
      try {
        socket = new WebSocket(
          await wsUrl('/ws/screen', {
            w: preset.w,
            q: preset.q,
            fps: preset.fps,
            // Only named when a monitor was actually chosen; older hosts
            // ignore unknown query params, so this is safe either way.
            ...(screenIndex === undefined ? {} : { screen: screenIndex }),
          }),
        );
      } catch (e: unknown) {
        setError(`Could not open the screen stream — ${messageOf(e)}`);
        scheduleRetry();
        return;
      }
      if (disposed) { socket.close(); return; }
      socketRef.current = socket;
      socket.onopen = () => {
        if (disposed) return;
        tries = 0;
        setAttempt(0);
      };
      socket.onmessage = onMessage;
      socket.onerror = () => {
        if (disposed) return;
        setError((prev) => prev ?? 'The host is not reachable on this network.');
      };
      socket.onclose = () => {
        if (disposed) return;
        socketRef.current = null;
        scheduleRetry();
      };
    }

    void open().catch(() => scheduleRetry());

    const ticker = setInterval(() => {
      const c = counters.current;
      const frames = c.frames;
      const bytes = c.bytes;
      c.frames = 0;
      c.bytes = 0;
      setStats({
        fps: frames,
        kbps: Math.round(bytes / 1024),
        frameBytes: c.frameBytes,
        width: c.width,
        height: c.height,
        sourceWidth: c.sourceWidth,
        sourceHeight: c.sourceHeight,
      });
      const stale = c.lastFrameAt > 0 && Date.now() - c.lastFrameAt > STREAM.stallAfterMs;
      setPhase((prev) => (prev === 'live' && stale ? 'stalled' : prev));
    }, STREAM.statsIntervalMs);

    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      clearInterval(ticker);
      const socket = socketRef.current;
      socketRef.current = null;
      if (!socket) return;
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      socket.close();
    };
  }, [active, generation]);

  const retry = useCallback(() => {
    setError(null);
    setAttempt(0);
    setGeneration((g) => g + 1);
  }, []);

  return { phase, frameUri, stats, error, attempt, retry };
}

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

/** Aspect ratio of the remote desktop, from the best source currently known. */
export const aspectOf = (stats: StreamStats, info: ScreenInfo | null): number => {
  if (stats.sourceWidth > 0 && stats.sourceHeight > 0) return stats.sourceWidth / stats.sourceHeight;
  if (stats.width > 0 && stats.height > 0) return stats.width / stats.height;
  const primary = info?.primary;
  if (primary && primary.W > 0 && primary.H > 0) return primary.W / primary.H;
  return 16 / 9;
};
