// The `/ws/screen` socket and the `/screen/info` probe.
//
// `useScreenStream` owns opening the socket, exponential-backoff reconnects,
// decoding untrusted frames, per-second statistics and stall detection.
// `useHostFacts` polls the host for geometry, latency and — on macOS — the
// Screen Recording / Accessibility permission flags.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ScreenInfo, wsUrl, UnauthorizedError } from '../api';
import { buildConfigMessage, messageOf, numberOf, PERMISSION_PATTERN, QualityPreset, STREAM, VirtualRequest } from './model';

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
  /**
   * Set while the host is streaming H.264 over UDP. When it is non-null the
   * renderer must show the native view and IGNORE `frameUri` — the host has
   * stopped sending JPEG frames, so the last one is stale by definition.
   */
  readonly bwp: BwpSource | null;
  /** Host-reported stream rate while BWP is carrying video. */
  readonly bwpStats: BwpStats | null;
  /**
   * 'gpu' or 'cpu' while H.264 is carrying video, else null.
   *
   * Separate from `bwp` because it is set the moment the offer arrives, about a
   * second before the first stats line. The readout needs to say "H.264,
   * starting" in that window rather than showing the JPEG counters' zeros.
   */
  readonly bwpPath: string | null;
  /** The host's frame size from its offer. Zero until one arrives. */
  readonly bwpWidth: number;
  readonly bwpHeight: number;
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

// The `config` control message and its builder live in model.ts (a pure,
// react-free module the node test runner can import); re-exported here so the
// socket code and the host contract still read as one unit.
// BWP: H.264 over UDP. The negotiation is pure and lives in ./bwp; the
// receiving and decoding is native and lives in modules/belay-stream.
import {
  buildBwpStart,
  buildBwpStop,
  hostFromSocketUrl,
  parseBwpMessage,
  type BwpStats,
} from './bwp';
import * as nativeStream from '../../modules/belay-stream/src';
import type { BwpSource } from '../../modules/belay-stream/src';

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
  const [attempt, setAttempt] = useState(0);
  const [generation, setGeneration] = useState(0);
  const [bwp, setBwp] = useState<BwpSource | null>(null);
  const [bwpStats, setBwpStats] = useState<BwpStats | null>(null);
  const [bwpPath, setBwpPath] = useState<string | null>(null);
  const [bwpSize, setBwpSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  // A ref as well as state: the stall detector and the message handler both
  // need to know synchronously whether BWP is carrying video, and reading it
  // from state there would see the value from the render that installed them.
  const bwpLive = useRef(false);

  const socketRef = useRef<WebSocket | null>(null);
  const qualityRef = useRef<QualityPreset>(quality);
  const screenRef = useRef<number | undefined>(screen);
  const virtualRef = useRef<VirtualRequest | null>(virtual);
  const counters = useRef<FrameCounters>(newCounters());
  // The host address is taken from the URL we authenticated against, never from
  // a message — a host field in a message would be a redirect with no reason to
  // honour it.
  const socketUrl = useRef<string | null>(null);
  const reservedPort = useRef(0);

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
      // both timers. Clearing the attempt counter and the last fault as well
      // means a refocus starts from a clean "connecting", never mid-backoff and
      // never showing a stale error banner for a socket that no longer exists.
      setPhase('idle');
      setAttempt(0);
      setError(null);
      counters.current = newCounters();
      setStats(EMPTY_STATS);
      setBwp(null);
      setBwpStats(null);
      setBwpPath(null);
      setBwpSize({ width: 0, height: 0 });
      bwpLive.current = false;
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
      // Reset the backoff only once a real frame arrives — not on socket open,
      // which an accept-then-immediately-close host also triggers, pinning the
      // retry at the 1s floor forever.
      if (tries !== 0) { tries = 0; setAttempt(0); }
      // Functional updates so a steady stream of identical values bails out of
      // re-rendering rather than churning at the frame rate.
      setPhase((prev) => (prev === 'live' ? prev : 'live'));
      setError((prev) => (prev === null ? prev : null));
    };

    const onMessage = (event: { data: unknown }): void => {
      // BWP messages first: while the stream is up the host sends no frames at
      // all, so falling through to the frame parser would only ever fail.
      const bwpMsg = parseBwpMessage(event.data);
      if (bwpMsg) {
        switch (bwpMsg.type) {
          case 'offer': {
            const host = hostFromSocketUrl(socketUrl.current ?? '');
            if (!host) return;
            bwpLive.current = true;
            setBwp({
              host,
              port: bwpMsg.offer.port,
              key: bwpMsg.offer.key,
              salt: bwpMsg.offer.salt,
              preset: qualityRef.current.bwpPreset,
              localPort: reservedPort.current,
            });
            setBwpPath(bwpMsg.offer.path);
            setBwpSize({ width: bwpMsg.offer.width, height: bwpMsg.offer.height });
            setPhase('live');
            setError(null);
            if (tries !== 0) { tries = 0; setAttempt(0); }
            break;
          }
          case 'stats':
            setBwpStats(bwpMsg.stats);
            break;
          case 'bitrate':
            setBwpStats((prev) => (prev ? { ...prev, bitrate: bwpMsg.bps } : prev));
            break;
          case 'unavailable':
            // Not an error the user needs to see: the host simply cannot do
            // this, and the JPEG loop is already carrying the picture.
            bwpLive.current = false;
            setBwp(null);
            setBwpPath(null);
            break;
          case 'ended':
            // The stream died mid-session. Drop back to JPEG rather than
            // leaving a frozen picture, and re-arm the stall detector.
            bwpLive.current = false;
            setBwp(null);
            setBwpStats(null);
            setBwpPath(null);
            counters.current.lastFrameAt = 0;
            break;
        }
        return;
      }

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
      // Reserve the UDP port BEFORE the socket opens. The host must be told
      // where to send before it starts sending; binding afterwards means its
      // first frames land on a port nothing is listening to and are lost, which
      // looks like a dead stream rather than like the race it is.
      if (nativeStream.isAvailable() && reservedPort.current === 0) {
        try {
          reservedPort.current = await nativeStream.reservePort();
        } catch {
          // No port, no BWP. The JPEG path still works.
          reservedPort.current = 0;
        }
      }
      if (disposed) return;

      let socket: WebSocket;
      let url: string;
      try {
        url = await wsUrl('/ws/screen', {
            w: preset.w,
            q: preset.q,
            fps: preset.fps,
            // Only named when a monitor was actually chosen; older hosts
            // ignore unknown query params, so this is safe either way.
            ...(screenIndex === undefined ? {} : { screen: screenIndex }),
        });
        socket = new WebSocket(url);
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
      socketUrl.current = url;
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
        // Ask for the H.264 stream. A host that does not understand this
        // ignores it and keeps sending JPEG, so asking can only upgrade the
        // picture, never break it.
        if (reservedPort.current > 0 && socket.readyState === SOCKET_OPEN) {
          try {
            socket.send(buildBwpStart(
              reservedPort.current,
              qualityRef.current.bwpPreset,
              qualityRef.current.bwpFps,
            ));
          } catch { /* the JPEG loop is already carrying the picture */ }
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
        // The host tears its streamer down when the socket closes, so the
        // native session is pointed at nothing. Drop it rather than leaving a
        // frozen last frame on screen through the whole reconnect.
        bwpLive.current = false;
        setBwp(null);
        setBwpStats(null);
        setBwpPath(null);
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
      // While BWP carries the video the host sends no JPEG frames at all, so
      // `lastFrameAt` stops advancing by design. Without this guard the stall
      // detector would close a perfectly healthy socket a second after the
      // H.264 stream started, every time.
      const stale = !bwpLive.current
        && c.lastFrameAt > 0
        && Date.now() - c.lastFrameAt > STREAM.stallAfterMs;
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
      clearInterval(ticker);
      const socket = socketRef.current;
      socketRef.current = null;
      if (!socket) return;
      // Tell the host to stop capturing before dropping the socket. It also
      // stops on close, but saying so explicitly means the desktop is not
      // captured for the extra moment the close takes to be noticed.
      if (socket.readyState === SOCKET_OPEN) {
        try { socket.send(buildBwpStop()); } catch { /* closing anyway */ }
      }
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

  return {
    phase,
    frameUri,
    stats,
    error,
    attempt,
    retry,
    bwp,
    bwpStats,
    bwpPath,
    bwpWidth: bwpSize.width,
    bwpHeight: bwpSize.height,
  };
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
