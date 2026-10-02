// H.264 over the `/ws/screen` socket: the per-socket relay.
//
// The phone asks with `?codec=h264`. If the helper can encode (today: the
// macOS helper), the socket gets a `{type:'codec', codec:'h264', w,h,sw,sh}`
// announcement and then every binary message is one access unit, already in
// the binary screen-frame format (frame-codec.ts), forwarded from the helper's
// video pipe without being re-encoded. Anything else — Windows, an old helper,
// a failed start — gets `{type:'codec', codec:'jpeg'}` and the JPEG loop runs
// exactly as before. The announcement always precedes the first pixel frame of
// either kind, which is what lets the phone pick its binary handling up front.
//
// Backpressure on a delta-coded stream is not "drop a frame": a decoder that
// misses one reference shows garbage until the next IDR. So a frame dropped
// for a full send buffer flips `awaitingKeyframe`, every delta after it is
// dropped too, and the helper is asked for a keyframe (rate-limited) — the
// stream resumes clean on the next IDR.

import type { WebSocket } from 'ws';

import { native, type H264Geometry } from './native.js';
import type { VideoRecord } from './video-records.js';

/** Minimum spacing between keyframe requests from one socket. */
export const KEYFRAME_REQUEST_INTERVAL_MS = 250;

export interface H264CaptureArgs {
  readonly width: number;
  readonly quality: number;
  readonly fps: number;
  readonly screen?: number;
  readonly virtualDisplay: boolean;
}

/** Pure: whether a dropped frame should turn into a keyframe request now. */
export function keyframeRequestDue(lastRequestAt: number, now: number): boolean {
  return now - lastRequestAt >= KEYFRAME_REQUEST_INTERVAL_MS;
}

export interface H264Relay {
  /** True while H.264 frames are flowing to this socket (the JPEG loop idles). */
  readonly active: boolean;
  /** True while a start is in flight: the JPEG loop must not send a frame
   *  before the codec announcement, so it idles through this too. */
  readonly pending: boolean;
  /** (Re)start with the current capture arguments; announces the outcome.
   *  A no-op once the phone has declined H.264 on this socket. */
  start(): Promise<void>;
  /** Ask the helper for an IDR (phone decoder failure, or our own drop). */
  keyframe(): void;
  /** Stop relaying and announce JPEG; the JPEG loop resumes. */
  stop(): void;
}

export function createH264Relay(
  ws: WebSocket,
  captureArgs: () => H264CaptureArgs,
  maxBufferedBytes: number,
  onGeometry?: (geometry: H264Geometry) => void,
): H264Relay {
  let unsubscribe: (() => void) | null = null;
  let awaitingKeyframe = true;
  let lastRequestAt = -Infinity;
  let generation = 0;
  let starting = 0;
  let declined = false;

  const open = (): boolean => ws.readyState === ws.OPEN;

  const announce = (codec: 'jpeg' | 'h264', g?: H264Geometry): void => {
    if (!open()) return;
    ws.send(JSON.stringify(codec === 'h264' && g
      ? { type: 'codec', codec, w: g.w, h: g.h, sw: g.sw, sh: g.sh }
      : { type: 'codec', codec: 'jpeg' }));
  };

  const requestKeyframe = (): void => {
    const now = Date.now();
    if (!keyframeRequestDue(lastRequestAt, now)) return;
    lastRequestAt = now;
    native.h264Keyframe().catch(() => { /* a dead helper is handled by the stall path */ });
  };

  const onFrame = (record: VideoRecord): void => {
    if (!open()) return;
    if (record.keyframe) {
      awaitingKeyframe = false;
    } else if (awaitingKeyframe) {
      return; // a delta against a frame this socket never sent
    }
    if (ws.bufferedAmount > maxBufferedBytes) {
      awaitingKeyframe = true;
      requestKeyframe();
      return;
    }
    ws.send(record.frame);
  };

  const detach = (): void => {
    if (!unsubscribe) return;
    unsubscribe();
    unsubscribe = null;
    if (native.videoListenerCount() === 0) {
      native.h264Stop().catch(() => { /* already gone */ });
    }
  };

  return {
    get active() { return unsubscribe !== null; },
    get pending() { return starting > 0; },

    async start(): Promise<void> {
      if (declined) return;
      const mine = ++generation;
      const args = captureArgs();
      starting += 1;
      let geometry: H264Geometry;
      try {
        geometry = await native.h264Start(args.width, args.fps, args.quality, args.screen, args.virtualDisplay);
      } catch {
        // Not an error the phone needs to read: the host cannot encode (or
        // the helper is too old), and the JPEG loop is already there.
        if (mine === generation) { detach(); announce('jpeg'); }
        return;
      } finally {
        starting -= 1;
      }
      if (mine !== generation) return; // a later start() won
      if (!open()) { detach(); return; }
      awaitingKeyframe = true;
      if (!unsubscribe) unsubscribe = native.onVideoFrame(onFrame);
      onGeometry?.(geometry);
      announce('h264', geometry);
      console.log(`[screen] h264 ${geometry.w}x${geometry.h}@${geometry.fps} (source ${geometry.sw}x${geometry.sh})`);
      // No keyframe request here: every `h264start` opens a fresh encoder
      // session whose first frame is an IDR (measured), and asking again
      // would only double the one bandwidth spike this path has.
    },

    keyframe: requestKeyframe,

    stop(): void {
      declined = true;
      generation += 1;
      const was = unsubscribe !== null;
      detach();
      if (was) { announce('jpeg'); console.log('[screen] h264 stopped by the phone; jpeg resumes'); }
    },
  };
}
