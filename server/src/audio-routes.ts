// System-audio streaming surface (opt-in, BELAY_WEBRTC) — registered by
// index.ts with one call, the same shape as image-routes.ts, and ONLY when the
// flag is on: with it off none of these routes exist and the shipping JPEG /
// input paths are untouched.
//
// Two surfaces:
//   * REST start/stop/status — the control verbs, mapped 1:1 onto the helper's
//     `audiostart`/`audiostop`/`audiostatus` commands;
//   * `/ws/audio` — the interim transport: every `type:'audio'` frame the
//     helper pushes is validated (audio.ts), packed into the binary wire
//     format the phone's audio-frames.ts decodes, and sent as one binary
//     WebSocket message. When the libdatachannel peer is built the same wire
//     frames ride the `audio` data channel instead and this socket retires;
//     nothing about the frame format changes.
//
// Capture lifecycle is refcounted by connected audio sockets: the first socket
// starts the helper's capture, the last one out stops it, and a socket that
// dies without saying goodbye still releases it. A congested socket sheds
// frames (shouldDropAudioFrame) — audio queued behind a stall would arrive
// past every jitter buffer's reach, so newest-wins exactly like the screen
// path's frame dropping.

import type { Express, RequestHandler } from 'express';
import type { WebSocket } from 'ws';

import { AudioCaptureController } from './audio-capture.js';
import { encodeAudioWireFrame, shouldDropAudioFrame, validateHelperAudioFrame } from './audio.js';
import { messageOf } from './errors.js';
import { native } from './native.js';

/** Serialized capture lifecycle. Every audio socket acquires/releases a hold;
 *  the controller starts on the first hold, stops on the last, retries a failed
 *  start for later waiters, and never lets start/stop interleave (audio-capture.ts). */
const capture = new AudioCaptureController({
  start: () => native.audioStart(),
  stop: () => native.audioStop(),
});

export function registerAudioRoutes(app: Express, auth: RequestHandler): void {
  app.post('/audio/start', auth, async (_req, res) => {
    try {
      const reply = await native.audioStart();
      res.json({ ok: true, codec: reply?.codec, sampleRate: reply?.sampleRate, channels: reply?.channels });
    } catch (e: unknown) {
      // A helper without the audio verbs answers `unknown command`: an honest
      // 501, not a 500 — this host's helper predates audio capture.
      res.status(501).json({ error: `this host cannot capture system audio: ${messageOf(e)}` });
    }
  });

  app.post('/audio/stop', auth, async (_req, res) => {
    // Refuse to stop capture while WS listeners still depend on it — a bare
    // REST stop used to cut their audio with no restart. With no listeners this
    // reconciles toward stopped and forwards to the helper for good measure.
    const outcome = await capture.requestExternalStop();
    if (!outcome.stopped) {
      res.status(409).json({ error: `refusing to stop: ${outcome.listeners} active audio listener(s)`, listeners: outcome.listeners });
      return;
    }
    try {
      await native.audioStop();
      res.json({ ok: true });
    } catch (e: unknown) {
      res.status(501).json({ error: messageOf(e) });
    }
  });

  app.get('/audio/status', auth, async (_req, res) => {
    try {
      const reply = await native.audioStatus();
      res.json({ ok: true, capturing: reply?.capturing === true, codec: reply?.codec, listeners: capture.listeners });
    } catch (e: unknown) {
      res.status(501).json({ error: messageOf(e) });
    }
  });
}

/**
 * One authenticated audio-stream socket. Wired into the upgrade handler by
 * index.ts, which only routes `/ws/audio` here when BELAY_WEBRTC is on.
 */
export function handleAudioSocket(ws: WebSocket): void {
  let dropped = 0;
  const detach = native.onAudioFrame((raw) => {
    const result = validateHelperAudioFrame(raw);
    if (!result.ok) {
      // A malformed push is a helper bug worth one log line, never a crash.
      console.warn('[audio] dropped a malformed helper frame:', result.error);
      return;
    }
    if (ws.readyState !== ws.OPEN) return;
    if (shouldDropAudioFrame(ws.bufferedAmount)) {
      dropped += 1;
      return;
    }
    try { ws.send(encodeAudioWireFrame(result.frame)); } catch { /* closing */ }
  });

  // Release exactly once, whether the socket closes normally or we tear it down
  // after a failed start — a double release would corrupt the refcount.
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    detach();
    if (dropped > 0) console.warn(`[audio] shed ${dropped} frames to a congested socket`);
    void capture.release();
  };

  // Acquire a capture hold. The controller starts capture on the first hold and
  // RETRIES the start for a later waiter if an earlier one failed — so a second
  // socket is never stranded on silence by a failed first start. If the start
  // ultimately fails for us, report it and close: a silent socket would read as
  // "audio is broken" with no way to see why.
  capture.acquire().catch((e: unknown) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'error', error: `audio capture failed to start: ${messageOf(e)}` }));
      ws.close(); // triggers 'close' → release()
    } else {
      release();
    }
  });

  ws.on('close', release);
}
