// Hold-to-talk voice input, recognized on the phone.
//
// Speech-to-text runs in iOS's own Speech framework via expo-speech-recognition:
// no audio leaves the device, nothing to install on the host, and interim text
// streams into the composer while the user is still speaking. (This replaced a
// record-WAV-and-upload path that transcribed on the host with whisper.cpp —
// a whole binary download for something the phone does better locally.)
//
// iOS only for now: Android recognizers vary too much per vendor to promise
// hold-to-talk behaves, and the web build (used by the Playwright suite) has
// no business touching the mic.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Linking, Platform, Pressable, Text, View } from 'react-native';
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from 'expo-speech-recognition';
import { useTheme } from '../theme';
import { haptic, Dot } from '../ui';
import { MIN_HOLD_MS } from './model';
import {
  NO_SPEECH_MESSAGE,
  RECOGNIZER_UNAVAILABLE_MESSAGE,
  VOICE_IDLE,
  permissionProblem,
  reduceVoice,
  voiceErrorMessage,
} from './mic-state';
import type { VoiceAction, VoicePhase } from './mic-state';

export const voiceSupported = Platform.OS === 'ios';

export interface Voice {
  readonly state: VoicePhase;
  readonly start: () => void;
  readonly stop: () => void;
  /**
   * The last failure was a permission denial — the fix lives in the Settings
   * app, so the UI should offer that door rather than just an error line.
   */
  readonly needsSettings: boolean;
}

/** The one route iOS offers out of a denied permission. */
export function openVoiceSettings(): void {
  void Linking.openSettings();
}

/**
 * Drives one recognizer. `onTranscript` receives the utterance's live text —
 * called on every interim result and again with the final text, always the
 * whole utterance so far (never a delta), so the caller can simply replace
 * what it wrote last time. `onError` receives a one-line reason when any part
 * of the chain (permission, recognizer, no speech) fails.
 */
export function useVoice(
  onTranscript: (text: string) => void,
  onError?: (message: string) => void,
): Voice {
  const [machine, setMachine] = useState(VOICE_IDLE);
  // The ref is the machine's source of truth and advances *synchronously* —
  // useReducer would leave the ref one render behind, and the press/release
  // race decisions below cannot wait a frame. State just mirrors it for the UI.
  const machineRef = useRef(machine);
  const dispatch = useCallback((action: VoiceAction) => {
    machineRef.current = reduceVoice(machineRef.current, action);
    setMachine(machineRef.current);
  }, []);
  // A function, not a property read: TypeScript would otherwise carry a stale
  // narrowing of `machineRef.current.phase` across the dispatches that change it.
  const phaseNow = useCallback((): VoicePhase => machineRef.current.phase, []);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const startedAt = useRef(0);
  const [needsSettings, setNeedsSettings] = useState(false);

  useSpeechRecognitionEvent('start', () => dispatch({ type: 'started' }));

  useSpeechRecognitionEvent('result', (ev) => {
    if (phaseNow() === 'idle') return;
    const text = ev.results[0]?.transcript ?? '';
    dispatch({ type: 'result', transcript: text });
    if (text) onTranscriptRef.current(text);
    // The success haptic marks the *final* text landing, which usually
    // arrives after the finger has already lifted.
    if (ev.isFinal && text.trim()) haptic('success');
  });

  useSpeechRecognitionEvent('error', (ev) => {
    if (phaseNow() === 'idle') return;
    const message = voiceErrorMessage(ev.error, ev.message);
    if (message) {
      if (ev.error === 'not-allowed') setNeedsSettings(true);
      onErrorRef.current?.(message);
    }
    dispatch({ type: 'error' });
  });

  useSpeechRecognitionEvent('end', () => {
    const m = machineRef.current;
    // A clean stop that heard nothing is worth saying out loud — a button
    // that silently does nothing reads as broken. Errors already spoke.
    if (m.phase === 'stopping' && !m.heard && !m.failed) onErrorRef.current?.(NO_SPEECH_MESSAGE);
    dispatch({ type: 'ended' });
  });

  const start = useCallback(async () => {
    if (!voiceSupported || phaseNow() !== 'idle') return;
    dispatch({ type: 'press' });
    try {
      // Two separate iOS permissions, asked here — the moment of first use —
      // and asked one at a time so a denial can be named precisely.
      const mic = await ExpoSpeechRecognitionModule.requestMicrophonePermissionsAsync();
      const speech = mic.granted
        ? await ExpoSpeechRecognitionModule.requestSpeechRecognizerPermissionsAsync()
        : null;
      const problem = permissionProblem(mic, speech);
      if (problem) {
        setNeedsSettings(true);
        onErrorRef.current?.(problem);
        dispatch({ type: 'cancel' });
        return;
      }
      setNeedsSettings(false);
      // The system permission dialog steals the press: the finger has lifted
      // by the time the user answers it. If the release (or anything else)
      // moved the machine on while we awaited, do not start a ghost session.
      if (phaseNow() !== 'starting') {
        dispatch({ type: 'cancel' });
        return;
      }
      if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) {
        onErrorRef.current?.(RECOGNIZER_UNAVAILABLE_MESSAGE);
        dispatch({ type: 'cancel' });
        return;
      }
      ExpoSpeechRecognitionModule.start({
        interimResults: true,
        // The finger decides when the utterance is over, not a pause — a
        // thinking gap mid-sentence must not end the session.
        continuous: true,
        addsPunctuation: true,
        // Recognize on the phone whenever this hardware/locale can (private,
        // works offline); otherwise fall back to Apple's server recognizer
        // rather than refusing to work at all.
        requiresOnDeviceRecognition: ExpoSpeechRecognitionModule.supportsOnDeviceRecognition(),
      });
      startedAt.current = Date.now();
      haptic('light');
    } catch (e: unknown) {
      onErrorRef.current?.(e instanceof Error && e.message ? e.message : 'could not start listening');
      dispatch({ type: 'cancel' });
    }
  }, []);

  const stop = useCallback(() => {
    const m = machineRef.current;
    if (phaseNow() === 'starting') {
      // Released before the recognizer ever spun up (usually the permission
      // dialog took the press). Nothing was heard; nothing to keep.
      ExpoSpeechRecognitionModule.abort();
      dispatch({ type: 'cancel' });
      return;
    }
    if (phaseNow() !== 'listening') return;
    if (Date.now() - startedAt.current < MIN_HOLD_MS && !m.heard) {
      // A tap shorter than this is almost certainly accidental.
      ExpoSpeechRecognitionModule.abort();
      dispatch({ type: 'cancel' });
      return;
    }
    dispatch({ type: 'release' });
    // stop() (not abort) lets iOS deliver the utterance's final text first.
    ExpoSpeechRecognitionModule.stop();
  }, []);

  // An unmount mid-utterance (backing out of the session) must not leave the
  // recognizer holding the microphone.
  useEffect(() => {
    return () => {
      if (machineRef.current.phase !== 'idle') ExpoSpeechRecognitionModule.abort();
    };
    // machineRef is stable; this runs only at unmount.
  }, []);

  return { state: machine.phase, start, stop, needsSettings };
}

/**
 * VoiceOver users cannot reliably press-and-hold, so with a screen reader on
 * the button becomes tap-to-start / tap-to-stop instead — same machine, a
 * deliberate tap at each end instead of one continuous hold.
 */
function useScreenReader(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    AccessibilityInfo.isScreenReaderEnabled()
      .then((v) => { if (live) setOn(v); })
      .catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener('screenReaderChanged', setOn);
    return () => { live = false; sub.remove(); };
  }, []);
  return on;
}

/**
 * Hold-to-talk button. A square, labelled control — a mic is not one of the
 * universal five glyphs allowed to stand bare (docs/DESIGN.md §11.1), so the
 * glyph carries its mono label. Accent fill while listening, dimmed while the
 * final text settles.
 */
export function MicButton({
  state,
  onStart,
  onStop,
  size = 48,
  disabled,
  testID,
}: {
  state: VoicePhase;
  onStart: () => void;
  onStop: () => void;
  size?: number;
  disabled?: boolean;
  testID?: string;
}) {
  const theme = useTheme();
  const screenReader = useScreenReader();
  if (!voiceSupported) return null;
  const live = state === 'listening' || state === 'starting';
  const ink = live ? theme.colors.onAccent : theme.colors.textDim;
  const glyph = size * 0.7;
  const interaction = screenReader
    ? { onPress: live ? onStop : onStart }
    : { onPressIn: onStart, onPressOut: onStop };
  return (
    <Pressable
      testID={testID}
      {...interaction}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={screenReader ? (live ? 'Stop dictating' : 'Dictate a prompt') : 'Hold to talk'}
      accessibilityHint={
        screenReader
          ? 'Tap to start listening, tap again to finish; the words land in the prompt'
          : 'Listens while held; the words land in the prompt as you speak'
      }
      accessibilityState={{ disabled: Boolean(disabled), busy: state === 'stopping' }}
      hitSlop={theme.layout.hitSlop}
      style={({ pressed }) => ({
        width: size,
        height: size,
        borderRadius: theme.radius.xs,
        backgroundColor: live ? theme.colors.accent : 'transparent',
        borderWidth: theme.layout.hairline,
        borderColor: live || pressed ? theme.colors.focus : theme.colors.borderStrong,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 2,
        opacity: disabled ? 0.45 : state === 'stopping' ? 0.6 : 1,
      })}
    >
      {/* A mic glyph drawn from views — this app carries no icon font. */}
      <View accessibilityElementsHidden style={{ alignItems: 'center' }}>
        <View style={{ width: glyph * 0.22, height: glyph * 0.34, borderRadius: glyph * 0.11, backgroundColor: ink }} />
        <View
          style={{
            width: glyph * 0.36,
            height: glyph * 0.12,
            borderBottomLeftRadius: glyph * 0.18,
            borderBottomRightRadius: glyph * 0.18,
            borderWidth: 2,
            borderTopWidth: 0,
            borderColor: ink,
            marginTop: 1,
          }}
        />
      </View>
      <Text
        allowFontScaling={false}
        accessibilityElementsHidden
        style={{ ...theme.type.micro, color: ink }}
      >
        talk
      </Text>
      {state === 'stopping' ? (
        <View style={{ position: 'absolute', bottom: 2, right: 2 }}>
          <Dot status="accent" size={5} pulse />
        </View>
      ) : null}
    </Pressable>
  );
}
