// The last mile: /ws/audio bytes → AudioReceiver → jitter buffer → a real
// speaker. This is the impure shell around the pure pieces:
//
//   socket bytes ──► AudioReceiver.onWireBytes (validate + jitter-buffer)
//   every 20 ms  ──► AudioReceiver.tick ──► instructionFor ──► WebView sink
//
// The sink is a HIDDEN react-native-webview running Web Audio (audio-player-
// html.ts) — see audio-output.ts for why a WebView and not expo-audio/native.
// Nothing here decodes or schedules audio itself; it only moves bytes and runs
// the clock, so the crash-safety and correctness live in the tested modules.
//
// iOS realities handled here:
//   * Audio session / route: WKWebView owns its own AVAudioSession; we ask it
//     to allow inline, no-gesture playback. See the SMOKE TEST note below for
//     the one thing that genuinely needs a device to confirm.
//   * Autoplay gesture: the audio toggle press is the user gesture; start()
//     resumes the context from it.
//   * Backgrounding: an AppState listener suspends the whole pipeline (socket,
//     timer, context) when the app leaves the foreground and rebuilds it on
//     return — no audio runs, and no half-open socket lingers.
//   * Underrun/overrun: entirely the jitter buffer's job (audio-jitter.ts); we
//     just act on its play/conceal/wait verdict each tick.
//   * Teardown: closing the effect closes the socket, clears the timer, and
//     tells the sink to suspend — clean on mute, disconnect, or unmount.
//
// SMOKE TEST (needs a device + a running BELAY_WEBRTC host — both offline in
// this env): confirm sound actually leaves the speaker, and that it plays when
// the phone's ringer switch is on silent. WKWebView media typically uses the
// Playback session category (audible in silent mode), but that is not something
// this repo can assert without hardware. If it is silent-mode-muted, the follow
// up is a tiny native audio-session set (or adding expo-audio only to call
// setAudioModeAsync) — noted, not done, because it needs a build this env can't
// run.

import React, { useEffect, useRef } from 'react';
import { AppState, Platform } from 'react-native';
import { WebView } from 'react-native-webview';
import type { WebView as WebViewType } from 'react-native-webview';

import { wsUrl, UnauthorizedError } from '../api';
import { AUDIO_FRAME_MS } from './webrtc/audio-frames';
import { AudioReceiver } from './webrtc/audio-stream';
import { instructionFor } from './audio-output';
import { AUDIO_PLAYER_HTML } from './audio-player-html';

const SOCKET_OPEN = 1;

export interface HostAudioProps {
  /** Play host audio. Default-off, opt-in: the parent passes true only while
   *  the user has toggled audio AND the screen tab is focused + connected. */
  readonly enabled: boolean;
  /** True once a computer is paired; the ws ticket is fetched against it. */
  readonly connected: boolean;
}

/**
 * Mounts the hidden Web Audio sink and, while `enabled`, streams /ws/audio into
 * it. Renders nothing visible. Native-only: on web (react-native-web) audio
 * playback is out of scope, so it no-ops rather than fighting iframe autoplay.
 */
export function HostAudio({ enabled, connected }: HostAudioProps) {
  const webRef = useRef<WebViewType | null>(null);
  // Foreground state as its own ref+trigger so backgrounding tears the pipeline
  // down without the parent knowing about AppState.
  const foregroundRef = useRef(AppState.currentState === 'active');
  const [foreground, setForeground] = React.useState(foregroundRef.current);
  // Track whether the WebView has loaded and __belayAudio is available
  const loadedRef = useRef(false);
  // Defer start() until the WebView signals ready
  const pendingStartRef = useRef(false);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      const isForeground = next === 'active';
      foregroundRef.current = isForeground;
      setForeground(isForeground);
    });
    return () => sub.remove();
  }, []);

  // Fire-and-forget a snippet into the sink. Guarded so a not-yet-loaded page
  // (the global appears only after the document script runs) is a no-op, never
  // a thrown bridge error.
  const inject = (body: string): void => {
    const web = webRef.current;
    if (!web || !loadedRef.current) return;
    web.injectJavaScript(`window.__belayAudio&&${body};true;`);
  };

  // Called once the WebView has loaded and __belayAudio is available
  const onWebViewLoad = (): void => {
    loadedRef.current = true;
    // If audio was already toggled on, start now
    if (pendingStartRef.current) {
      pendingStartRef.current = false;
      inject('__belayAudio.start()');
    }
  };

  const active = enabled && connected && foreground && Platform.OS !== 'web';

  useEffect(() => {
    if (!active) {
      // Audio disabled: mark no pending start
      pendingStartRef.current = false;
      loadedRef.current = false;
      return;
    }

    let disposed = false;
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    // A fresh receiver per run: a new socket is a new stream, and the jitter
    // buffer's reset heuristic keys off seq bases within one receiver's life.
    const receiver = new AudioReceiver();

    // Resume the audio context off the user's toggle gesture. If the WebView
    // is loaded, start now; otherwise defer until onLoad.
    if (loadedRef.current) {
      inject('__belayAudio.start()');
    } else {
      pendingStartRef.current = true;
    }

    const open = async (): Promise<void> => {
      let url: string;
      try {
        url = await wsUrl('/ws/audio');
      } catch (e: unknown) {
        // Unauthorized is terminal (unpaired); any other failure just means no
        // audio this run. Either way, stay silent rather than crash — audio is
        // an opt-in extra, never a reason to break the screen tab.
        if (e instanceof UnauthorizedError) return;
        return;
      }
      if (disposed) return;

      const ws = new WebSocket(url);
      // Binary wire frames (audio-frames.ts); arraybuffer so `event.data` is an
      // ArrayBuffer we can wrap directly, not a Blob needing async reads.
      ws.binaryType = 'arraybuffer';
      socket = ws;

      ws.onmessage = (event: { data: unknown }): void => {
        // Everything off the wire is untrusted. onWireBytes never throws on a
        // malformed frame (the framing tests pin that), but the ArrayBuffer
        // wrap is still guarded — a text control frame (e.g. an error JSON) is
        // not an ArrayBuffer and must not blow up the handler.
        try {
          if (!(event.data instanceof ArrayBuffer)) return;
          receiver.onWireBytes(new Uint8Array(event.data), Date.now());
        } catch {
          /* drop the frame, keep the stream alive */
        }
      };
      // A dead/failed socket just means silence; the parent's enable gate and
      // the screen tab's own reconnect own recovery. No retry storm here.
      ws.onerror = () => {};
      ws.onclose = () => {
        if (socket === ws) socket = null;
      };
    };

    void open();

    // The playout clock. Every AUDIO_FRAME_MS we ask the jitter buffer what to
    // do and forward exactly that one verdict to the sink.
    timer = setInterval(() => {
      const instruction = instructionFor(receiver.tick());
      if (instruction.kind === 'play') {
        inject(`__belayAudio.enqueue(${JSON.stringify(instruction.floatB64)})`);
      } else if (instruction.kind === 'silence') {
        inject('__belayAudio.silence()');
      }
      // 'idle': prebuffering or stream over — emit nothing.
    }, AUDIO_FRAME_MS);

    return () => {
      disposed = true;
      if (timer) clearInterval(timer);
      if (socket && socket.readyState <= SOCKET_OPEN) {
        try {
          socket.close();
        } catch {
          /* already closing */
        }
      }
      socket = null;
      // Suspend the context so no scheduled tail keeps playing after mute.
      inject('__belayAudio.stop()');
    };
  }, [active]);

  // Web: no sink. Also lets react-native-web builds skip the WebView entirely.
  if (Platform.OS === 'web') return null;

  // The sink must stay mounted (a WKWebView must be in the tree to play), but
  // it is invisible and untouchable. Rendered only while enabled+connected so
  // there is no idle WebView when audio is off.
  if (!enabled || !connected) return null;

  return (
    <WebView
      ref={webRef}
      testID="host-audio-sink"
      source={{ html: AUDIO_PLAYER_HTML }}
      // Web Audio needs JS; the document is our own static string, no network.
      javaScriptEnabled
      // Let the context play without a per-media user gesture inside the page —
      // the app-level toggle is the gesture, and start() resumes the context.
      mediaPlaybackRequiresUserAction={false}
      allowsInlineMediaPlayback
      // onLoad: the document has parsed and __belayAudio is available
      onLoad={onWebViewLoad}
      // onMessage is what turns on the RN↔page bridge injectJavaScript rides;
      // the page only posts diagnostic log lines, which carry no control data
      // and are intentionally ignored here.
      onMessage={() => {}}
      // Fully hidden and inert: 1x1, transparent, no touches.
      style={{ pointerEvents: 'none', position: 'absolute', width: 1, height: 1, opacity: 0 }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    />
  );
}
