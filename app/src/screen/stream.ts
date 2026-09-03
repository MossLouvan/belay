// The `/ws/screen` socket and the `/screen/info` probe.
//
// `useScreenStream` owns opening the socket, exponential-backoff reconnects,
// decoding untrusted frames, per-second statistics and stall detection.
// `useHostFacts` polls the host for geometry, latency and — on macOS — the
// Screen Recording / Accessibility permission flags.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, checkHost, getConnection, ScreenInfo, wsUrl, UnauthorizedError } from '../api';
import { buildConfigMessage, messageOf, numberOf, PERMISSION_PATTERN, QualityPreset, STREAM, VirtualRequest } from './model';
import { PROBE_INTERVAL_MS, shouldProbeDuringBackoff } from './retry';

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
  /**
   * When the current outage began (epoch ms), or null while the picture is
   * healthy. The panel phrases this as elapsed time ("Still trying · 9m") —
   * an attempt counter is an implementation confession, not a fact a user
   * can act on.
   */
  readonly retryingSinceMs: number | null;
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

/** Delay before reconnect attempt N (1-based). */
export const backoffDelayMs = (attempt: number): number =>
  Math.min(STREAM.backoffMaxMs, STREAM.backoffBaseMs * 2 ** Math.max(0, attempt - 1));

// The `config` control message and its builder live in model.ts (a pure,
// react-free module the node test runner can import); re-exported here so the
// socket code and the host contract still read as one unit.
export { buildConfigMessage };
export type { ConfigMessage } from './model';

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
/**
 * @param virtual The true-resolution request, or null for the physical screen.
 *   Sent in the `config` message (and re-sent on every reconnect via onopen,
 *   since a WebSocket URL cannot carry the object). The host creates the
 *   driver-backed display, captures IT, and destroys it on disconnect; a host
 *   without the feature ignores the field and keeps downscaling — so passing a
 *   request can never break the picture, only upgrade it.
 */
export function useScreenStream(
  active: boolean,
  quality: QualityPreset,
  screen?: number,
  virtual: VirtualRequest | null = null,
): StreamState {
  const [phase, setPhase] = useState<Phase>('idle');
  const [frameUri, setFrameUri] = useState<string | null>(null);
  const [stats, setStats] = useState<StreamStats>(EMPTY_STATS);
  const [error, setError] = useState<string | null>(null);
  const [retryingSinceMs, setRetryingSinceMs] = useState<number | null>(null);
  const [generation, setGeneration] = useState(0);

  const socketRef = useRef<WebSocket | null>(null);
  const qualityRef = useRef<QualityPreset>(quality);
  const screenRef = useRef<number | undefined>(screen);
  const virtualRef = useRef<VirtualRequest | null>(virtual);
  const counters = useRef<FrameCounters>(newCounters());

  // Live retune: the host accepts a `config` message, so changing quality, the
  // streamed monitor, or the true resolution costs neither a reconnect nor a
  // dropped picture. The refs also feed onopen, so a reconnect re-sends the
  // current mode (a virtual display has to be re-created on the fresh socket).
  useEffect(() => {
    qualityRef.current = quality;
    screenRef.current = screen;
    virtualRef.current = virtual;
    const socket = socketRef.current;
    if (!socket || socket.readyState !== SOCKET_OPEN) return;
    try {
      socket.send(JSON.stringify(buildConfigMessage(quality, screen, virtual)));
    } catch (e: unknown) {
      setError(`Could not apply the ${quality.label} preset — ${messageOf(e)}`);
    }
  }, [quality, screen, virtual]);

  useEffect(() => {
    if (!active) {
      // The previous run's cleanup has already closed the socket and cleared
      // every timer. Clearing the outage clock and the last fault as well
      // means a refocus starts from a clean "connecting", never mid-backoff and
      // never showing a stale error banner for a socket that no longer exists.
      setPhase('idle');
      setRetryingSinceMs(null);
      setError(null);
      counters.current = newCounters();
      setStats(EMPTY_STATS);
      return;
    }

    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let probeTimer: ReturnType<typeof setInterval> | undefined;
    let probeInFlight = false;
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
      // Reset the backoff only once a real frame arrives — not on socket open,
      // which an accept-then-immediately-close host also triggers, pinning the
      // retry at the 1s floor forever. The outage clock stops for the same
      // reason: only a picture proves the outage is over.
      if (tries !== 0) { tries = 0; setRetryingSinceMs(null); }
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

    const stopProbe = (): void => {
      if (probeTimer === undefined) return;
      clearInterval(probeTimer);
      probeTimer = undefined;
    };

    // While a long backoff wait is pending, shadow it with a cheap `/health`
    // probe so the stream reconnects the instant the host answers — a Mac
    // waking from sleep should not sit out the rest of a 15s tick. A probe
    // failure changes nothing: the backoff timer is still armed and remains
    // the plan of record.
    const startProbe = (): void => {
      if (probeTimer !== undefined) return;
      probeTimer = setInterval(() => {
        if (probeInFlight) return;
        const host = getConnection()?.host;
        if (!host) return;
        probeInFlight = true;
        void checkHost(host).then((check) => {
          probeInFlight = false;
          // `probeTimer === undefined` means this probe was stopped (retry
          // fired, or teardown) while the request was in flight — its answer
          // no longer speaks for anyone.
          if (disposed || probeTimer === undefined || !check.ok) return;
          stopProbe();
          clearTimeout(retryTimer);
          void open().catch(() => scheduleRetry());
        });
      }, PROBE_INTERVAL_MS);
    };

    const scheduleRetry = (): void => {
      if (disposed) return;
      tries += 1;
      // The outage clock starts at the FIRST failure and keeps running across
      // every retry until a frame arrives; later failures are the same outage.
      if (tries === 1) setRetryingSinceMs(Date.now());
      setPhase('reconnecting');
      const delay = backoffDelayMs(tries);
      retryTimer = setTimeout(() => {
        stopProbe();
        void open().catch(() => scheduleRetry());
      }, delay);
      if (shouldProbeDuringBackoff(delay)) startProbe();
    };

    // Async because the upgrade URL now needs a ticket fetched over HTTP first.
    // The `disposed` check is repeated after the await: the effect can be torn
    // down while the ticket request is in flight, and opening a socket then
    // would leak one that nothing ever closes.
    async function open(): Promise<void> {
      if (disposed) return;
      // Disarm the stall detector for the new socket. `lastFrameAt` is a ref
      // that survives reconnects, so without this the ticker sees the previous
      // socket's last-frame timestamp (already older than stallAfterMs after a
      // sleep/relay hiccup) and closes the fresh socket before its first frame
      // — reconnecting forever on any link where handshake + first frame > 1s.
      // The `lastFrameAt > 0` guard keeps the check disabled until a real frame
      // re-arms it.
      counters.current.lastFrameAt = 0;
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
        if (e instanceof UnauthorizedError) {
          // The phone is no longer paired with this computer. Retrying can only
          // 401 forever, so this is terminal — surface it instead of looping.
          setError('This phone is no longer paired with that computer.');
          setPhase('error');
          return;
        }
        setError(`Could not open the screen stream — ${messageOf(e)}`);
        scheduleRetry();
        return;
      }
      if (disposed) { socket.close(); return; }
      socketRef.current = socket;
      socket.onopen = () => {
        // Backoff is reset on the first frame (see onFrame), not here — a socket
        // that opens but never delivers must not clear the counter.
        //
        // Re-send the full mode on every (re)connect. w/q/fps/screen already
        // rode in on the URL, but the virtual-resolution request cannot — a URL
        // carries no object — and a re-created socket starts with no virtual
        // display, so this is what makes a reconnect restore the true
        // resolution rather than silently dropping back to the physical screen.
        const v = virtualRef.current;
        if (v !== null && socket.readyState === SOCKET_OPEN) {
          try {
            socket.send(JSON.stringify(buildConfigMessage(qualityRef.current, screenRef.current, v)));
          } catch { /* a failed send just means the picture stays physical */ }
        }
      };
      socket.onmessage = onMessage;
      socket.onerror = () => {
        if (disposed) return;
        setError((prev) => prev ?? 'The host is not reachable on this network.');
      };
      socket.onclose = (event: { code?: number }) => {
        if (disposed) return;
        socketRef.current = null;
        if (event?.code === 4001) {
          // The host revoked this device mid-stream. Terminal — do not retry.
          setError('This phone is no longer paired with that computer.');
          setPhase('error');
          return;
        }
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
      if (stale && socketRef.current) {
        // A half-open socket never fires 'close' on its own; tear it down so the
        // reconnect path runs instead of freezing on a stale frame forever.
        setPhase((prev) => (prev === 'live' ? 'stalled' : prev));
        socketRef.current.close();
      }
    }, STREAM.statsIntervalMs);

    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      stopProbe();
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
    setRetryingSinceMs(null);
    setGeneration((g) => g + 1);
  }, []);

  return { phase, frameUri, stats, error, retryingSinceMs, retry };
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
