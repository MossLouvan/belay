// Hold-to-talk voice input.
//
// Records 16 kHz mono WAV on the phone (so the host can feed it straight to
// whisper.cpp — no ffmpeg anywhere) and uploads the raw bytes to a host
// endpoint: `/transcribe` returns text for the caller to use, `/dictate`
// additionally types it into whatever is focused on the PC.
//
// iOS only for now: Android's recorder can't produce WAV, and the web build
// (used by the Playwright suite) has no business touching the mic.

import React, { useCallback, useRef, useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import {
  AudioModule,
  AudioQuality,
  IOSOutputFormat,
  RecordingOptions,
  setAudioModeAsync,
  useAudioRecorder,
} from 'expo-audio';
import { transcribeAudio, TranscribeEndpoint } from '../api';
import { useTheme } from '../theme';
import { haptic, Dot } from '../ui';
import { MIN_HOLD_MS } from './model';

const WAV_16K_MONO: RecordingOptions = {
  extension: '.wav',
  sampleRate: 16000,
  numberOfChannels: 1,
  bitRate: 256000,
  android: {
    // Android cannot record WAV; the mic is hidden there (see voiceSupported).
    outputFormat: 'default',
    audioEncoder: 'default',
  },
  ios: {
    outputFormat: IOSOutputFormat.LINEARPCM,
    audioQuality: AudioQuality.HIGH,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: {},
};

export const voiceSupported = Platform.OS === 'ios';

export type VoiceState = 'idle' | 'recording' | 'sending';

export interface Voice {
  readonly state: VoiceState;
  readonly start: () => void;
  readonly stop: () => void;
}

/**
 * Drives one recorder. `onText` receives the transcript; `onError` receives a
 * one-line reason when anything in the chain (permission, recorder, upload,
 * whisper) fails.
 */
export function useVoice(
  endpoint: TranscribeEndpoint,
  onText: (text: string) => void,
  onError?: (message: string) => void,
): Voice {
  const recorder = useAudioRecorder(WAV_16K_MONO);
  const [state, setState] = useState<VoiceState>('idle');
  const stateRef = useRef<VoiceState>('idle');
  const startedAt = useRef(0);

  const set = useCallback((next: VoiceState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const start = useCallback(async () => {
    if (!voiceSupported || stateRef.current !== 'idle') return;
    try {
      const perm = await AudioModule.requestRecordingPermissionsAsync();
      if (!perm.granted) { onError?.('microphone permission denied'); return; }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      startedAt.current = Date.now();
      haptic('light');
      set('recording');
    } catch (e: unknown) {
      onError?.(e instanceof Error && e.message ? e.message : 'could not start recording');
      set('idle');
    }
  }, [onError, recorder, set]);

  const stop = useCallback(async () => {
    if (stateRef.current !== 'recording') return;
    set('sending');
    try {
      await recorder.stop();
      // A tap shorter than this is almost certainly accidental.
      if (Date.now() - startedAt.current < MIN_HOLD_MS || !recorder.uri) { set('idle'); return; }
      const { text } = await transcribeAudio(recorder.uri, endpoint);
      if (text) {
        haptic('success');
        onText(text);
      }
    } catch (e: unknown) {
      onError?.(e instanceof Error && e.message ? e.message : 'transcription failed');
    } finally {
      set('idle');
    }
  }, [endpoint, onError, onText, recorder, set]);

  return { state, start, stop };
}

/** Hold-to-talk button. Accent fill while recording, dimmed while uploading. */
export function MicButton({
  state,
  onPressIn,
  onPressOut,
  size = 46,
  disabled,
  testID,
}: {
  state: VoiceState;
  onPressIn: () => void;
  onPressOut: () => void;
  size?: number;
  disabled?: boolean;
  testID?: string;
}) {
  const theme = useTheme();
  if (!voiceSupported) return null;
  const live = state === 'recording';
  const ink = live ? theme.colors.onAccent : theme.colors.textDim;
  return (
    <Pressable
      testID={testID}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel="Hold to talk"
      accessibilityHint="Records while held; the transcript is added to the prompt"
      accessibilityState={{ disabled: Boolean(disabled), busy: state === 'sending' }}
      hitSlop={theme.layout.hitSlop}
      style={({ pressed }) => ({
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: live ? theme.colors.accent : theme.colors.surfaceAlt,
        borderWidth: 2,
        borderColor: live ? theme.colors.accent : pressed ? theme.colors.accent : theme.colors.borderStrong,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.45 : state === 'sending' ? 0.6 : 1,
      })}
    >
      {/* A mic glyph drawn from views — this app carries no icon font. */}
      <View accessibilityElementsHidden style={{ alignItems: 'center' }}>
        <View style={{ width: size * 0.22, height: size * 0.34, borderRadius: size * 0.11, backgroundColor: ink }} />
        <View
          style={{
            width: size * 0.36,
            height: size * 0.12,
            borderBottomLeftRadius: size * 0.18,
            borderBottomRightRadius: size * 0.18,
            borderWidth: 2,
            borderTopWidth: 0,
            borderColor: ink,
            marginTop: 1,
          }}
        />
      </View>
      {state === 'sending' ? (
        <View style={{ position: 'absolute', bottom: 3 }}>
          <Dot status="accent" size={5} pulse />
        </View>
      ) : null}
    </Pressable>
  );
}
