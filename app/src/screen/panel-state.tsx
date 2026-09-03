// The machine panel's interior while there is no picture.
//
// This replaces three older pieces at once — the stranded "No picture from the
// host." caption, the red stream-error banner above the stage, and the floating
// permission card — with the one fixed empty/error anatomy of docs/DESIGN.md
// §11.4: STATE NAME, the observed fact (guesses labelled as guesses), one
// accent action that can actually succeed from here, and a proof-of-life line
// so a waiting screen never reads as a crashed one.
//
// Everything here renders ON the true-dark machine surface, in both themes, so
// text and marks take their colours from the ink (dark) palette rather than
// `useTheme()` — the light palette's accent and status colours are tuned for
// paper and fall under WCAG AA on near-black.

import React, { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { getTheme, useTheme } from '../theme';
import { Micro, Txt, haptic } from '../ui';
import { retryPhrase } from './retry';
import type { Phase } from './stream';

/** The two verbs a stateless panel can offer (docs/DESIGN.md §11.3). */
export type PanelAction = 'retry' | 'help';

export interface PanelCopy {
  /** STATE NAME — micro-label, dim for waiting states, `bad` for faults. */
  readonly name: string;
  readonly severity: 'dim' | 'bad';
  /** What is observed to be true, one or two sentences, never a sure-sounding guess. */
  readonly body: string;
  readonly action?: PanelAction;
  readonly actionLabel?: string;
  /** Show the live outage clock ("Still trying · 9m") under the body. */
  readonly countdown: boolean;
  /** Static proof-of-life line when there is no outage clock to show. */
  readonly proof?: string;
}

/**
 * Pure mapping from what we actually know to what the panel says. Different
 * causes get different first lines; the anatomy never changes.
 */
export function panelCopyFor(
  connected: boolean,
  phase: Phase,
  streamError: string | null,
  captureBlocked: boolean,
  captureKnown: boolean,
  hostName: string
): PanelCopy {
  if (!connected) {
    return {
      name: 'Not connected',
      severity: 'dim',
      body: 'This phone is not paired with a computer yet. Pairing starts from the connect screen.',
      countdown: false,
    };
  }
  if (captureBlocked) {
    return {
      name: captureKnown ? 'Screen recording off' : 'Capture blocked',
      severity: 'bad',
      body: captureKnown
        ? 'The Mac reports that Screen Recording permission is not granted, so every frame would be black.'
        : 'The Mac could not capture the display, and the error reads like a macOS privacy refusal.',
      action: 'help',
      actionLabel: 'How to fix',
      countdown: false,
      proof: 'Checked again automatically every 15s',
    };
  }
  if (phase === 'reconnecting') {
    return {
      name: 'Reconnecting',
      severity: 'bad',
      // The observed fact is only that the stream dropped; the sleep/network
      // line is explicitly a guess — a confident wrong diagnosis is worse
      // than an honest one (docs/DESIGN.md §11.4).
      body: streamError ?? 'The stream dropped. This usually means a network blip or the computer going to sleep.',
      action: 'retry',
      actionLabel: 'Retry',
      countdown: true,
    };
  }
  if (phase === 'error' || phase === 'stalled') {
    return {
      name: 'No signal',
      severity: 'bad',
      body: streamError ?? `${hostName} closed the stream without sending a picture.`,
      action: 'retry',
      actionLabel: 'Retry',
      countdown: false,
    };
  }
  return {
    name: 'Connecting',
    severity: 'dim',
    body: `Opening the screen stream from ${hostName}…`,
    countdown: false,
  };
}

/**
 * "STILL TRYING · 9M" — the proof the app is alive. The old line here counted
 * backoff attempts ("RETRYING IN 4S · ATTEMPT 86"), which reads as an app
 * confessing it has blind-retried for ten minutes; the honest, useful fact is
 * how long the outage has lasted. The stream now probes `/health` between
 * backoff ticks and reconnects the instant the host answers, so there is no
 * countdown worth showing either — the phrasing lives in ./retry.ts where the
 * node tests hold it to its word.
 */
function OutageClock({ sinceMs }: { sinceMs: number | null }) {
  const ink = getTheme('dark').colors;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <Micro testID="panel-countdown" style={{ color: ink.onMachineDim }}>
      {retryPhrase(now, sinceMs ?? now)}
    </Micro>
  );
}

export interface PanelStateProps {
  connected: boolean;
  phase: Phase;
  /** When the current outage began (`StreamState.retryingSinceMs`). */
  retryingSinceMs: number | null;
  streamError: string | null;
  captureBlocked: boolean;
  captureKnown: boolean;
  hostName: string;
  onRetry: () => void;
  onHelp: () => void;
  testID?: string;
}

/**
 * The guidance surface filling the empty machine panel — content centred
 * inside it, the one sanctioned centring (docs/DESIGN.md §11.5). Sits over the
 * stage, so it must stay interactive: its own presses are the way forward.
 */
export function PanelState({
  connected,
  phase,
  retryingSinceMs,
  streamError,
  captureBlocked,
  captureKnown,
  hostName,
  onRetry,
  onHelp,
  testID,
}: PanelStateProps) {
  const theme = useTheme();
  const ink = getTheme('dark').colors;
  const copy = panelCopyFor(connected, phase, streamError, captureBlocked, captureKnown, hostName);
  const onAction = copy.action === 'help' ? onHelp : onRetry;

  return (
    <View
      testID={testID}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        alignItems: 'center',
        justifyContent: 'center',
        padding: theme.space.lg,
      }}
    >
      <View style={{ maxWidth: 360, alignItems: 'center', gap: theme.space.sm }}>
        <Txt variant="label" color={copy.severity === 'bad' ? ink.bad : ink.onMachineDim} align="center">
          {copy.name}
        </Txt>
        <Txt variant="body" color={ink.onMachine} align="center">
          {copy.body}
        </Txt>
        {copy.action ? (
          <Pressable
            testID="panel-action"
            accessibilityRole="button"
            accessibilityLabel={copy.actionLabel}
            onPress={() => {
              haptic('medium');
              onAction();
            }}
            style={({ pressed }) => ({
              minHeight: theme.layout.minTouch,
              paddingHorizontal: theme.space.lg,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: theme.radius.xs,
              backgroundColor: ink.accent,
              marginTop: theme.space.xxs,
              opacity: pressed ? theme.motion.pressOpacity : 1,
            })}
          >
            <Txt variant="label" color={ink.onAccent}>
              {copy.actionLabel}
            </Txt>
          </Pressable>
        ) : null}
        {copy.countdown ? (
          <OutageClock sinceMs={retryingSinceMs} />
        ) : copy.proof ? (
          <Micro style={{ color: ink.onMachineDim }}>{copy.proof}</Micro>
        ) : null}
      </View>
    </View>
  );
}
