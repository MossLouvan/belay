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
//   * Audio session / route: the page requests the playback session so iPhone
//     Silent mode does not mute host sound. The WebView permits autoplay;
//     an app-level tap is not a DOM user gesture inside a different process.
//   * Backgrounding: an AppState listener suspends the whole pipeline (socket,
//     timer, context) when the app leaves the foreground and rebuilds it on
//     return — no audio runs, and no half-open socket lingers.
//   * Underrun/overrun: entirely the jitter buffer's job (audio-jitter.ts); we
//     just act on its play/conceal/wait verdict each tick.
//   * Teardown: closing the effect closes the socket, clears the timer, and
//     tells the sink to suspend — clean on mute, disconnect, or unmount.
//
// Device check: listen with iPhone Silent mode on and off, then background and
// foreground the app. Audio uses /ws/audio in the default host build.

import React, { useEffect, useRef } from 'react';
import { AppState, Platform } from 'react-native';
import { WebView } from 'react-native-webview';
import type { WebView as WebViewType } from 'react-native-webview';

import { probeAudioSupport, wsUrl, UnauthorizedError } from '../api';
import { audioSupportFrom } from './audio-capability';
import { AUDIO_FRAME_MS } from './webrtc/audio-frames';
import { AudioReceiver } from './webrtc/audio-stream';
import { instructionFor } from './audio-output';
import { AUDIO_PLAYER_HTML } from './audio-player-html';
import { shouldMountAudioSink } from './audio-sink-policy';
import { connectHostAudio, type HostAudioStatus } from './audio-connection';
export type { HostAudioStatus } from './audio-connection';

export interface HostAudioProps {
  /** Play host audio. Default-off, opt-in: the parent passes true only while
   *  the user has toggled audio AND the screen tab is focused + connected. */
  readonly enabled: boolean;
  /** True once a computer is paired; the ws ticket is fetched against it. */
  readonly connected: boolean;
  /** Report actual playback/connection state rather than treating the toggle
   *  itself as evidence that audio is reaching the speaker. */
  readonly onStatus?: (status: HostAudioStatus) => void;
}

/**
 * Mounts the hidden Web Audio sink and, while `enabled`, streams /ws/audio into
 * it. Renders nothing visible. Native-only: on web (react-native-web) audio
 * playback is out of scope, so it no-ops rather than fighting iframe autoplay.
 */
export function HostAudio({ enabled, connected, onStatus }: HostAudioProps) {
  const webRef = useRef<WebViewType | null>(null);
  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;
  // Foreground state as its own ref+trigger so backgrounding tears the pipeline
  // down without the parent knowing about AppState.
  const foregroundRef = useRef(AppState.currentState === 'active');
  const [foreground, setForeground] = React.useState(foregroundRef.current);
  // Track whether the WebView has loaded and __belayAudio is available
  const loadedRef = useRef(false);
  // Defer start() until the WebView signals ready
  const pendingStartRef = useRef(false);
  const active = enabled && connected && foreground && Platform.OS !== 'web';
  const activeRef = useRef(active);
  activeRef.current = active;

  const report = (status: HostAudioStatus): void => {
    if (status.phase === 'error') console.warn('[audio]', status.message);
    statusRef.current?.(status);
  };

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

  useEffect(() => {
    if (!active) {
      report({ phase: 'off' });
      // Audio disabled: mark no pending start
      pendingStartRef.current = false;
      // The sink now stays mounted while connected, so keep its ready state
      // across mute/unmute. A disconnect unmounts it and must reset readiness
      // before a later host session creates a fresh WebView.
      if (!connected) loadedRef.current = false;
      return;
    }

    let timer: ReturnType<typeof setInterval> | undefined;
    // A fresh receiver per run: a new socket is a new stream, and the jitter
    // buffer's reset heuristic keys off seq bases within one receiver's life.
    let receiver = new AudioReceiver();

    // The WebView explicitly permits autoplay. If it is not ready, defer start.
    if (loadedRef.current) {
      inject('__belayAudio.start()');
    } else {
      pendingStartRef.current = true;
    }

    const disconnectAudio = connectHostAudio({
      // Ask before dialling: a host too old to have /ws/audio must say so once,
      // not reconnect forever behind "connection lost".
      probeSupport: async () => audioSupportFrom(await probeAudioSupport()),
      getUrl: () => wsUrl('/ws/audio'),
      createSocket: (url) => new WebSocket(url),
      isUnauthorized: (error) => error instanceof UnauthorizedError,
      onReset: () => {
        receiver = new AudioReceiver();
        // Re-arm the sink's first-frame notification after reconnecting.
        inject('__belayAudio.start()');
      },
      onBytes: (bytes) => { receiver.onWireBytes(bytes, Date.now()); },
      onStatus: report,
    });

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
      pendingStartRef.current = false;
      if (timer) clearInterval(timer);
      disconnectAudio();
      // Suspend the context so no scheduled tail keeps playing after mute.
      inject('__belayAudio.stop()');
    };
  }, [active, connected]);

  // Keep the native view mounted for the whole connected session. Mounting it
  // in response to the audio toggle changes the screen's native view hierarchy
  // and can shift the desktop UI on iOS. The `active` effect above still owns
  // all expensive work, so disabled audio has no socket, timer, or live context.
  // Web has no sink; disconnected screens do not need to preload one.
  if (!shouldMountAudioSink(Platform.OS, connected)) return null;

  return (
    <WebView
      ref={webRef}
      testID="host-audio-sink"
      source={{ html: AUDIO_PLAYER_HTML }}
      // Web Audio needs JS; the document is our own static string, no network.
      javaScriptEnabled
      // The app-level toggle is not a DOM gesture inside this WebView.
      mediaPlaybackRequiresUserAction={false}
      allowsInlineMediaPlayback
      onLoadStart={() => {
        loadedRef.current = false;
        pendingStartRef.current = activeRef.current;
      }}
      // onLoad: the document has parsed and __belayAudio is available
      onLoad={onWebViewLoad}
      onMessage={({ nativeEvent }) => {
        try {
          const message: unknown = JSON.parse(nativeEvent.data);
          if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'audio'
            || !('phase' in message)) return;
          if (message.phase === 'ready') onWebViewLoad();
          if (!activeRef.current) return;
          if (message.phase === 'playing') report({ phase: 'playing' });
          if (message.phase === 'error') {
            report({ phase: 'error', message: 'message' in message && typeof message.message === 'string'
              ? message.message : 'Could not play system audio.' });
          }
        } catch { /* Ignore malformed diagnostics from the page. */ }
      }}
      onError={() => {
        if (activeRef.current) report({ phase: 'error', message: 'Could not load the system audio player.' });
      }}
      onContentProcessDidTerminate={() => {
        loadedRef.current = false;
        pendingStartRef.current = activeRef.current;
        webRef.current?.reload();
      }}
      // react-native-webview wraps the native view in a flex:1 container. The
      // wrapper must be absolute too or this hidden sink still reserves the
      // desktop's remaining height and pushes the visible UI down.
      containerStyle={{ pointerEvents: 'none', position: 'absolute', top: 0, left: 0, width: 1, height: 1, flex: 0, opacity: 0 }}
      // Fully hidden and inert. Explicit offsets avoid Yoga's static-position
      // fallback for an absolutely positioned child with no edge specified.
      style={{ pointerEvents: 'none', position: 'absolute', top: 0, left: 0, width: 1, height: 1, opacity: 0 }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    />
  );
}
