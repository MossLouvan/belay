// The `/ws/screen` socket and the `/screen/info` probe.
//
// `useScreenStream` owns opening the socket, exponential-backoff reconnects,
// decoding untrusted frames, per-second statistics, stall detection and the
// BWP (H.264 over UDP) negotiation with its JPEG fallback. The `/screen/info`
// poll and the permission helpers live in ./host-facts and are re-exported
// here so the screen tab still imports one module.

import { gamingQuality } from '../gamepad/presets';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { checkHost, getConnection, wsUrl, UnauthorizedError } from '../api';
import { ReattachLink, shouldReattachOnForeground } from '../foreground';
import { buildConfigMessage, messageOf, QualityPreset, STREAM, VirtualRequest } from './model';
import { PROBE_INTERVAL_MS, shouldProbeDuringBackoff } from './retry';
import { parseStreamMessage, type FramePayload } from './stream-message';

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
  /**
   * What the phone's decoder sees, once a second. Null until the native view
   * has reported. The phone's `rttMs` and the host's `encodeMs` (in
   * `bwpStats`) together are the measurable share of glass-to-glass latency.
   */
  readonly bwpClient: BwpClientStats | null;
  /**
   * Why the picture is JPEG when it might have been H.264: the user's switch,
   * a host that cannot, or a fallback after a failure. Null while BWP is
   * live or was never a possibility worth explaining.
   */
  readonly bwpFallback: BwpSkipReason | BwpFallbackReason | null;
  /** Events from the native view. The screen tab wires this to `onStatus`. */
  readonly onBwpStatus: (status: StreamStatus) => void;
}

export interface BwpClientStats {
  /** Frames the decoder showed in the last second. */
  readonly fps: number;
  readonly dropped: number;
  readonly keyframeRequests: number;
  /**
   * Controller reports the session put on the UDP Input channel in the last
   * second. Zero whenever Gaming is off, and the only evidence on a device
   * that the controller is taking that channel and not just the WebSocket.
   */
  readonly inputSent: number;
  /** Round trip as the phone measures it, or null until known. */
  readonly rttMs: number | null;
}

export interface BwpOptions {
  readonly preference: BwpPreference;
  /** The host's /health or /screen/info flag; undefined until known. */
  readonly hostBwp: boolean | undefined;
}

const DEFAULT_BWP_OPTIONS: BwpOptions = Object.freeze({ preference: 'auto', hostBwp: undefined });

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
import type { BwpSource, StreamStatus } from '../../modules/belay-stream/src';
import {
  bwpDecoded,
  bwpHostSent,
  bwpOffered,
  bwpStalled,
  shouldRequestBwp,
  type BwpFallbackReason,
  type BwpHealth,
  type BwpPreference,
  type BwpSkipReason,
} from './bwp-policy';

export { buildConfigMessage, parseStreamMessage };
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
 * @param bwpOptions The user's H.264 switch and what the host advertised. BWP
 *   is the default whenever the policy in ./bwp-policy allows it; gaming
 *   prefers it harder (no cooldown), and an explicit 'off' always wins.
 */
export function useScreenStream(
  active: boolean,
  requestedQuality: QualityPreset,
  screen?: number,
  virtual: VirtualRequest | null = null,
  gaming = false,
  bwpOptions: BwpOptions = DEFAULT_BWP_OPTIONS,
): StreamState {
  const [phase, setPhase] = useState<Phase>('idle');
  const [frameUri, setFrameUri] = useState<string | null>(null);
  const [stats, setStats] = useState<StreamStats>(EMPTY_STATS);
  const [error, setError] = useState<string | null>(null);
  const [retryingSinceMs, setRetryingSinceMs] = useState<number | null>(null);
  const [generation, setGeneration] = useState(0);
  const [bwp, setBwp] = useState<BwpSource | null>(null);
  const [bwpStats, setBwpStats] = useState<BwpStats | null>(null);
  const [bwpPath, setBwpPath] = useState<string | null>(null);
  const quality = useMemo(() => gaming ? gamingQuality(bwpPath) : requestedQuality, [gaming, bwpPath, requestedQuality]);
  const [bwpSize, setBwpSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const [bwpClient, setBwpClient] = useState<BwpClientStats | null>(null);
  const [bwpFallback, setBwpFallback] = useState<BwpSkipReason | BwpFallbackReason | null>(null);
  // A ref as well as state: the stall detector and the message handler both
  // need to know synchronously whether BWP is carrying video, and reading it
  // from state there would see the value from the render that installed them.
  const bwpLive = useRef(false);
  // Liveness of the offered stream (null while none is offered), when BWP
  // last failed on this connection, and the policy inputs — all refs because
  // the socket handlers and the ticker outlive the render that made them.
  const bwpHealth = useRef<BwpHealth | null>(null);
  const bwpFailedAt = useRef<number | null>(null);
  // True between sending bwpStart and the host's answer. A second start while
  // one is in flight makes the host kill the streamer it is still spawning.
  const bwpPending = useRef(false);
  const bwpPolicy = useRef({ preference: bwpOptions.preference, hostBwp: bwpOptions.hostBwp, gaming });

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

  const bwpTuning = useRef({preset: quality.bwpPreset, fps: quality.bwpFps});
  useEffect(() => {
    const previous = bwpTuning.current;
    bwpTuning.current = {preset: quality.bwpPreset, fps: quality.bwpFps};
    const socket = socketRef.current;
    if (!bwpLive.current || !socket || socket.readyState !== SOCKET_OPEN || reservedPort.current <= 0) return;
    if (previous.preset === quality.bwpPreset && previous.fps === quality.bwpFps) return;
    try { socket.send(buildBwpStart(reservedPort.current, quality.bwpPreset, quality.bwpFps)); }
    catch { /* stream reconnect will apply the current preference */ }
  }, [quality]);

  /**
   * Drop the H.264 stream and let the JPEG loop carry the picture. Tells the
   * host so it resumes JPEG frames at once rather than when it notices, and
   * re-arms the JPEG stall detector. A `failure` starts the retry cooldown;
   * the user switching it off is not a failure.
   */
  const abandonBwp = useCallback((reason: BwpSkipReason | BwpFallbackReason, failure: boolean): void => {
    const wasLive = bwpLive.current;
    bwpLive.current = false;
    bwpPending.current = false;
    bwpHealth.current = null;
    if (failure) bwpFailedAt.current = Date.now();
    setBwp(null);
    setBwpStats(null);
    setBwpPath(null);
    setBwpClient(null);
    setBwpFallback(reason);
    counters.current.lastFrameAt = 0;
    const socket = socketRef.current;
    if (wasLive && socket && socket.readyState === SOCKET_OPEN) {
      try { socket.send(buildBwpStop()); } catch { /* the host stops on close anyway */ }
    }
  }, []);

  /** Ask the host for H.264 if the policy allows; otherwise say why not. */
  const requestBwp = useCallback((socket: WebSocket): void => {
    const decision = shouldRequestBwp({
      ...bwpPolicy.current,
      nativeAvailable: nativeStream.isAvailable(),
      reservedPort: reservedPort.current,
      lastFailureAt: bwpFailedAt.current,
      now: Date.now(),
    });
    if (!decision.request) { setBwpFallback(decision.reason); return; }
    if (bwpPending.current || socket.readyState !== SOCKET_OPEN) return;
    // A host that does not understand this ignores it and keeps sending
    // JPEG, so asking can only upgrade the picture, never break it.
    try {
      socket.send(buildBwpStart(reservedPort.current, qualityRef.current.bwpPreset, qualityRef.current.bwpFps));
      bwpPending.current = true;
      setBwpFallback(null);
    } catch { /* the JPEG loop is already carrying the picture */ }
  }, []);

  // The switch, the host's flag or gaming changed under a live socket: apply
  // it now rather than on the next reconnect. Turning BWP off mid-stream is
  // the one case that stops a live stream; everything else only ever asks.
  useEffect(() => {
    bwpPolicy.current = { preference: bwpOptions.preference, hostBwp: bwpOptions.hostBwp, gaming };
    const socket = socketRef.current;
    if (!socket || socket.readyState !== SOCKET_OPEN) return;
    if (bwpLive.current) {
      if (bwpOptions.preference === 'off') abandonBwp('off', false);
      return;
    }
    requestBwp(socket);
  }, [bwpOptions.preference, bwpOptions.hostBwp, gaming, abandonBwp, requestBwp]);

  /**
   * What the native view reports. A decoded frame proves the UDP path works;
   * a decoder error means it never will on this session, so fall back.
   */
  const onBwpStatus = useCallback((status: StreamStatus): void => {
    if (!bwpLive.current) return;
    const now = Date.now();
    switch (status.state) {
      case 'live':
        if (bwpHealth.current) bwpHealth.current = bwpDecoded(bwpHealth.current, now);
        break;
      case 'stats':
        if (status.decoded > 0 && bwpHealth.current) bwpHealth.current = bwpDecoded(bwpHealth.current, now);
        setBwpClient({
          fps: status.decoded,
          dropped: status.dropped,
          keyframeRequests: status.keyframeRequests,
          // A binary built before the Input channel reports no field at all.
          inputSent: status.inputSent ?? 0,
          rttMs: status.rttMs >= 0 ? status.rttMs : null,
        });
        break;
      case 'error':
        abandonBwp('decoder', true);
        break;
      default:
        break;
    }
  }, [abandonBwp]);

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
      setBwp(null);
      setBwpStats(null);
      setBwpPath(null);
      setBwpSize({ width: 0, height: 0 });
      setBwpClient(null);
      setBwpFallback(null);
      bwpLive.current = false;
      bwpHealth.current = null;
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
      // BWP messages first: while the stream is up the host sends no frames at
      // all, so falling through to the frame parser would only ever fail.
      const bwpMsg = parseBwpMessage(event.data);
      if (bwpMsg) {
        switch (bwpMsg.type) {
          case 'offer': {
            bwpPending.current = false;
            const host = hostFromSocketUrl(socketUrl.current ?? '');
            if (!host) return;
            // Switched off while the offer was in flight: decline it, or the
            // switch would read "JPEG" over an H.264 picture.
            if (bwpPolicy.current.preference === 'off') {
              try { socketRef.current?.send(buildBwpStop()); } catch { /* host stops on close */ }
              setBwpFallback('off');
              return;
            }
            bwpLive.current = true;
            bwpHealth.current = bwpOffered(Date.now());
            setBwpFallback(null);
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
            // An offer is proof the host is answering, so the outage is over —
            // the same reset onFrame does when a JPEG frame lands.
            if (tries !== 0) { tries = 0; setRetryingSinceMs(null); }
            break;
          }
          case 'stats':
            setBwpStats(bwpMsg.stats);
            // The host encoded frames this second. If none of them decode
            // here, the ticker will call that a stall — see bwp-policy.
            if (bwpMsg.stats.fps > 0 && bwpHealth.current) {
              bwpHealth.current = bwpHostSent(bwpHealth.current, Date.now());
            }
            break;
          case 'bitrate':
            setBwpStats((prev) => (prev ? { ...prev, bitrate: bwpMsg.bps } : prev));
            break;
          case 'unavailable':
            // Not an error the user needs to see: the host simply cannot do
            // this, and the JPEG loop is already carrying the picture. It
            // does start the cooldown, so auto mode stops asking every open.
            abandonBwp('refused', true);
            break;
          case 'ended':
            // The stream died mid-session. Drop back to JPEG rather than
            // leaving a frozen picture, and re-arm the stall detector.
            abandonBwp('ended', true);
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
          retryTimer = undefined;
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
        retryTimer = undefined;
        stopProbe();
        void open().catch(() => scheduleRetry());
      }, delay);
      if (shouldProbeDuringBackoff(delay)) startProbe();
    };

    // Return-to-foreground reattach (backlog item `auto-reattach-foreground`).
    // iOS kills the socket while the app is backgrounded, so whatever backoff
    // wait was pending on return was scheduled for an outage that is stale
    // news. Abandon the wait, reset the backoff and the outage clock, and race
    // a fresh `/health` probe + reconnect right now — the same probe-then-open
    // shape the in-backoff probe uses, so a dead host still costs one cheap
    // HTTP round trip, not a WebSocket ticket dance.
    const reattachNow = (): void => {
      clearTimeout(retryTimer);
      retryTimer = undefined;
      stopProbe();
      tries = 0;
      setRetryingSinceMs(null);
      const host = getConnection()?.host;
      // No paired host on record: skip the probe, let open() surface the truth.
      if (!host) { void open().catch(() => scheduleRetry()); return; }
      void checkHost(host)
        .then((check) => {
          if (disposed) return;
          if (check.ok) { void open().catch(() => scheduleRetry()); return; }
          // Host still down — re-arm the loop from a fresh, fast backoff.
          scheduleRetry();
        })
        .catch(() => { if (!disposed) scheduleRetry(); });
    };

    // Fire only when a backoff wait is actually pending: a live socket must
    // not be torn down, an open()/probe already in flight must not be stacked
    // on, and a terminal error (unpaired) must stay terminal. The distinction
    // is pure and unit-tested in ../foreground.ts; this listener only reads
    // the effect's own state into it.
    const appStateSub = AppState.addEventListener('change', (next) => {
      if (disposed) return;
      const link: ReattachLink =
        retryTimer !== undefined ? 'waiting' : socketRef.current ? 'live' : 'in-flight';
      if (!shouldReattachOnForeground(next, link)) return;
      reattachNow();
    });

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
            // Ask for binary pixel frames. An old host ignores the param and
            // keeps sending JSON, which parseStreamMessage still accepts.
            bin: 1,
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
      // Binary frames must arrive as ArrayBuffer (the default is Blob on some
      // platforms, which the codec cannot read synchronously).
      socket.binaryType = 'arraybuffer';
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
        // Ask for the H.264 stream when the policy allows it.
        requestBwp(socket);
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
        bwpPending.current = false;
        bwpHealth.current = null;
        setBwp(null);
        setBwpStats(null);
        setBwpPath(null);
        setBwpClient(null);
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
      const now = Date.now();
      // An offered H.264 stream that shows nothing is worse than JPEG: the
      // control socket is fine, so nothing else would ever notice. Give it
      // up for JPEG on this same socket and try again after the cooldown.
      if (bwpLive.current && bwpHealth.current && bwpStalled(bwpHealth.current, now)) {
        abandonBwp('timeout', true);
      }
      const stale = !bwpLive.current
        && c.lastFrameAt > 0
        && now - c.lastFrameAt > STREAM.stallAfterMs;
      if (stale && socketRef.current) {
        // A half-open socket never fires 'close' on its own; tear it down so the
        // reconnect path runs instead of freezing on a stale frame forever.
        setPhase((prev) => (prev === 'live' ? 'stalled' : prev));
        socketRef.current.close();
      }
    }, STREAM.statsIntervalMs);

    return () => {
      disposed = true;
      appStateSub.remove();
      clearTimeout(retryTimer);
      stopProbe();
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
  }, [active, generation, abandonBwp, requestBwp]);

  const retry = useCallback(() => {
    setError(null);
    setRetryingSinceMs(null);
    setGeneration((g) => g + 1);
  }, []);

  return {
    phase,
    frameUri,
    stats,
    error,
    retryingSinceMs,
    retry,
    bwp,
    bwpStats,
    bwpPath,
    bwpWidth: bwpSize.width,
    bwpHeight: bwpSize.height,
    bwpClient,
    bwpFallback,
    onBwpStatus,
  };
}

export { aspectOf, isMacHost, readPermissions, useHostFacts } from './host-facts';
export type { HostFacts, PermissionState } from './host-facts';
